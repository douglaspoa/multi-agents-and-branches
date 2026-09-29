// Starfork — 21-pull-request
// ---------- Pull Request (GitHub) ----------
const prCache={};
const prLoading={}; // taskId → Promise da carga em voo (1 por vez; o poll não empilha gh)
// gh logado SEM acesso ao repo (outra conta/SSO): vale pro projeto todo — nenhuma tarefa pergunta de novo
// sozinha até o recuo passar (antes: 1 "gh pr view falhou" por poll). O botão "tentar de novo" (force) fura.
let prNoAccess=null; // { until, repo, err }
const PR_RETRY_MS={ access:15*60000, network:2*60000, other:60000 };
function prErrKind(msg){ const m=String(msg||'');
  if(/^GH_NO_ACCESS:|could not resolve to a repository/i.test(m)) return 'access';
  if(/sem resposta do GitHub|timed? ?out|could not resolve host|network|ENOTFOUND|ECONN|offline|unable to access|failed to connect/i.test(m)) return 'network';
  return 'other'; }
async function loadPr(taskId, force){
  if(prCache[taskId]!==undefined && prCache[taskId]!==null && !force) return prCache[taskId];
  if(prLoading[taskId]) return prLoading[taskId];
  if(!force && prNoAccess && Date.now()<prNoAccess.until && prNoAccess.repo===state.repo){
    prCache[taskId]={ exists:false, error:prNoAccess.err, errKind:'access', _at:Date.now() }; return prCache[taskId]; }
  if(prCache[taskId]===undefined) prCache[taskId]=null; // loading (dados velhos, se houver, ficam na tela)
  prLoading[taskId]=(async()=>{
    // quiet: o esperado (sem acesso, sem rede) vira ESTADO na tela; só o inesperado vai pra app_errors
    try{ const r=await invokeQuiet("pr_status",{ taskId }); if(r) r._at=Date.now(); prCache[taskId]=r; if(prNoAccess&&prNoAccess.repo===state.repo) prNoAccess=null; }
    catch(e){
      const err=String(e&&e.message||e), kind=prErrKind(err);
      if(kind==='access') prNoAccess={ until:Date.now()+PR_RETRY_MS.access, repo:state.repo, err };
      else if(kind==='other' && window.logAppError) window.logAppError('invoke:pr_status', e);
      // falha de rede/gh ≠ "não tem PR": com dados anteriores, mantém e avisa; sem dados, vira erro explícito
      const prev=prCache[taskId];
      prCache[taskId]=(prev&&prev.exists) ? Object.assign({}, prev, { staleErr:err, errKind:kind, _at:Date.now() }) : { exists:false, error:err, errKind:kind, _at:Date.now() };
    }
    finally{ delete prLoading[taskId]; }
    return prCache[taskId];
  })();
  return prLoading[taskId];
}
// dados do PR com mais de 60s → a tela que mostra o PR busca de novo sozinha
// com erro, recua conforme o tipo (sem acesso: 15 min; sem rede: 2 min) — o poll não martela o gh
function prIsStale(taskId){ const i=prCache[taskId]; const wait=(i&&i.errKind&&PR_RETRY_MS[i.errKind])||60000; return !!(i && i._at && Date.now()-i._at>wait && !prLoading[taskId]); }
function prAgoTx(at){ if(!at) return ''; const s=Math.max(0,(Date.now()-at)/1000); return s<15?'atualizado agora':s<60?`atualizado há ${Math.round(s)}s`:s<3600?`atualizado há ${Math.round(s/60)} min`:`atualizado há ${Math.round(s/3600)}h`; }
// re-pinta quem estiver mostrando o PR desta tarefa (a aba da tarefa)
function prRerender(taskId){
  try{ if(typeof fwTask!=='undefined' && fwTask===taskId && typeof renderWorkspace==='function') renderWorkspace(); }catch(e){ console.error('prRerender ws', e); }
}
// ---- selos do PR (mesma cara no painel lateral e na página do PR) ----
function prStateBadge(info){
  if(!info) return '';
  if(info.isDraft && info.state==='OPEN') return '<span class="prbadge" title="PR em rascunho no GitHub">rascunho</span>';
  const st=String(info.state||'').toUpperCase();
  const M={ OPEN:['aberto','open'], MERGED:['mergeado','ok'], CLOSED:['fechado','bad'] };
  const m=M[st]; return m?`<span class="prbadge ${m[1]}">${m[0]}</span>`:(st?`<span class="prbadge">${esc(st.toLowerCase())}</span>`:'');
}
function prDecisionBadge(info){
  const dec=(info&&info.decision)||'';
  return dec==='APPROVED'?'<span class="prbadge ok">✓ aprovado</span>' : dec==='CHANGES_REQUESTED'?'<span class="prbadge chg">mudanças pedidas</span>' : dec==='REVIEW_REQUIRED'?'<span class="prbadge">aguardando review</span>' : '<span class="prbadge">sem review</span>';
}
function prChecksBadges(info){
  if(!info) return '';
  let h='';
  const tot=info.checksTotal||0, fail=info.checksFail||0, pend=info.checksPending||0;
  if(fail) h+=`<span class="prbadge bad" title="${fail} de ${tot} checagens falharam">${IC.x} checks (${fail})</span>`;
  else if(pend) h+=`<span class="prbadge" title="${pend} de ${tot} checagens ainda rodando">… checks</span>`;
  else if(tot) h+=`<span class="prbadge ok" title="${tot} checagens passaram">✓ checks</span>`;
  if(info.state==='OPEN' && info.mergeable==='CONFLICTING') h+='<span class="prbadge bad" title="a branch conflita com a base">conflito</span>';
  return h;
}
// por que NÃO dá pra mergear agora ('' = pode)
function prMergeBlock(info){
  if(!info || info.state!=='OPEN') return 'o PR não está aberto';
  if(info.isDraft) return 'o PR está em rascunho — marque como pronto no GitHub antes de mergear';
  if(info.mergeable==='CONFLICTING') return 'a branch conflita com a base — resolva o conflito antes de mergear';
  if(info.checksFail) return 'há checagens falhando — corrija antes de mergear';
  return '';
}
// botão de merge: só com o PR ABERTO; bloqueado mostra o motivo (title + linha abaixo)
function prMergeBtnHtml(info, id, extraCls, style){
  if(!info || info.state!=='OPEN') return '';
  const why=prMergeBlock(info);
  return `<button class="btn ${extraCls||''}" id="${id}"${why?` disabled title="${escA(why)}"`:' title="squash + apaga a branch remota"'}${style?` style="${style}"`:''}>${IC.merge} merge PR</button>`;
}
function prMergeWhyHtml(info){ const why=(info&&info.state==='OPEN')?prMergeBlock(info):''; return why?`<div class="prmergewhy">${esc(why)}</div>`:''; }
// ---- comentários: UMA renderização (painel lateral e página do PR) ----
function prCmtKey(c){ const m=String(c.url||'').match(/#issuecomment-(\d+)$/); return String(c.id ?? (m?m[1]:((c.author||'')+':'+(c.body||'').slice(0,40)))); }
// resolvido = resolvido no GitHub, respondido (✔ / resposta sua na thread), desatualizado (o código mudou) ou ignorado aqui
// resumo AUTOMÁTICO de bot na conversa (CodeRabbit "summarize by coderabbit.ai", walkthrough etc.) é
// informativo, não pedido de mudança: vai pros resolvidos (antes contava "1 em aberto" pra sempre)
function prCmtAutoSummary(c){ return !!(c && c.isBot && !prIsReviewCmt(c) && /auto-generated comment|summarize by coderabbit|walkthrough|release notes by coderabbit/i.test(String(c.body||''))); }
function prCmtDone(c, ign){ return !!(c.resolved || c.answered || c.outdated || prCmtAutoSummary(c) || ign.has(prCmtKey(c))); }
function prRoots(info){ return ((info&&info.comments)||[]).filter(c=>!c.inReplyTo); }
function prRevKey(r,i){ return String(r.id||('idx:'+i)); }
// resumos de review com texto: SÓ o "pediu mudanças" que ainda vale (último do autor, PR ainda com mudanças
// pedidas, não ignorado) é pendência; aprovou/comentou/antigo vão pro grupo dos resolvidos
function prRevList(info){ const all=((info&&info.reviews)||[]); return all.map((r,i)=>({ r, key:prRevKey(r,i) })).filter(x=>String(x.r.body||'').trim()); }
function prRevOpen(info, x, ign){ return x.r.state==='CHANGES_REQUESTED' && !x.r.superseded && (info&&info.decision)==='CHANGES_REQUESTED' && !ign.has(x.key); }
function prIsReviewCmt(c){ return !!(c.threadId || c.path); } // inline (thread de review) × conversa do PR
function prCommentsHtml(t, info, opts){
  const compact=!!(opts&&opts.compact);
  const bs=compact?'padding:3px 9px;font-size:10.5px':'padding:4px 10px;font-size:11px';
  const ign=prIgnSet(t.id);
  const roots=prRoots(info);
  const revs=prRevList(info);
  const showDone=lsGet('prShowDone')==='1';
  const openRoots=roots.filter(c=>!prCmtDone(c,ign)), openRevs=revs.filter(x=>prRevOpen(info,x,ign));
  const openN=openRoots.length+openRevs.length, total=roots.length+revs.length, doneN=total-openN;
  const body=(txt, dim)=>{ const s=String(txt||''); const long=s.length>600;
    return `<div class="prcmt-b${long?' clamp':''}"${dim?' style="opacity:.55"':''}>${chatMd(s.slice(0,6000))}</div>${long?'<button class="lnk prmore" data-prmore>ver mais</button>':''}`; };
  const ghLink=u=>u?`<button class="lnk prgh" data-prgh="${escA(u)}" title="abrir no GitHub">GitHub ↗</button>`:'';
  const ignBtn=k=>`<button class="lnk prign" data-prign="${escA(k)}" title="marcar como não-aplicável — vai pros resolvidos">ignorar</button>`;
  // ações: principal(is) à esquerda; ignorar + GitHub juntos à direita (nunca "ignorar" sozinho numa linha)
  const actsRow=(main, sec)=>`<div class="prcmt-acts">${main}<span class="prcmt-sec">${sec}</span></div>`;
  const RV={ CHANGES_REQUESTED:['pediu mudanças','chg'], COMMENTED:['comentou',''], APPROVED:['aprovou','ok'], DISMISSED:['dispensado',''] };
  const revCard=x=>{ const r=x.r, m=RV[r.state]||[String(r.state||'review').toLowerCase(),''], open=prRevOpen(info,x,ign);
    const tag=`<span class="prbadge ${m[1]}">${m[0]}</span>`+(open?'':(ign.has(x.key)?'<span class="prbadge">ignorado</span>':r.superseded?'<span class="prbadge" title="o autor revisou de novo depois">antigo</span>':''));
    const acts=open ? actsRow(`<button class="btn primary sm" data-prfixrev="${escA(x.key)}" data-prtask="${escA(t.id)}" style="${bs}">${IC.ai} aplicar correção</button>`, ignBtn(x.key)+ghLink(r.url))
      : (r.url?actsRow('', ghLink(r.url)):'');
    return `<div class="prcmt prrev${r.isBot?' bot':''}${open?'':' ok'}"><div class="prcmt-h"><span class="prau">${esc(r.author)}${r.isBot?' <span class="botag">bot</span>':''}</span><span class="prloc">review</span>${tag}</div>${body(r.body, !open)}${acts}</div>`; };
  const cmtCard=c=>{
    const done=prCmtDone(c,ign);
    const tag=c.resolved?'<span class="prbadge ok">'+IC.ok+' resolvido</span>' : c.answered?'<span class="prbadge ok">'+IC.ok+' respondido</span>' : c.outdated?'<span class="prbadge" title="o código comentado já mudou">desatualizado</span>' : done?'<span class="prbadge">ignorado</span>' : '';
    const loc=c.path?`<span class="prloc mono" title="${escA(c.path+(c.line?':'+c.line:''))}">${esc(c.path)}${c.line?':'+c.line:''}</span>`:'<span class="prloc">conversa</span>';
    const acts=!done
      ? actsRow(`<button class="btn primary sm" data-prfix="${escA(prCmtKey(c))}" style="${bs}">${IC.ai} aplicar correção</button>${c.threadId?`<button class="btn sm" data-prresolve="${escA(c.threadId)}" data-prtask="${escA(t.id)}" style="${bs}" title="marca a conversa como resolvida no GitHub">resolver</button>`:''}`, ignBtn(prCmtKey(c))+ghLink(c.url))
      : (c.url?actsRow('', ghLink(c.url)):'');
    return `<div class="prcmt${c.isBot?' bot':''}${done?' ok':''}"><div class="prcmt-h"><span class="prau">${esc(c.author)}${c.isBot?' <span class="botag">bot</span>':''}</span>${loc}${tag}</div>${body(c.body, done)}${acts}</div>`;
  };
  // em aberto primeiro; os resolvidos (inclui aprovou/comentou) só com o "mostrar resolvidos"
  const html=openRevs.map(revCard).join('')+openRoots.map(cmtCard).join('')
    +(showDone?revs.filter(x=>!prRevOpen(info,x,ign)).map(revCard).join('')+roots.filter(c=>prCmtDone(c,ign)).map(cmtCard).join(''):'');
  const empty=!total ? `<div class="dim" style="font-size:12px;padding:4px 2px">sem comentários ainda${compact?'':' — o link já está com o time.'}</div>`
    : (!openN&&!showDone) ? '<div class="dim" style="font-size:12px;padding:4px 2px">'+IC.ok+' nenhum comentário em aberto</div>' : '';
  // o alternador fica AO LADO da contagem (quem chama posiciona) — um termo só: "resolvidos"
  const toggle=doneN?`<button class="lnk prshowdone" data-prshowdone data-prtask="${escA(t.id)}">${showDone?'ocultar resolvidos':`mostrar resolvidos (${doneN})`}</button>`:'';
  const countTx=`${openN} em aberto`;
  return { html:html+empty, toggle, countTx, open:openN, total, done:doneN };
}
// delegação: funciona no painel lateral e na página do PR sem depender de quem pintou o HTML
document.addEventListener('click', async e=>{
  const mo=e.target.closest('[data-prmore]'); if(mo){ const b=mo.previousElementSibling; if(b){ const on=b.classList.toggle('clamp'); mo.textContent=on?'ver mais':'ver menos'; } return; }
  const gh=e.target.closest('[data-prgh]'); if(gh){ openExternal(gh.dataset.prgh); return; }
  const sd=e.target.closest('[data-prshowdone]'); if(sd){ lsSet('prShowDone', lsGet('prShowDone')==='1'?'0':'1'); prRerender(sd.dataset.prtask); return; }
  const rs=e.target.closest('[data-prresolve]'); if(rs){ prResolveThread(rs.dataset.prtask, rs.dataset.prresolve, rs); return; }
  const fr=e.target.closest('[data-prfixrev]'); if(fr){ fr.disabled=true; fr.textContent='enviando…'; try{ await prFixReview(fr.dataset.prtask, fr.dataset.prfixrev); }finally{ prRerender(fr.dataset.prtask); } return; }
});
// resolve a thread no GitHub (mutation resolveReviewThread) — some da lista na hora
async function prResolveThread(taskId, threadId, btn){
  if(!taskId||!threadId) return;
  if(btn){ btn.disabled=true; btn.textContent='resolvendo…'; }
  try{
    await invoke('pr_resolve_thread',{ taskId, threadId });
    const i=prCache[taskId]; if(i&&i.comments) i.comments.forEach(c=>{ if(c.threadId===threadId) c.resolved=true; });
    toast('conversa marcada como resolvida no GitHub','ok');
    prRerender(taskId);
    loadPr(taskId,true).then(()=>prRerender(taskId));
  }catch(err){ showErr(err, 'Não consegui resolver no GitHub'); if(btn){ btn.disabled=false; btn.textContent='resolver'; } }
}
function prIgnSet(taskId){ try{ return new Set(JSON.parse(lsGet('prIgn:'+taskId)||'[]')); }catch(_){ return new Set(); } }
function prIgnAdd(taskId,key){ const s=prIgnSet(taskId); s.add(key); lsSet('prIgn:'+taskId, JSON.stringify([...s])); }
// acha o comentário pelo ID (ou chave); aceita o índice antigo (número pequeno) por compatibilidade
function prFindCmt(info, ref){
  const roots=prRoots(info); if(ref==null||ref==='') return null;
  const s=String(ref);
  let c=roots.find(x=>prCmtKey(x)===s);
  if(!c && typeof ref==='number' && Number.isInteger(ref) && ref>=0 && ref<roots.length) c=roots[ref];
  return c||null;
}
// aplicar correção de UM comentário: manda pro agente com o contexto e cobra resposta no thread
async function prFixOne(taskId, ref){
  const info=prCache[taskId]; if(!info) return;
  const c=prFindCmt(info, ref); if(!c){ toast('comentário não encontrado — atualize o PR','warn'); return; }
  const loc=c.path?`${c.path}${c.line?':'+c.line:''}`:'(conversa do PR)';
  const rv=prIsReviewCmt(c) && c.id;
  const idTx=rv?` [comment_id=${c.id}]`:'';
  const msg=`Aplique a correção pedida NESTE comentário do PR #${info.number}${idTx} — ${loc}, de ${c.author}:\n"""\n${(c.body||'').slice(0,1200)}\n"""\nDepois: commit + push, e responda o thread`+(rv?` via gh api (repos/{owner}/{repo}/pulls/${info.number}/comments/${c.id}/replies) começando com "✔" e dizendo o que mudou.`:` com um comentário no PR (gh pr comment ${info.number}) começando com "✔ ${c.url||''}" (o link identifica qual comentário foi resolvido) e dizendo o que mudou.`);
  await fwSendText(taskId, msg);
}
// aplicar o que um REVIEW (resumo) pediu
async function prFixReview(taskId, reviewId){
  const info=prCache[taskId]; if(!info) return;
  const r=((info.reviews||[]).find((x,i)=>prRevKey(x,i)===String(reviewId))); if(!r){ toast('review não encontrado — atualize o PR','warn'); return; }
  const msg=`Aplique as mudanças pedidas NESTE review do PR #${info.number}, de ${r.author}:\n"""\n${String(r.body||'').slice(0,2000)}\n"""\nDepois: commit + push, e responda no PR (gh pr comment ${info.number}) começando com "✔" e dizendo o que mudou.`;
  await fwSendText(taskId, msg);
}
function prBodyOf(t){
  const rev=reviewOf(t.id);
  return `## O quê\n${t.objective||t.title}\n\n`+
    ((t.deliverables||[]).length?`## Entregáveis\n${(t.deliverables||[]).map(d=>'- '+d).join('\n')}\n\n`:'')+
    (rev?`## Resumo\n${(rev.summary||'').slice(0,400)}\n\n## Como testar\n${(rev.howToTest||'').slice(0,600)}\n\n`:'')+
    `_Aberto pelo Starfork._`;
}
// ---- GATE DE VERIFICAÇÃO (FT-5): checagens reais do projeto, rodadas na cópia da tarefa ----
// Config por projeto (Preferências → Checagens; .cardume/checks.json) + detecção (package.json, Cargo, pytest, go).
// Resultado guardado por tarefa + "versão" do código (HEAD + mudanças soltas): o agente mexeu → desatualizada.
// Aprovar só com verificação verde da versão atual; liberar sem isso exige um motivo (vai no PR e fica registrado).
const chkCfg={};   // taskId → { at, data:{ detected, effective, cfg, file } }
const chkFpC={};   // taskId → { at, fp:{ fingerprint, head, dirty } } | { at, err }
const chkLive={};  // taskId → { cur:{id,label}|null, done:[CheckResult] } enquanto roda
const chkLoading={};
function chkJson(k){ try{ return JSON.parse(lsGet(k)||'null'); }catch(_){ return null; } }
function chkResGet(id){ return chkJson('chk:'+id); }
function chkOvGet(id){ return chkJson('chkOv:'+id); }
function chkCfgSig(eff){ return (eff||[]).filter(c=>c.on).map(c=>c.id+'='+c.cmd).join('|'); }
function chkDur(ms){ ms=+ms||0; return ms<1000?ms+' ms':ms<60000?(ms/1000).toFixed(ms<10000?1:0).replace('.',',')+' s':Math.floor(ms/60000)+' min '+String(Math.round(ms%60000/1000)).padStart(2,'0')+' s'; }
async function chkLoadCfg(taskId, force){
  const c=chkCfg[taskId]; if(!force && c && Date.now()-c.at<30000) return c.data;
  const data=await invoke('checks_config',{ taskId }); chkCfg[taskId]={ at:Date.now(), data:data||{ detected:[], effective:[], cfg:{} } }; return chkCfg[taskId].data;
}
async function chkLoadFp(taskId, force){
  // worktree limpa (tarefa mergeada/encerrada) é estado, não falha: não reconsulta a cada 5 s
  const c=chkFpC[taskId]; if(!force && c && Date.now()-c.at<(c.err?60000:5000)) return c;
  try{ chkFpC[taskId]={ at:Date.now(), fp:await invoke('task_fingerprint',{ taskId }) }; }
  catch(e){ chkFpC[taskId]={ at:Date.now(), err:String(e&&e.message||e) }; }
  return chkFpC[taskId];
}
// dispara as leituras em segundo plano e re-renderiza a tela da tarefa quando algo MUDA (sem laço)
function chkRefresh(taskId){
  if(chkLoading[taskId]) return; chkLoading[taskId]=1;
  const before=JSON.stringify(chkGate({ id:taskId }));
  Promise.all([chkLoadCfg(taskId).catch(()=>null), chkLoadFp(taskId)]).finally(()=>{ delete chkLoading[taskId];
    if(JSON.stringify(chkGate({ id:taskId }))!==before) chkRerender(taskId); });
}
function chkRerender(taskId){ try{ if(typeof fwTask!=='undefined' && fwTask===taskId && typeof renderWorkspace==='function') renderWorkspace(); }catch(e){ console.error('chkRerender', e); } }
// estado do gate (síncrono, a partir dos caches): none · loading · running · notrun · stale · fail · pass · override · err
function chkGate(t){
  const c=chkCfg[t.id]; if(!c) return { st:'loading', on:[] };
  const on=(c.data.effective||[]).filter(x=>x.on);
  if(!on.length) return { st:'none', on };
  if(chkLive[t.id]) return { st:'running', on, live:chkLive[t.id] };
  const f=chkFpC[t.id]; if(!f) return { st:'loading', on };
  if(f.err) return { st:'err', on, err:f.err };
  const cur=f.fp.fingerprint, r=chkResGet(t.id), ov=chkOvGet(t.id);
  let g;
  if(!r) g={ st:'notrun', on };
  else if(r.fp!==cur || r.cfgSig!==chkCfgSig(c.data.effective)) g={ st:'stale', on, r };
  else { const bad=(r.results||[]).filter(x=>!x.ok); g=bad.length?{ st:'fail', on, r, bad }:{ st:'pass', on, r }; }
  if(['notrun','stale','fail'].includes(g.st) && ov && ov.fp===cur) return Object.assign(g, { st:'override', was:g.st, ov });
  return g;
}
async function chkEnsure(t, force){ await chkLoadCfg(t.id, force); await chkLoadFp(t.id, force); return chkGate(t); }
function chkCanApprove(g){ return ['none','pass','override'].includes(g.st); }
function chkBlockWhy(g){
  return g.st==='fail' ? `a verificação falhou (${g.bad.map(b=>b.label).join(', ')}) — corrija, ou use "aprovar mesmo assim" com um motivo`
    : g.st==='notrun' ? 'rode a verificação (testes e checagens automáticas) antes de aprovar'
    : g.st==='stale' ? 'o código mudou depois da última verificação — rode de novo pra liberar'
    : g.st==='running' ? 'a verificação está rodando…'
    : g.st==='err' ? (humanErr(g.err).id==='wt-gone' ? humanErr(g.err).msg : 'não deu pra conferir a verificação: '+g.err)
    : g.st==='loading' ? 'conferindo a verificação…' : '';
}
async function chkRun(t){
  if(chkLive[t.id]) return null;
  chkLive[t.id]={ cur:null, done:[] }; chkRerender(t.id);
  try{
    const cfg=await chkLoadCfg(t.id, true);
    const res=await invoke('run_checks',{ taskId:t.id });
    chkResSetRun(t.id, res, cfg);
    const bad=(res.results||[]).filter(x=>!x.ok);
    toast(bad.length?`verificação: ${bad.length} de ${res.results.length} falhou`:`verificação passou ✓ (${res.results.length})`, bad.length?'warn':'ok');
    return res;
  }catch(e){ showErr(e, 'Não deu pra rodar a verificação'); return null; }
  finally{ delete chkLive[t.id]; await chkLoadFp(t.id, true); chkRerender(t.id); }
}
function chkResSetRun(taskId, res, cfg){
  lsSet('chk:'+taskId, JSON.stringify({ fp:res.fingerprint, head:res.head, dirty:res.dirty, at:res.at||Date.now(), cfgSig:chkCfgSig(cfg&&cfg.effective), results:res.results||[] }));
}
async function chkStop(t){ try{ await invoke('run_checks_stop',{ taskId:t.id }); }catch(_){ } }
// progresso ao vivo (evento do Rust): qual checagem está rodando + as que já terminaram
function chkOnProgress(p){
  if(!p||!p.taskId) return; const L=chkLive[p.taskId]; if(!L) return;
  if(p.phase==='start') L.cur={ id:p.id, label:p.label };
  else if(p.result){ L.done.push(p.result); L.cur=null; }
  const d=$id('prep1d'); if(d && prepTaskId===p.taskId && p.phase==='start') d.innerHTML=`rodando <b>${esc(p.label)}</b>… (${L.done.length+1} de ${(chkGate({id:p.taskId}).on||[]).length||'?'})`;
  chkRerender(p.taskId);
}
try{ window.__TAURI__.event.listen('checks-progress', ev=>chkOnProgress(ev&&ev.payload)); }catch(_){ }
// "aprovar mesmo assim": exige motivo — vai pra descrição do PR e fica registrado (local + .cardume/checks-overrides.jsonl)
async function chkOverride(t, g){
  const what=g.st==='fail'?'com a verificação falhando':'sem a verificação da versão atual';
  const reason=await askText('Aprovar mesmo assim', `por que aprovar ${what}? (vai na descrição do PR e fica registrado)`, '');
  if(!reason) return false;
  const f=await chkLoadFp(t.id, true); const fp=(f&&f.fp&&f.fp.fingerprint)||'';
  const failing=g.st==='fail'?(g.bad||[]).map(b=>b.label):[];
  lsSet('chkOv:'+t.id, JSON.stringify({ fp, reason, at:Date.now(), failing, was:g.st }));
  invoke('checks_override_log',{ taskId:t.id, reason, fingerprint:fp, failing }).catch(()=>{});
  return true;
}
// bloco "## Verificação" anexado à descrição do PR (o revisor vê o que rodou de verdade)
function chkPrBodyExtra(t){
  const g=chkGate(t); if(g.st==='none'||g.st==='loading') return '';
  const r=g.r||chkResGet(t.id);
  let s='\n\n## Verificação\n';
  if(r && (g.st==='pass'||g.st==='fail'||(g.st==='override'&&g.was==='fail'))) s+=(r.results||[]).map(x=>`- ${x.ok?'✓':'✕'} ${x.label} — \`${x.cmd}\` · ${chkDur(x.durationMs)}${x.ok?'':x.timedOut?' · passou do tempo-limite':' · exit '+(x.exitCode==null?'?':x.exitCode)}`).join('\n')+'\n_rodadas pelo Starfork na cópia da tarefa_\n';
  else s+='_não rodou na versão final_\n';
  if(g.st==='override') s+=`\nAtenção: aprovado ${g.was==='fail'?'com checagem falhando':'sem verificação'}: ${g.ov.reason}\n`;
  return s;
}
// cabeçalho da tarefa (20): o botão "aprovar e abrir PR" reflete o gate — bloqueado leva pra Verificação na Entrega
function chkDecorateApprove(btn, t){
  if(!btn||!t) return;
  if(typeof entregaNonCode==='function' && entregaNonCode(t)){ btn.innerHTML=`${IC.check} salvar entregáveis`; btn.title='salva os arquivos entregues numa pasta sua e conclui (sem PR)'; return; }
  chkRefresh(t.id);
  const g=chkGate(t); const ok=chkCanApprove(g);
  btn.classList.toggle('is-gated', !ok); btn.setAttribute('aria-disabled', ok?'false':'true');
  if(!ok) btn.title=chkBlockWhy(g)+' · clique pra ver a verificação';
}
function chkApproveClick(t){
  if(typeof entregaNonCode==='function' && entregaNonCode(t)){ fwMode='entrega'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace(); return; }
  const g=chkGate(t);
  if(!chkCanApprove(g)){ toast(chkBlockWhy(g),'warn'); fwMode='entrega'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace();
    setTimeout(()=>{ const v=$id('enVerif'); if(v) v.scrollIntoView({ block:'center', behavior:'smooth' }); }, 60); return; }
  prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main');
}
// ---- "Preparando o PR" (redesign p13): verificação real → push → criar ----
let prepTaskId='';
function prPrepOpen(taskId, base){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  // BUG-17: investigação/design (e entrega só de documentos) não abre PR — o fim é salvar os entregáveis
  if(typeof entregaNonCode==='function' && entregaNonCode(t)){
    toast('esta tarefa entrega documentos, não código — o fim é "salvar entregáveis na pasta"','info');
    if(typeof openWorkspace==='function'){ openWorkspace(t.id); setTimeout(()=>{ try{ fwMode='entrega'; renderWorkspace(); }catch(_){ } }, 50); }
    return;
  }
  prepTaskId=taskId;
  lsSet('prBase:'+taskId, base||'main'); // lembra a base escolhida (antes nunca era salva — a página sempre dizia "main")
  const ov=$id('prepOverlay'); ov.style.display='flex';
  // E4 (bug #5): projeto só local (sem remote) — o push caía em "Could not read from remote" e a tela dizia
  // "sem internet", com "tentar de novo" em loop. Agora diz o que é e oferece publicar no GitHub.
  if(typeof repoHasRemote==='function' && !repoHasRemote()){ prNoRemoteBody(t, base); return; }
  $id('prepBody').innerHTML=`
    <div class="dim" style="font-size:12.5px;margin-bottom:6px">Conferindo a verificação antes de abrir</div>
    <div class="prepstep" id="prep1"><span class="ps run">◌</span><div style="flex:1"><b>Verificação</b> <span class="dim" style="font-size:11px">testes e checagens automáticas</span><div class="dim psd" id="prep1d" style="font-size:11.5px">conferindo…</div></div></div>
    <div class="prepstep" id="prep2"><span class="ps">·</span><div style="flex:1"><b>Commit &amp; push</b><div class="dim psd" id="prep2d" style="font-size:11.5px">aguardando</div></div></div>
    <div class="prepstep" id="prep3"><span class="ps">·</span><div style="flex:1"><b>Abrir o PR</b><div class="dim psd" id="prep3d" style="font-size:11.5px">base <b>${esc(base||'main')}</b></div></div></div>
    <div class="dim" style="font-size:11px;text-align:center;margin-top:12px">isso leva alguns segundos — pode continuar em outra aba</div>
    <div style="display:flex;gap:8px;margin-top:12px"><span style="flex:1"></span><button class="btn" id="prepCancelB">fechar</button><button class="btn" id="prepForce" style="display:none" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar mesmo assim…</button></div>`;
  const close=()=>{ ov.style.display='none'; };
  $id('prepClose').onclick=close;
  $id('prepCancelB').onclick=close;
  prPrepRun(t, base||'main');
}
function prepMark(n, st, txt){ // st: run|ok|fail|skip
  const s=document.querySelector('#prep'+n+' .ps'); if(!s) return;
  s.className='ps '+st; s.textContent= st==='ok'?'✓' : st==='fail'?'✕' : st==='run'?'◌' : '·';
  if(txt!=null){ const d=$id('prep'+n+'d'); if(d) d.innerHTML=txt; }
}
async function prPrepRun(t, base){
  // 1. verificação (FT-5): mesma regra da Entrega — verde na versão atual, ou liberação com motivo
  let g;
  try{ g=await chkEnsure(t, true); }catch(e){ g={ st:'err', err:String(e&&e.message||e) }; }
  if(g.st==='notrun' || g.st==='stale'){
    prepMark(1,'run', g.st==='stale'?'o código mudou desde a última verificação — rodando de novo…':'rodando a verificação na cópia da tarefa…');
    await chkRun(t); g=chkGate(t);
  }
  const resHtml=r=>(r&&r.results||[]).map(x=>`${x.ok?'✓':'✕'} ${esc(x.label)} <span class="dim">${chkDur(x.durationMs)}</span>`).join(' · ');
  if(g.st==='none') prepMark(1,'ok','sem checagens configuradas no projeto — seguindo');
  else if(g.st==='pass') prepMark(1,'ok', resHtml(g.r));
  else if(g.st==='override') prepMark(1,'ok', `<span style="color:var(--warn)">${IC.warn} aprovado ${g.was==='fail'?'com checagem falhando':'sem verificação'}: ${esc(g.ov.reason)}</span>`);
  else {
    const det = g.st==='fail' ? g.bad.map(c=>`<b>${esc(c.label)} falhou</b> <span class="dim">· ${c.timedOut?'passou do tempo-limite':'exit '+(c.exitCode==null?'?':c.exitCode)}</span><div class="mono" style="white-space:pre-wrap;font-size:10.5px;margin-top:4px;color:var(--crit);max-height:120px;overflow:auto">${esc(String(c.log||'').split('\n').slice(-12).join('\n'))}</div>`).join('')
      : esc(chkBlockWhy(g)||'não deu pra conferir a verificação');
    prepMark(1,'fail', det);
    const f=$id('prepForce');
    if(f){ f.style.display=''; f.onclick=async()=>{ if(!await chkOverride(t, g.st==='fail'?g:{ st:'notrun' })) return; f.style.display='none';
      prepMark(1,'ok', `<span style="color:var(--warn)">${IC.warn} aprovado mesmo assim</span>`); prPrepFinish(t, base); }; }
    return; // decisão do humano: corrigir antes ou liberar com motivo
  }
  await prPrepFinish(t, base);
}
// E4: "Preparando o PR" de um projeto que ainda não está no GitHub
function prNoRemoteBody(t, base){
  $id('prepBody').innerHTML=`
    <div class="prepstep" id="prepNoRemote"><span class="ps fail">!</span><div style="flex:1"><b>Este projeto ainda não está no GitHub</b>
      <div class="dim psd" style="font-size:11.5px;margin-top:3px">O PR é aberto no GitHub, então o projeto precisa estar lá primeiro. Publicar cria um repositório <b>privado</b> na sua conta do GitHub e envia o código — o trabalho desta tarefa continua salvo aqui.</div></div></div>
    <div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span><button class="btn" id="prepCancelB">fechar</button><button class="btn primary" id="prepPublish">publicar no GitHub</button></div>`;
  const close=()=>{ $id('prepOverlay').style.display='none'; };
  $id('prepClose').onclick=close; $id('prepCancelB').onclick=close;
  $id('prepPublish').onclick=async(ev)=>{ const b=ev.currentTarget; b.disabled=true; b.textContent='publicando…';
    const ok=await publishGithub(); if(ok) prPrepOpen(t.id, base); else { b.disabled=false; b.textContent='publicar no GitHub'; } };
}
// E4: publica o projeto ativo (só local) no GitHub pela conta ativa do gh. Devolve true se ficou publicado.
async function publishGithub(){
  if(typeof repoHasGit==='function' && !repoHasGit() && !await gitGate()) return false;
  let owners=[]; try{ owners=(await invoke('gh_owners'))||[]; }catch(_){ }
  if(!owners.length){ toast('Conecte sua conta do GitHub primeiro — depois é só publicar.','warn',{ label:'abrir Ambiente', fn:ERR_ACTIONS.env }); return false; }
  const name=pathBase(state.repo)||'projeto';
  if(!await askYes(`Publicar "${name}" no GitHub?\n\nCria o repositório PRIVADO ${owners[0]}/${name} (conta ativa do gh) e envia o código. Depois disso os PRs funcionam normalmente.`)) return false;
  toast('publicando no GitHub…','info');
  try{ const r=await invoke('publish_github',{ private:true, owner:owners[0] }); lastSig=''; await refresh(); toast('Projeto publicado no GitHub ✓'+(r&&/^https?:/.test(r)?' · '+r:''),'ok'); return true; }
  catch(e){ showErr(e, 'Não consegui publicar no GitHub'); return false; }
}
// falha de um passo do PR: mensagem do catálogo (humanErr) + o texto cru pequeno + o botão que resolve.
// Rede = "tentar de novo"; sem remote = "publicar no GitHub" (e aí refaz); login do gh = "abrir Ambiente".
function prFail(n, e, retry, noRetry){
  const h=humanErr(e), raw=errText(e);
  const head=h.id==='generic' ? esc(errFirstLine(raw)) : `<b>${esc(h.msg)}</b>`+(h.id==='network'&&n===2?' <span class="dim">O commit local já foi feito; o botão só re-envia.</span>':'');
  prepMark(n,'fail', head+((h.id==='generic' && raw.trim()===errFirstLine(raw))?'':`<div class="mono" style="font-size:10px;margin-top:4px;color:var(--muted);white-space:pre-wrap">${esc(raw.slice(0,240))}</div>`)
    +(h.action?`<div style="margin-top:8px"><button class="btn primary sm" id="prepFixAct${n}">${esc(h.action.label)}</button></div>`:''));
  const b=$id('prepFixAct'+n);
  if(b) b.onclick=async()=>{ b.disabled=true; let ok=false; try{ ok=await h.action.fn(); }catch(err){ showErr(err); } b.disabled=false; if(h.id==='no-remote' && ok) retry(); };
  if(!noRetry && h.id!=='no-remote') prShowRetry(retry);
  return h;
}
// mostra/atualiza um botão "tentar de novo" no rodapé do modal
function prShowRetry(fn){
  let b=$id('prepRetry');
  if(!b){ const foot=document.querySelector('#prepBody > div:last-child'); const cancel=$id('prepCancelB');
    b=document.createElement('button'); b.id='prepRetry'; b.className='btn primary'; if(foot&&cancel) foot.insertBefore(b, cancel.nextSibling); else if(foot) foot.appendChild(b); }
  b.textContent='↻ tentar de novo'; b.style.display=''; b.onclick=()=>{ b.style.display='none'; fn(); };
}
function prHideRetry(){ const b=$id('prepRetry'); if(b) b.style.display='none'; }
async function prPrepFinish(t, base){
  prHideRetry();
  prepMark(2,'run','commitando e enviando a branch…');
  try{ const msg=await invoke('push_task',{ taskId:t.id }); prepMark(2,'ok', esc(msg)); }
  catch(e){ prFail(2, e, ()=>prPrepFinish(t, base)); return; }
  prepMark(3,'run','escrevendo a descrição do PR (o quê · o que foi feito · como testar)…');
  let prBody;
  try{ prBody=await invoke('pr_body_ai',{ taskId:t.id }); }
  catch(_){ prBody=prBodyOf(t); }
  prBody=String(prBody||prBodyOf(t))+chkPrBodyExtra(t); // verificação real + "Atenção: aprovado com checagem falhando: motivo"
  prepMark(3,'run','criando o PR no GitHub…');
  try{
    const url=await invoke('open_pr',{ taskId:t.id, base, title:t.title, body: prBody });
    prepMark(3,'ok', url?`<button class="btn sm" onclick="openExternal('${escA(url)}')" style="margin-top:4px">${esc(url.replace('https://',''))} ↗</button>`:'PR aberto');
    prHideRetry();
    prCache[t.id]=undefined; await loadPr(t.id,true); lastSig='';
    if(typeof renderWorkspace==='function'&&fwTask===t.id){ fwMode='pr'; renderWorkspace(); }
  }catch(e){ const s=errText(e);
    // gh sem acesso/SSO ao repo (comum em quem não é membro da org ou sem SSO): o
    // push funcionou, então dá pra criar o PR no NAVEGADOR (a sessão do dev tem acesso).
    const ghAccess=/could not resolve to a repository|graphql|sso|not authorized|não enxerga/i.test(s) && humanErr(e).id!=='network';
    prFail(3, e, ()=>prPrepFinish(t, base), true);
    if(ghAccess){
      try{ const cu=await invoke('pr_compare_url',{ taskId:t.id, base }); const d=$id('prep3d');
        if(d&&cu){ d.insertAdjacentHTML('beforeend', `<div style="margin-top:8px"><button class="btn primary sm" data-prweb="${escA(cu)}" title="a branch já foi enviada — abre a página do GitHub pra criar o PR, onde a SUA conta tem acesso à org">criar o PR no navegador ↗</button></div>`);
          const wb=d.querySelector('[data-prweb]'); if(wb) wb.onclick=()=>invoke('open_url',{url:wb.dataset.prweb}).catch(()=>{}); }
      }catch(_){ prShowRetry(()=>prPrepFinish(t, base)); }
    } else if(humanErr(e).id!=='no-remote'){
      // a branch já foi enviada — re-tentar só a criação do PR (ex.: falha de rede)
      prShowRetry(()=>prPrepFinish(t, base));
    }
  }
}
async function openPr(t){
  const base=($id('prBase')||{}).value||'main';
  prPrepOpen(t.id, base);
}
// manda o agente endereçar TODOS os comentários em aberto. Devolve true/false (quem chamou decide se troca de tela).
async function reworkFromPr(taskId, btnEl){
  const btn=btnEl||$id('prRework');
  const orig=btn?btn.innerHTML:'';
  if(btn){ btn.disabled=true; btn.textContent='enviando…'; }
  try{
    // o que você ignorou aqui NÃO vai pro agente (antes a contagem do botão e o envio discordavam)
    await invoke('rework_from_pr',{ taskId, ignored:[...prIgnSet(taskId)] });
    if(btn){ btn.textContent='✓ enviado ao agente'; }
    prCache[taskId]=undefined; lastSig=''; await refresh();
    return true;
  }
  catch(e){ showErr(e, 'Falha ao mandar corrigir'); if(btn){ btn.disabled=false; btn.innerHTML=orig; } return false; }
}
// merge SEMPRE squash (mesmo método em todas as telas do desktop)
async function mergePr(taskId){
  const why=prMergeBlock(prCache[taskId]); if(prCache[taskId] && why){ toast('Não dá pra mergear agora: '+why,'warn'); return false; }
  if(!await askYes('Mergear o PR no GitHub (squash + apaga a branch remota)?')) return false;
  try{ await invoke('merge_pr',{ taskId, method:'squash' }); prCache[taskId]=undefined; lastSig=''; await refresh(); toast('PR mergeado','ok'); return true; }
  catch(e){ showErr(e, 'Merge do PR falhou'); return false; }
}
const ROLE_PT = { planner:"planejamento", builder:"construção", reviewer:"revisão" };

let __selPersisted='';
function render(){
  if(selected && selected!==__selPersisted && state.repo){ __selPersisted=selected; lsSet('sel:'+state.repo, selected); }
  const noRepo = !state.repo;
  const chead=document.querySelector(".chead"); if(chead) chead.style.display = noRepo?"none":"flex";
  $id("emptyRepo").style.display = noRepo ? "flex":"none";
  if(noRepo){
    $id("graphPane").style.display="none";
    $id("feedPane").style.display="none";
    $id("rail").innerHTML='';
    $id("busSummary").innerHTML='<span class="dim">—</span>';
    return;
  }
  const v = (((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v || "flow";
  document.querySelector(".body").classList.toggle("teamfull", v==="team");
  // padrão NOVO em todas as vistas: sem menu antigo, sem painel lateral; a barra
  // de abas (Tudo/Minhas/Do time/Concluídas + ícones) é a mesma em toda página
  document.querySelector(".body").classList.toggle("flowmode", ["flow","kanban","graph","feed"].includes(v));
  if(chead && !noRepo){
    chead.style.display = v==="flow" ? "none" : "flex";
    if(v!=="flow") renderNavTabs(v);
  }
  $id("flowPane").style.display = v==="flow"?"block":"none";
  $id("kanbanPane").style.display = v==="kanban"?"block":"none";
  $id("graphPane").style.display = v==="graph"?"block":"none";
  $id("feedPane").style.display = v==="feed"?"block":"none";
  $id("teamPane").style.display = v==="team"?"block":"none";
  // cada painel isolado: um erro num deles não derruba os outros nem o poll
  safe(renderRail); safe(renderBus);
  // só renderiza o painel central ativo (os outros ficam ocultos)
  if(v==="graph") safe(renderGraph);
  else if(v==="feed") safe(renderFeed);
  else if(v==="kanban") safe(renderKanban);
  else if(v==="team") safe(renderTeamBoard);
  else safe(renderFlow);
}
// executa um render defensivamente — loga o erro em vez de propagar/travar a UI
function safe(fn){ try{ fn(); }catch(e){ console.error("render "+(fn.name||"?")+":", e); } }
function activeIs(x){ return ((((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v)===x; }
const commitsCache={};
// commitsStale: evento novo na tarefa → recarrega MOSTRANDO o valor antigo (antes zerava o cache e o
// card piscava "carregando…" a cada evento); commitsLoading: 1 carga por tarefa (cada render disparava outra)
const commitsStale={}, commitsLoading={};
function commitsNeedLoad(taskId){ return commitsCache[taskId]===undefined || !!commitsStale[taskId]; }
async function loadCommits(taskId, force){
  if(!force && !commitsNeedLoad(taskId)) return commitsCache[taskId];
  if(commitsLoading[taskId]) return commitsLoading[taskId];
  delete commitsStale[taskId];
  commitsLoading[taskId]=(async()=>{
    try{ commitsCache[taskId]=await invoke("task_commits",{taskId}); }catch(e){ if(commitsCache[taskId]===undefined) commitsCache[taskId]=[]; }
    finally{ delete commitsLoading[taskId]; }
    return commitsCache[taskId];
  })();
  return commitsLoading[taskId];
}
async function loadAllCommits(){ for(const t of (state.tasks||[])) await loadCommits(t.id); render(); }
function commitChip(x, agent){
  const av = agent ? `<span class="cav" style="background:${agentColor(agent)}" title="${escA(agent)}">${agentBadge(agent)}</span>` : '';
  return `<button class="fcommit" data-hash="${escA(x.hash)}" title="${escA((agent?agent+' · ':'')+x.subject)}">${av}<span class="chash mono">${esc((x.hash||'').slice(0,7))}</span><span class="csub">${esc(x.subject||'')}</span></button>`;
}
const FLOW_PAL=["#3fd68a","#5b9df9","#b47ce0","#f0b449","#f2685c","#4fc4c9","#e07ab4","#7c8792"];
// Busca o agente no catálogo do projeto (config) POR NOME — é como as tarefas
// referenciam o agente (só o nome fica gravado). Dá acesso a cor + avatar escolhidos no editor.
// R5-5: o catálogo só era lido ao abrir "Nova demanda" — até lá toda cor caía no hash (Lyra coral no chat e roxa em
// Agentes). Agora carrega sozinho (1x por repo) na 1ª consulta e redesenha; salvar o catálogo atualiza state.config.
let agentCatRepo=null;
function agentCatEnsure(){
  const repo=(typeof state!=='undefined'&&state.repo)||'';
  if(agentCatRepo===repo) return; agentCatRepo=repo;
  if(typeof invoke!=='function') return;
  invoke('config').then(c=>{ if(c&&(state.repo||'')===repo){ state.config=c; lastSig=''; try{ if(typeof render==='function') render(); }catch(_){ } } }).catch(()=>{});
}
function agentCat(name){ agentCatEnsure(); try{ return ((state.config&&state.config.agents)||[]).find(a=>String(a.name||'').toLowerCase()===String(name||'').toLowerCase())||null; }catch(_){ return null; } }
function agentColor(name){ const a=agentCat(name); if(a&&a.color) return a.color; let h=0; const s=String(name||""); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return FLOW_PAL[h%FLOW_PAL.length]; }
// Conteúdo do badge do agente: o AVATAR (emoji) escolhido no editor, ou as iniciais.
function agentBadge(name){ const a=agentCat(name); return a&&a.avatar ? a.avatar : esc(String(name||'?').trim().slice(0,2).toUpperCase()); }
function flowTaskCard(t, acc){
  // status EFETIVO (taskSt: pergunta aberta vence 'running', PR aberto = 'pr-open') com nome/cor do STATUS_META
  const st=t.status==='cancelled'?'cancelled':taskSt(t);
  const col=stColor(st);
  const accCls=acc?(' '+acc):'';
  const roles=t.roles||[];
  const pipe = roles.map(r=>`<span class="fstep${r.role===t.stage?' cur':''}"><span class="fav" style="background:${r.role===t.stage?'var(--accent)':agentColor(r.name)}">${agentBadge(r.name)}</span><span class="fnm">${esc(r.name)}</span><span class="frole">${esc(r.role)}</span></span>`).join('<span class="farrow">→</span>');
  const d=diffOf(t.id), rev=reviewOf(t.id), c=commitsCache[t.id];
  const cchips = c===undefined ? '<span class="dim" style="font-size:11px">carregando…</span>'
    : c.length ? c.slice(0,8).map(x=>commitChip(x,t.agent)).join("")+(c.length>8?`<span class="dim" style="font-size:11px;padding:3px 6px">+${c.length-8}</span>`:"")
    : (t.status==='merged'?'<span class="dim" style="font-size:11px">mergeado na '+esc(t.base)+'</span>':'<span class="dim" style="font-size:11px">nenhum commit ainda</span>');
  const live = ACTIVE_ST.has(t.status) && !pendingOf(t.id).length ? (()=>{ const ev=lastEventOf(t.id); return `<div class="flive"><span class="pulse" style="--pc:${col}"></span><span class="lx">${esc(ev?((GLYPH[ev.type]||'·')+' '+ev.text):'iniciando…')}</span></div>`; })() : '';
  const flagBadge = t.flag==='blocked'?`<span class="flagbadge blk">${IC.pause} bloqueada</span>`:''; // cancelada/concluída já saem no selo de status
  const asking = pendingOf(t.id).length>0;
  const epId=t.epic&&t.epic.epicId, epSt=(epId&&typeof epColor==='function')?` style="--epc:${epColor(epId)}"`:'';
  return `<div class="fcard${accCls}${t.id===selected?' sel':''}${t.flag?' flagged':''}${asking?' asking':''}${epSt?' has-ep':''}" data-id="${t.id}"${epSt}>
    <div class="fhead"><span class="sd" style="background:${col}"></span><b>${esc(t.title)}</b>${typeof epTaskBadge==='function'?epTaskBadge(t):''}${t.linkedTo?`<span class="linkbadge" title="correção linkada a outra tarefa">${IC.clip}</span>`:''}${flagBadge}<span class="fstatus stdrop" data-stmenu="${t.id}" style="color:${col}" title="mudar status da demanda"><i style="font-style:normal">${stIcon(st)}</i> ${esc(stLabel(st))}<span class="stcaret">▼</span></span></div>
    ${(()=>{const p=taskPct(t);return `<div class="cardpct" data-sum="${escA(t.id)}" title="ver o resumo do que já foi feito"><div class="bar"><i style="width:${p}%;background:${asking?'var(--warn)':'var(--good)'}"></i></div><span class="mono">${p}%</span></div>`;})()}
    <div class="fpipe">${pipe}</div>${live}
    <div class="fmeta"><span class="prj"><span class="prjd" style="background:${projColor(t.repo||state.repo)}"></span>${esc(t.proj||projShort(t.repo||state.repo))}</span>${(()=>{const ty=taskType(t);const c=TYPE_COLOR[ty]||'var(--muted)';return `<span class="typetag" style="color:${c};border-color:color-mix(in srgb,${c} 45%,transparent)">${TYPE_PT[ty]}</span>`;})()}${linkChips(t)}${pvChips(t)}${t.status==='conflict'?`<button class="btn primary sm" data-resolveconf="${escA(t.id)}" title="a IA mergeia a base e resolve os conflitos na worktree" style="padding:3px 9px;font-size:10.5px">${IC.bolt} resolver conflito</button>`:''}${(!['merged','done'].includes(t.status)&&t.flag!=='closed'&&t.status!=='draft'&&!t.prUrl)?`<button class="btn ${['review','delivered'].includes(t.status)?'primary ':''}sm" data-rowpr="${escA(t.id)}" title="checagens do repo → commit & push → cria o PR" style="padding:3px 9px;font-size:10.5px">${IC.merge} abrir PR</button>`:''}<span>${nPl((t.deliverables||[]).length,'entregável','entregáveis')}</span><span>${d?`+${d.additions} −${d.deletions}`:'sem diff'}</span>${rev?'<span class="frev">✓ review</span>':''}<span>${c!==undefined?nPl(c.length,'commit'):'… commits'}</span>${(()=>{const tc=taskCost(t.id);return (tc.usd||tc.tok)?`<span class="fcost">${fmtUsd(tc.usd)} · ${fmtTok(tc.tok)} tok</span>`:'';})()}</div>
    <div class="fclabel fctog" data-ctog="${t.id}"><span class="fcchev">${flowCommitsOpen.has(t.id)?'▾':'▸'}</span>Commits <span class="dim">· ${c!==undefined?c.length:'…'}${flowCommitsOpen.has(t.id)?' · clique num commit para ver o diff':''}</span></div>
    ${flowCommitsOpen.has(t.id)?`<div class="fcommits">${cchips}</div>`:''}
  </div>`;
}
const flowCommitsOpen=new Set(); // cards com a lista de commits expandida
