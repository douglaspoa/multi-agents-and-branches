// ---------- VERIFICAÇÃO INDEPENDENTE (Frente 1 do plano dores-2026) ----------
// 1) SELO "Verificado: testes 84/86 · CI 3/4 · relato divergente" no cartão (72-kanban) e na aba Revisão (63-revisao-pr).
//    Fonte: spec.verification (o motor grava no portão — src/test-runner.ts) + spec.ciGate.ci (o vigia abaixo grava).
// 2) VIGIA DO CI: tarefa em revisão com PR aberto → lê o status pelo MESMO comando da aba PR (pr_status, via loadPr)
//    a cada 60 s, só enquanto houver checagem pendente. Check vermelho devolve a tarefa ao agente (rework_task, o
//    "pedir ajuste" de sempre) com o nome do check e as últimas 60 linhas do `gh run view --log-failed` (pr_ci_log).
//    No máximo 2 voltas automáticas; na 3ª falha vira "precisa de você" (60-ciclo) e não volta mais sozinha.
//    Teto de custo aberto/estourado também vira pergunta (nunca gasta sozinho além do teto).

// @verif-puro-inicio (testado em app/tests/verificacao.test.mjs)
const CI_MAX_VOLTAS=2;
const CI_WATCH_ST=new Set(['review','pr-open']);
// o selo: { text, tone:'ok'|'bad'|'wait'|'warn', tip } ou null (nada verificado ainda)
function verifSeal(v){
  if(!v) return null;
  const parts=[], tips=[]; let tone='ok';
  const bump=k=>{ const rank={ ok:0, wait:1, warn:2, bad:3 }; if(rank[k]>rank[tone]) tone=k; };
  const t=v.tests;
  if(t){
    if(t.skipped){ parts.push('testes pulados'); tips.push(t.skipped); }
    else if(t.timedOut){ parts.push('testes sem tempo'); tips.push(`${t.runner||'a suíte'} não terminou no tempo-limite`); bump('warn'); }
    else if(t.ran){
      const tot=t.passed!=null?t.passed+(t.failed||0):null;
      parts.push(tot!=null?`testes ${t.passed}/${tot}`:(t.ok?'testes ok':'testes falharam'));
      tips.push(`${t.runner||'suíte'} rodada pelo Starfork na cópia da tarefa`);
      if(!t.ok) bump('bad');
    }
  }
  const c=v.ci;
  if(c && c.total){
    parts.push(`CI ${Math.max(0,c.total-(c.fail||0)-(c.pending||0))}/${c.total}`);
    if(c.fail){ bump('bad'); tips.push(`${c.fail} checagem(ns) do CI falhando`); }
    else if(c.pending){ bump('wait'); tips.push(`${c.pending} checagem(ns) do CI rodando`); }
  }
  if(v.divergente){ parts.push('relato divergente'); bump('bad'); if(v.relato) tips.push(v.relato); }
  if(!parts.length) return null;
  const text='Verificado: '+parts.join(' · ');
  return { text, tone, tip:[text, ...tips].join('\n') };
}
// o selo de uma tarefa: o do motor + o CI que o vigia gravou (cada lado grava a sua chave — não se atropelam)
function verifOf(t){
  const sp=(t&&t.spec)||{}, v=sp.verification||null, ci=(sp.ciGate&&sp.ciGate.ci)||(v&&v.ci)||null;
  if(!v && !ci) return null;
  return Object.assign({ tests:null, divergente:false }, v||{}, { ci });
}
// a falha deste commit (sem headRefOid, os nomes das checagens) — cada falha é tratada UMA vez
function ciFailKey(info){ return String((info&&info.headSha)||'') || ((info&&info.failingChecks)||[]).join(',') || 'ci'; }
// o que fazer com o CI do PR desta tarefa agora: stop | wait | green | idle | return | ask
function ciGateDecide(t, info, o){
  o=o||{};
  if(!t || !info || !info.exists || info.state!=='OPEN') return { act:'stop' };
  const ci={ total:+info.checksTotal||0, fail:+info.checksFail||0, pending:+info.checksPending||0 };
  if(!ci.total) return { act:'stop', ci:null };
  if(!ci.fail) return ci.pending ? { act:'wait', ci } : { act:'green', ci };
  const g=((t.spec||{}).ciGate)||{}, key=ciFailKey(info);
  if(g.lastSha===key) return { act:'idle', ci, key };
  if(!CI_WATCH_ST.has(t.status)) return { act:'wait', ci, key }; // o agente está mexendo: espera o turno acabar
  if((+g.rounds||0)>=CI_MAX_VOLTAS) return { act:'ask', ci, key, why:'voltas' };
  if(o.overBudget) return { act:'ask', ci, key, why:'teto' };
  return { act:'return', ci, key, round:(+g.rounds||0)+1 };
}
// vale gastar um `gh pr view` com esta tarefa agora? (60 s enquanto pendente; senão só quando algo mudou)
function ciWatchShould(t, memo, now){
  if(!t || !t.prUrl || !CI_WATCH_ST.has(t.status) || t.flag==='closed') return false;
  if(!memo) return true;
  if(memo.st!==t.status) return true;               // voltou pra revisão (o agente terminou o ajuste e fez push)
  if(memo.pending) return now-memo.at>=55000;        // checagem rodando: a cada ~60 s
  return now-memo.at>=10*60000;                      // assentado: confere de vez em quando (push feito por fora)
}
function ciReturnText(names, log, round){
  const nm=(names||[]).length?(names||[]).join(', '):'checagem do CI';
  return `O CI do PR falhou: ${nm} (volta automática ${round} de ${CI_MAX_VOLTAS}).\n`+
    `Descubra a causa, corrija, rode a suíte de novo e faça commit + push (o PR atualiza sozinho).`+
    (String(log||'').trim()?`\n\nÚltimas linhas do log (gh run view --log-failed):\n\`\`\`\n${String(log).trim()}\n\`\`\``:'');
}
function ciAskText(names, why){
  const nm=(names||[]).length?(names||[]).join(', '):'uma checagem';
  return why==='teto'
    ? `O CI do PR falhou (${nm}), mas a tarefa está no teto de custo · decida: mandar o agente corrigir ou deixar como está`
    : `O CI do PR falhou de novo (${nm}) depois de ${CI_MAX_VOLTAS} voltas automáticas · decida: mandar o agente corrigir mais uma vez ou deixar como está`;
}
// @verif-puro-fim

const VSEAL_TONE={ ok:'done', bad:'error', wait:'running', warn:'blocked' }; // cor = a do STATUS_META (nenhuma cor própria)
function verifSealHtml(t, cls){
  const s=verifSeal(verifOf(t)); if(!s) return '';
  return `<span class="vseal${cls?' '+cls:''}" data-tone="${s.tone}" style="--vs:${stColor(VSEAL_TONE[s.tone])}" title="${escA(s.tip)}">${esc(s.text)}</span>`;
}

const ciMemo={}; // taskId → { at, st, pending }
function ciOverBudget(t){
  const sp=t.spec||{};
  if(sp.budgetHit) return true;
  if(typeof pendingOf==='function' && typeof fwIsBudgetAsk==='function' && pendingOf(t.id).some(fwIsBudgetAsk)) return true;
  const cap=typeof budgetOf==='function'?+budgetOf(t)||0:0, spent=typeof taskCost==='function'?+taskCost(t.id).usd||0:0;
  return cap>0 && spent>=cap;
}
async function ciLogOf(info){
  const run=((info&&info.failingRuns)||[])[0]; if(!run) return '';
  try{ return String(await invokeQuiet('pr_ci_log',{ runId:String(run) })||''); }catch(_){ return ''; } // sem log (fora do Actions, sem acesso): vai só o nome
}
async function ciPatchGate(t, gate, extra){
  const next=Object.assign({}, ((t.spec||{}).ciGate)||{ rounds:0 }, gate);
  await invoke('patch_task_spec',{ taskId:t.id, patch:Object.assign({ ciGate:next }, extra||{}) });
  t.spec=Object.assign({}, t.spec||{}, { ciGate:next }); // o snapshot ainda não voltou: o próximo tick não repete
}
async function ciReturn(t, info, d){
  const text=ciReturnText(info.failingChecks, await ciLogOf(info), d.round);
  // grava ANTES de mandar: um tick concorrente (ou a janela voltando) não devolve a mesma falha duas vezes
  await ciPatchGate(t, { rounds:d.round, lastSha:d.key, asked:false, at:Date.now(), ci:d.ci });
  await invoke('rework_task',{ taskId:t.id, text });
  toast(`CI falhou — tarefa devolvida ao agente (volta ${d.round} de ${CI_MAX_VOLTAS})`,'warn');
  lastSig=''; refresh().catch(()=>{});
}
async function ciAsk(t, info, d){
  const text=ciAskText(info.failingChecks, d.why);
  await ciPatchGate(t, { lastSha:d.key, asked:true, at:Date.now(), ci:d.ci }, { needsYou:{ kind:'ci', text, at:Date.now() } });
  await invoke('mark_task_status',{ taskId:t.id, status:'needs-you' });
  if(typeof pushNotif==='function') pushNotif('CI falhou de novo — precisa de você', t.title||'', t.id);
  lastSig=''; refresh().catch(()=>{});
}
async function ciWatchTick(){
  const now=Date.now();
  // tarefa fora da revisão (o agente corrigindo, ou parada pra você): guarda o status — a VOLTA pra revisão confere na hora
  for(const t of (state.tasks||[])) if(ciMemo[t.id] && !CI_WATCH_ST.has(t.status)) ciMemo[t.id].st=t.status;
  const list=(state.tasks||[]).filter(t=>ciWatchShould(t, ciMemo[t.id], now)).slice(0,6);
  for(const t of list){
    const info=await loadPr(t.id, true); // pr_status: o mesmo caminho (e cache) da aba PR — nada de outro `gh`
    if(info && info.error && !info.exists){ ciMemo[t.id]={ at:Date.now(), st:t.status, pending:false }; continue; }
    const d=ciGateDecide(t, info, { overBudget:ciOverBudget(t) });
    ciMemo[t.id]={ at:Date.now(), st:t.status, pending:d.act==='wait' };
    try{
      const g=((t.spec||{}).ciGate)||{};
      if(d.ci!==undefined && JSON.stringify(g.ci||null)!==JSON.stringify(d.ci||null) && d.act!=='return' && d.act!=='ask') await ciPatchGate(t, { ci:d.ci });
      if(d.act==='return') await ciReturn(t, info, d);
      else if(d.act==='ask') await ciAsk(t, info, d);
      // devolvida/parada: a próxima vez que a tarefa estiver em revisão (ajuste rápido, < 60 s) confere na hora
      if(d.act==='return' || d.act==='ask') ciMemo[t.id].st='devolvida';
    }catch(e){ showErr(e, 'Não consegui tratar a falha do CI'); }
  }
}
tickLoop('ciWatchTick', ciWatchTick, 60000, 20000, { local:true });

// "precisa de você" do CI (60-ciclo): mandar corrigir mais uma vez (decisão da pessoa) ou deixar como está
async function ciPersonDecide(t, kind){
  if(kind==='cifix'){
    const info=await loadPr(t.id, true);
    const text=ciReturnText((info&&info.failingChecks)||[], await ciLogOf(info), 'extra, pedida por você').replace(/ de \d+\)/, ')');
    await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null } });
    await invoke('rework_task',{ taskId:t.id, text });
    toast('Mandei o agente corrigir o CI — depois disso, se falhar de novo, pergunto de novo','ok');
  } else {
    await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null } });
    await invoke('mark_task_status',{ taskId:t.id, status:'review' });
    toast('Ficou como está — o CI vermelho continua visível no selo','ok');
  }
}
