// COMANDO · CICLO DA TAREFA NO CHAT (17/11): plano, PR com base escolhida, verificação, provas, conflito, CI, teto.
// Tudo o que antes exigia abrir a aba da tarefa ou a preparação do PR. Cada ação usa a MESMA função da tela
// (startTask, prCreateRun, chkRun, proofAsk, resolverConflito, rework_task, budgetRelease) — nada de caminho paralelo.
const CMD_CICLO=new Set(['plano','aprovar_plano','abrir_pr','checks','pedir_prova','resolver_conflito','ci','corrigir_ci','iniciar','refazer','liberar_teto']);

/** O que falta pra uma ação valer nesta tarefa — '' = pode. Puro. t: { status, needsPlano }, acao */
function cmdCicloPode(acao, t){
  const st=String((t&&t.status)||''), plano=st==='plan-review' || !!(t&&t.needsPlano);
  if(acao==='aprovar_plano' || acao==='plano') return plano?'':'não está esperando aprovação de plano';
  if(acao==='iniciar') return (st==='draft'||st==='queued'||st==='paused')?'':'não é um rascunho nem está pausada';
  if(acao==='resolver_conflito') return st==='conflict'?'':'não está em conflito';
  return '';
}
/** Base do PR a partir do que a pessoa disse ("homol", "pra develop", "na main"). Puro. '' = não disse. */
function cmdPrBase(txt){
  const s=String(txt||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); if(!s) return '';
  const m=/(?:^|\s)(?:pra|para|na|no|em|base|->|→)\s+(?:(?:a|o)\s+)?([a-z0-9._\/-]{2,60})\s*$/.exec(' '+s) || /^([a-z0-9._\/-]{2,60})$/.exec(s);
  if(!m) return ''; return ({ homologacao:'homol', producao:'main', prod:'main' })[m[1]]||m[1];
}
/** Resumo de uma verificação. Puro. res: { results:[{ label, ok, notFound, durationMs }] } */
function cmdChecksResumo(res){
  const R=(res&&res.results)||[]; if(!R.length) return { ok:true, linhas:[], falhas:[], faltam:[] };
  const falhas=R.filter(x=>!x.ok && !x.notFound).map(x=>x.label), faltam=R.filter(x=>!x.ok && x.notFound).map(x=>x.label);
  return { ok:!falhas.length && !faltam.length, linhas:R.map(x=>({ label:x.label, ok:!!x.ok, nota:x.notFound?'ferramenta não encontrada':'' })), falhas, faltam };
}
/** Resumo do PR/CI. Puro. i: PrInfo do pr_status */
function cmdCiResumo(i){
  if(!i || !i.exists) return { tem:false, tx:(i&&i.error)?'Não consegui ler o PR: '+String(i.error).slice(0,140):'Ainda não há PR desta tarefa.' };
  const tot=+i.checksTotal||0, bad=+i.checksFail||0, pend=+i.checksPending||0, f=(i.failingChecks||[]).slice(0,8);
  const ci=!tot?'sem checagens de CI':bad?`${bad} de ${tot} checagens falhando`:pend?`${pend} de ${tot} checagens rodando`:`${tot} checagens passando`;
  const est=({ OPEN:'aberto', MERGED:'integrado', CLOSED:'fechado' })[String(i.state||'').toUpperCase()]||String(i.state||'').toLowerCase();
  const rev=({ APPROVED:'aprovado na revisão', CHANGES_REQUESTED:'revisão pediu mudanças', REVIEW_REQUIRED:'esperando revisão' })[String(i.decision||'')]||'';
  const conf=String(i.mergeable||'')==='CONFLICTING'?'em conflito com a base':'';
  return { tem:true, url:i.url||'', falhando:f, bad, pend, tx:[`PR #${i.number} ${est}${i.isDraft?' (rascunho)':''}${i.baseRefName?' → '+i.baseRefName:''}`, ci, rev, conf].filter(Boolean).join(' · ') };
}

function cmdCicloCard(c){ cmdMsgs().push(Object.assign({ r:'bot', k:'ciclo' }, c)); cmdPaint(true); return cmdMsgs()[cmdMsgs().length-1]; }
function cmdCicloHtml(m){
  const linhas=(m.linhas||[]).map(l=>`<li class="${l.ok===false?'bad':l.ok?'ok':''}">${l.ok===false?'✕':l.ok?'✓':'·'} ${esc(l.label)}${l.nota?` <span class="cmdhint">${esc(l.nota)}</span>`:''}</li>`).join('');
  const acts=(m.acts||[]).map(a=>a.url?`<button type="button" class="btn sm${a.p?' primary':' quiet'}" data-cmdlk="${escA(a.url)}">${esc(a.t)} ↗</button>`
    :/:\s$/.test(a.dizer)?`<button type="button" class="btn sm quiet" data-cmdpre="${escA(a.dizer)}">${esc(a.t)}…</button>`
    :`<button type="button" class="btn sm${a.p?' primary':' quiet'}" data-cmdchip="${escA(a.dizer)}">${esc(a.t)}</button>`).join('');
  return `<div class="cmdciclo${m.busy?' wait':''}"><div class="cmdciclo-h"><b>${esc(m.titulo||'')}</b>${m.code?` <span class="mono cmdhint">${esc(m.code)}</span>`:''}</div>${m.tx?`<p>${esc(m.tx)}</p>`:''}${m.md?`<div class="cmdciclo-md">${typeof chatMd==='function'?chatMd(m.md):'<pre>'+esc(m.md)+'</pre>'}</div>`:''}${linhas?`<ul class="cmdciclo-l">${linhas}</ul>`:''}${m.busy?`<div class="cmdhint"><span class="pltyping"><i></i><i></i><i></i></span> ${esc(m.busy)}</div>`:''}${acts?`<div class="cmdacts">${acts}</div>`:''}</div>`;
}

/** Executa UMA ação do ciclo numa tarefa. p: passo do plano; x: alvo { id, code, ref, title }; say: fala curta no chat. */
/** PR DE UMA BRANCH QUE JÁ EXISTE pra outro destino — vale também pra tarefa ENCERRADA (26/11: "abre o PR da 1260 pra homol
 *  também", com a 1260 já integrada na main). alvo = destino; texto = a branch, quando não é a da tarefa. */
async function cmdPrDeBranch(p, x, say){
  const t=cmdTaskAny(x.id)||cmdAllTasks().find(k=>k.id===x.id), code=x.code||x.ref||'tarefa'; if(!t) return say(`A ${code} não está nesta máquina.`);
  const base=cmdPrBase(p.alvo); if(!base) return say('Pra qual branch é o PR? (ex.: homol)');
  const head=String(p.texto||'').trim()||String(t.branch||'').trim(); if(!head) return say(`A ${code} não tem branch registrada — diga o nome da branch.`);
  if(!/^[A-Za-z0-9._\/-]{1,200}$/.test(head) || head.startsWith('-')) return say(`“${head.slice(0,60)}” não é um nome de branch. Diga só o nome dela (ex.: fix/LW-47-ajuste).`);
  const m=cmdCicloCard({ titulo:'Pull request → '+base, code, busy:'abrindo o PR de '+head+' pra '+base+'…' });
  try{ const tit=(x.code?x.code+': ':'')+cmdUma(mdTitle(t.title||'')).slice(0,90)+' (→ '+base+')';
    const r=await invoke('pr_de_branch',{ taskId:t.id, head, base, title:tit, body:`Mesmo trabalho da ${code}, levado pra \`${base}\` a partir da branch \`${head}\`.\n\nAberto pelo Comando do Starfork a pedido de quem coordena.` });
    m.busy=''; m.tx=r.url?`${r.jaExistia?'Já existia um PR aberto':'PR aberto'} de ${r.head} pra ${r.base}: ${r.url}`:`O PR de ${head} pra ${base} foi criado, mas não recebi o endereço.`; m.acts=r.url?[{ t:'Ver o PR', p:1, url:r.url }]:[];
  }catch(e){ m.busy=''; m.tx='Não abri o PR: '+String((e&&e.message)||e).replace(/^GH_NO_ACCESS:\s*/,'').slice(0,260); }
  cmdPaint(true); }
async function cmdCiclo(p, x, say){
  const t=cmdTask(x.id), code=x.code||x.ref||'tarefa'; if(!t) return say(`A ${code} não está nesta máquina.`);
  const nao=cmdCicloPode(p.acao, { status:t.status, needsPlano:!!(t.spec&&t.spec.needsYou&&t.spec.needsYou.kind==='plano') }); if(nao) return say(`A ${code} ${nao}.`);
  const erro=e=>String((e&&e.err&&(e.err.message||e.err))||(e&&e.message)||e).slice(0,260);
  try{
    if(p.acao==='plano'){ let md=''; try{ const r=await invoke('read_file',{ taskId:t.id, path:'.cardume/PLAN.md' }); md=String((r&&r.content)||''); }catch(_){ }
      return cmdCicloCard({ titulo:'Plano esperando a sua aprovação', code, md:md.slice(0,6000)||'', tx:md?'':'O agente ainda não gravou o plano em arquivo — ele está na conversa da tarefa.',
        acts:[{ t:'Aprovar o plano', p:1, dizer:`aprova o plano da ${code}` }, { t:'Pedir ajuste', dizer:`no plano da ${code}, ajuste: ` }] }); }
    if(p.acao==='aprovar_plano'){
      if(t.status==='plan-review'){ const ok=await startTask(t.id); if(ok===false) return say(`Não aprovei o plano da ${code}: o início foi cancelado ou já estava em andamento.`); }
      else { const r=await cmdEntregar(t.id, 'Plano aprovado. Pode implementar.'); if(!r.ok) return say(`Não consegui aprovar o plano da ${code}: ${r.nota||'o agente não recebeu'}.`); }
      say(`Plano da ${code} aprovado — a IA começou a implementar.`); if(typeof cmdAcompanhar==='function') cmdAcompanhar(t.id, 'Plano aprovado. Pode implementar.', ((CMD.hist[t.id]&&CMD.hist[t.id].items)||[]).length); return; }
    if(p.acao==='iniciar'){ const ok=await startTask(t.id); if(ok===false) return say(`Não iniciei a ${code}: o início foi cancelado ou já estava em andamento.`); say(`Iniciei a ${code}.`); if(typeof cmdAcompanhar==='function') cmdAcompanhar(t.id, 'Tarefa iniciada.', 0); return; }
    if(p.acao==='refazer'){ await rerunTask(t.id); return say(`Pedido de refazer a ${code} do zero enviado.`); }
    if(p.acao==='checks'){ const m=cmdCicloCard({ titulo:'Verificação', code, busy:'rodando a verificação na cópia da tarefa…' });
      const cfg=await chkEnsure(t, true); if(cfg.st==='none'){ m.busy=''; m.tx='Este projeto não tem verificação configurada.'; return cmdPaint(true); }
      const res=await chkRun(t), R=cmdChecksResumo(res); m.busy=''; m.linhas=R.linhas; m.tx=R.ok?'Tudo passou.':(R.falhas.length?nPl(R.falhas.length,'checagem falhou','checagens falharam'):'')+(R.faltam.length?(R.falhas.length?' · ':'')+nPl(R.faltam.length,'não rodou','não rodaram'):'');
      m.acts=R.ok?[{ t:'Abrir o PR', p:1, dizer:`abre o PR da ${code}` }]:[{ t:'Mandar o agente corrigir', p:1, dizer:`${code}: a verificação falhou em ${R.falhas.concat(R.faltam).join(', ')}. Corrija e rode de novo.` }];
      return cmdPaint(true); }
    if(p.acao==='pedir_prova'){ if(typeof loadReqProofs==='function') await loadReqProofs(t.id).catch(()=>{}); const g=proofGate(t);
      if(!g.missing.length) return say(`A ${code} já tem prova em todos os requisitos.`);
      const antes=((CMD.hist[t.id]&&CMD.hist[t.id].items)||[]).length, ok=await proofAsk(t); if(!ok) return say(`Não consegui pedir as provas da ${code}.`);
      say(`Pedi ao agente a prova de ${nPl(g.missing.length,'requisito','requisitos')} da ${code}.`); if(typeof cmdAcompanhar==='function') cmdAcompanhar(t.id, 'Registre a prova dos requisitos que faltam.', antes); return; }
    if(p.acao==='resolver_conflito'){ const ok=await resolverConflito(t.id); return say(ok===false?`Não consegui mandar resolver o conflito da ${code}.`:`Mandei o agente da ${code} resolver o conflito com a base.`); }
    if(p.acao==='ci'){ const m=cmdCicloCard({ titulo:'PR e CI', code, busy:'consultando o GitHub…' }); const i=await loadPr(t.id, true), R=cmdCiResumo(i);
      m.busy=''; m.tx=R.tx; m.linhas=(R.falhando||[]).map(l=>({ label:l, ok:false }));
      m.acts=!R.tem?[{ t:'Abrir o PR', p:1, dizer:`abre o PR da ${code}` }]:[{ t:'Ver o PR', url:R.url }].concat(R.bad?[{ t:'Mandar corrigir o CI', p:1, dizer:`manda o agente da ${code} corrigir o CI` }]:[]);
      return cmdPaint(true); }
    if(p.acao==='corrigir_ci'){ const i=await loadPr(t.id, true), f=(i&&i.failingChecks)||[]; if(!i||!i.exists) return say(`A ${code} ainda não tem PR.`); if(!f.length) return say(`O CI da ${code} não tem checagem falhando agora.`);
      let log=''; try{ log=await ciLogOf(i); }catch(_){ }
      const text=typeof ciReturnText==='function'?ciReturnText(f, log, 'extra, pedida por você').replace(/ de \d+\)/, ')'):'O CI do PR falhou em: '+f.join(', ')+'. Corrija e envie de novo.';
      const antes=((CMD.hist[t.id]&&CMD.hist[t.id].items)||[]).length; try{ await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null } }); }catch(_){ }
      await invoke('rework_task',{ taskId:t.id, text }); try{ lastSig=''; }catch(_){ } refresh().catch(()=>{});
      say(`Devolvi a ${code} ao agente pra corrigir ${nPl(f.length,'checagem','checagens')} do CI.`); if(typeof cmdAcompanhar==='function') cmdAcompanhar(t.id, 'Corrigir o CI: '+f.join(', '), antes); return; }
    if(p.acao==='liberar_teto'){ const usd=parseFloat(String(p.alvo||'').replace(',','.').replace(/[^0-9.]/g,'')); if(!(usd>0)) return say('Diga quanto liberar, em dólares (ex.: "libera mais 5 dólares na '+code+'").');
      await budgetRelease(t, usd, p.texto||'liberado pelo Comando'); try{ lastSig=''; }catch(_){ } refresh().catch(()=>{}); return say(`Liberei mais US$ ${usd.toFixed(2)} de teto na ${code}.`); }
    if(p.acao==='abrir_pr'){ const base=cmdPrBase(p.alvo)||lsGet('prBase:'+t.id)||'main'; lsSet('prBase:'+t.id, base);
      const m=cmdCicloCard({ titulo:'Pull request → '+base, code, busy:'conferindo a verificação…' });
      let g=await chkEnsure(t, true); if(g.st==='notrun' || g.st==='stale'){ m.busy='rodando a verificação na cópia da tarefa…'; cmdPaint(); await chkRun(t); g=chkGate(t); }
      if(!chkCanApprove(g)){ const motivo=String(p.texto||'').trim();
        if(!motivo){ m.busy=''; const R=g.r?cmdChecksResumo(g.r):{ linhas:[] }; m.linhas=R.linhas; m.tx=g.st==='fail'?'A verificação falhou — não abri o PR.':g.st==='err'?'Não consegui rodar a verificação: '+String(g.err||'').slice(0,160):'A verificação não passou nesta versão — não abri o PR.';
          m.acts=[{ t:'Mandar o agente corrigir', p:1, dizer:`${code}: a verificação falhou${(R.falhas||[]).length?' em '+R.falhas.join(', '):''}. Corrija e rode de novo.` }, { t:'Abrir mesmo assim', dizer:`abre o PR da ${code} pra ${base} mesmo assim, motivo: ` }]; return cmdPaint(true); }
        const ok=await chkOverride(t, g, motivo); if(!ok){ m.busy=''; m.tx='Não liberei a verificação — o PR não foi aberto.'; return cmdPaint(true); } }
      m.busy='enviando a branch…'; cmdPaint();
      const url=await prCreateRun(t, base, (n, st, tx)=>{ if(st==='run'){ m.busy=String(tx||'').replace(/<[^>]+>/g,''); cmdPaint(); } });
      m.busy=''; m.tx=url?'PR aberto pra '+base+': '+url:'O PR foi criado, mas não recebi o endereço.'; m.acts=(url?[{ t:'Ver o PR', p:1, url }]:[]).concat([{ t:'Como está o CI?', dizer:`como está o CI da ${code}?` }]); return cmdPaint(true); }
  }catch(e){ const ms=cmdMsgs(), u=ms[ms.length-1]; if(u && u.k==='ciclo' && u.busy){ u.busy=''; u.tx='Não deu certo: '+erro(e); if(p.acao==='abrir_pr' && typeof invoke==='function'){ try{ const cu=await invoke('pr_compare_url',{ taskId:t.id, base:cmdPrBase(p.alvo)||lsGet('prBase:'+t.id)||'main' }); if(cu) u.acts=[{ t:'Abrir no GitHub', url:cu }]; }catch(_){ } } cmdPaint(true); } else say(`Não deu certo na ${code}: ${erro(e)}`); }
}
