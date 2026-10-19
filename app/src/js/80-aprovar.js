// Starfork — 80-aprovar: APROVAR numa ação só + o PAINEL DE PROVAS (um componente, o mesmo em 4 lugares) + a fila
// "Para aprovar". Mock aprovado pelo dono em 15/10 (starfork-epico-fluxo.html; _bmad-output/redesenho-foco/epico-fluxo.md
// §3 D4–D7 e D10). O dono: "às vezes eu poderia só ver as provas e aprovar, ou aprovar da Central mesmo".
//   proofPanel(taskId, mode) — mode 'full' (fila) · 'compact' (Central e Meu trabalho) · 'task' (Revisão ⌘3 da tarefa)
//   aprovarTarefa(taskId, { motivo }) — portões → aceita os requisitos com prova → abre o PR se não houver → 4 s com
//     Desfazer (Z) → integra na main (squash) → avisa a onda: 'sf:epico-onda-fechada' {epicId, wave} e, na última,
//     'sf:epico-ultima-integrada' {epicId} (a aba do épico, outra frente, escuta e solta a próxima onda / a verificação final)
//   pedirAlteracao(taskId, texto) — manda pra Conversa da tarefa (o mesmo caminho do "Pedir alteração" do #147) e tira da fila
//   resolverConflito(taskId) — "Resolver conflito" de TODA tela (Central, Meu time, quadro, épico, este painel, PR, menu ⋯):
//     o pedido (conflitoPedido) vai pro terminal da tarefa pelo mesmo fwSendText; sessão encerrada → reabre o terminal
//     antes; IA rodando → entra na fila. Cartão de colega: conflitoPedirA (comentário no cartão) · conflitoAssumir
// Fontes únicas (nenhuma regra nova aqui): portões = rvGatesOf/rvMissingText (63) com proofGate e prCache/loadPr (21);
// abrir o PR = approveGate (21, a porta única: verificação → push → PR); integrar = mergePrRun (21, gh pr merge --squash);
// motivo = proofOverride(t, motivo) (21) + patch_task_spec reviewOverride + checks_override_log (o mesmo log do
// "aprovar mesmo assim"); aceite = rvSt/rvStSave (63, o "aceito este requisito"); pedir alteração = rqChangeGate/
// rqChangeText (71) + fwSendText (20); status = taskSt/flowBucket/STATUS_META (22/00); ondas = epqEpicTasks (46);
// quem aprova = quem pediu o épico/a demanda ou o líder (tmCanAssignNow, 42). Sem polling novo: pinta no render() que já
// existe e quando o estado DAQUI muda (com guarda de HTML).

// @ap-puro-inicio (puro: só esc/escA e rvMissingText do 63 — testado em app/tests/aprovar.test.mjs)
const AP_UNDO_MS=4000; // janela do Desfazer antes do merge (o merge não volta)
// motivo pra passar por cima do revisor / da prova: pelo menos 3 palavras (a mesma régua do "aprovar sem prova…")
function apMotivoOk(s){ return String(s||'').trim().split(/\s+/).filter(w=>/[\p{L}\p{N}]{2,}/u.test(w)).length>=3; }
/**
 * O que "Aprovar" pode fazer agora, a partir dos portões (rvGatesOf). O aceite não conta: aprovar ACEITA os requisitos.
 * prova/revisor vermelhos passam com motivo; conflito nunca; o resto que falta (checagens falhando, revisão que não
 * rodou, provas carregando) bloqueia com o porquê. → { kind:'ok'|'motivo'|'conflito'|'bloqueado', why, precisa:[ids] }
 */
function apDecide(gates, o){
  o=o||{}; const G=gates||[]; const by=id=>G.find(g=>g.id===id)||{};
  if(by('conflito').st==='bad') return { kind:'conflito', why:'a branch conflita com a main — resolva o conflito antes', precisa:[] };
  const precisa=['prova','revisor'].filter(id=>by(id).st==='bad');
  const outros=G.filter(g=>g.id!=='aceite' && !precisa.includes(g.id) && (g.st==='bad'||g.st==='wn'));
  if(outros.length) return { kind:'bloqueado', why:rvMissingText(outros), precisa };
  if(precisa.length && !apMotivoOk(o.motivo)) return { kind:'motivo', precisa,
    why:precisa.length===2?'o revisor pediu mudança e falta prova':precisa[0]==='revisor'?'o revisor pediu mudança':'falta prova' };
  return { kind:'ok', why:'', precisa };
}
/** Os selos dos portões (o aceite fica de fora: aprovar aceita). rev = nome do revisor. → [{ st:'ok'|'bad'|'run', tx }] */
function apChips(gates, rev){
  const R=String(rev||'Revisor');
  return (gates||[]).filter(g=>g.id!=='aceite' && g.st!=='na').map(g=>{
    const st=g.st==='ok'?'ok':g.st==='run'?'run':'bad';
    if(g.id==='revisor') return { st, tx:R+': '+(g.st==='ok'?(/sem nova revisão/.test(g.val)?'seguiu com motivo':'aprovou'):g.st==='bad'?'pediu mudança':/ilegível/.test(g.val)?'veredito ilegível':'ainda não revisou') };
    if(g.id==='conflito') return { st, tx:g.st==='ok'?'sem conflito':g.st==='bad'?'conflito com a main':'conferindo conflito' };
    if(g.id==='checks') return { st, tx:'checagens: '+g.val };
    return { st, tx:g.val };
  });
}
/**
 * "Ao aprovar: …" — o que acontece exatamente depois do clique (mock D4). o = { pr, epico:null | { onda, mesmaOnda:[{code,
 * quem, st}], proxima:[{code, quem}], ultima, auto } }. → { c:''|'w', h } (h já escapado: só passa por esc)
 */
function apAoAprovar(o){
  o=o||{}; const pr=o.pr?`o PR #${esc(String(o.pr))}`:'o PR (abre agora)';
  const base=o.pr?`Integra ${pr} na main`:'Abre o PR e integra na main';
  const ep=o.epico;
  if(!ep) return { c:'', h:`${base}. Não faz parte de épico.` };
  const lab=x=>`<b>${esc(x.code||'tarefa')}</b>`+(x.quem||x.st?` (${esc([x.quem, x.st].filter(Boolean).join(', '))})`:'');
  const falta=ep.mesmaOnda||[];
  if(falta.length) return { c:'w', h:`${base}. ${ep.ultima?'A verificação final':'A onda '+(ep.onda+1)} ainda espera ${falta.slice(0,3).map(lab).join(', ')}${falta.length>3?` e mais ${falta.length-3}`:''}.` };
  if(ep.ultima) return { c:'', h:`${base} e é a última tarefa: a <b>verificação final</b> confere o "Pronto quando" sozinha.` };
  const nx=(ep.proxima||[]).slice(0,3).map(x=>`${esc(x.code||'tarefa')}${x.quem?' com '+esc(x.quem):''}`).join(', ');
  return { c:'', h:`${base} e fecha a onda ${ep.onda}: <b>a onda ${ep.onda+1} ${ep.auto===false?'fica liberada pra você começar':'começa sozinha'}</b>${nx?` (${nx})`:''}.` };
}
/** "O que mudou, em uma frase": o que o agente disse que fez por requisito; senão a última fala dele; senão o pedido. */
function apFrase(o){
  o=o||{}; const cut=(s,n)=>{ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s; };
  const dids=(o.dids||[]).map(x=>String(x||'').trim()).filter(Boolean);
  if(dids.length){ const f=dids.slice(0,2).map(x=>x.replace(/[.;]\s*$/,'')).join('; '); return cut(f.charAt(0).toUpperCase()+f.slice(1)+'.', 220); }
  const m=String(o.msg||'').trim(); if(m){ const s=(m.match(/^[^.!?\n]+[.!?]?/)||[m])[0]; return cut(s, 220); }
  return cut(o.objetivo, 220);
}
/** Quem aprova (decisão do dono 15/10): quem pediu (o épico ou a demanda) ou o líder; sem time = você. → { pode, quem } */
function apPode(o){
  o=o||{};
  if(!o.temTime || !o.me) return { pode:true, quem:'' };
  if(!o.pediu || o.pediu===o.me || o.lider) return { pode:true, quem:o.pediu&&o.pediu!==o.me?o.pediu:'' };
  return { pode:false, quem:o.pediu };
}
/** Depois de integrar `justId`: a onda dele fechou? era a última? items = [{ id, wave, b }] (b do epqBucket; 'off' = fora). */
function apOndaDepois(items, wave, justId){
  const L=(items||[]).filter(x=>x && x.b!=='off').map(x=>x.id===justId?Object.assign({}, x, { b:'ok' }):x);
  const fechou=L.filter(x=>x.wave===wave).every(x=>x.b==='ok');
  return { fechou, ultima:fechou && L.every(x=>x.b==='ok') };
}
/** Sugestões do campo "Pedir alteração": o que o revisor pediu na última rodada; sem isso, as 3 de sempre. */
function apSugestoes(rounds){
  const l=(rounds||[]).slice(-1)[0];
  if(l && l.verdict==='muda' && (l.items||[]).length) return l.items.slice(0,4).map(String);
  return ['Faltou o print no celular','Explique o trecho que mudou sem porquê','Rode os testes de novo e mostre a saída'];
}
/** J/K: a nova seleção numa lista de n itens (sem dar a volta). */
function apNav(n, sel, dir){ if(!(n>0)) return 0; return Math.max(0, Math.min(n-1, (sel|0)+(dir<0?-1:1))); }
/**
 * RESOLVER CONFLITO — o texto ÚNICO que vai pra IA (terminal da tarefa, "corrigir tudo" do PR, tarefa de quem assumiu).
 * o = { base ('main'), branch (a da tarefa), pushTo (branch do PR, quando a worktree é outra: "Assumir e resolver") }
 */
function conflitoPedido(o){
  o=o||{}; const base=String(o.base||'').replace(/^origin\//,'').trim()||'main', br=String(o.branch||'').trim(), to=String(o.pushTo||'').trim();
  return ['RESOLVER CONFLITO COM A BASE: a branch'+(br?' '+br:'')+' conflita com a '+base+' e o PR não integra assim.',
    (to?`0) Trabalhe em cima da branch do PR: git fetch origin ${to} e, se esta pasta não partiu dela, git reset --hard origin/${to}.\n`:'')+
    `1) Atualize a branch com a base: git fetch origin ${base} e git merge origin/${base} (rebase só se a branch nunca foi publicada).`,
    '2) Resolva cada conflito preservando a intenção dos dois lados — o que a base trouxe e o que esta tarefa fez; nunca descarte um lado inteiro.',
    '3) Rode os testes do projeto e corrija o que quebrar.',
    `4) Faça commit e push${to?' pra branch do PR: git push origin HEAD:'+to:''} — o PR atualiza sozinho.`,
    'No fim, diga em uma linha quais arquivos tinham conflito e como ficou.'].join('\n');
}
/** O aviso depois de mandar. working = a IA estava no meio de um turno (o pedido entra na fila); reabriu = o terminal estava encerrado. */
function conflitoAviso(o){
  o=o||{}; const q=o.code?'da '+o.code:'da tarefa';
  if(o.working) return `Na fila: a IA termina o que está fazendo e em seguida resolve o conflito ${q} no terminal.`;
  return `${o.reabriu?'Reabri o terminal '+q+' e mandei':'Mandei pro terminal '+q} o pedido: trazer a base, resolver os conflitos, rodar os testes e fazer push.`;
}
/** O comentário que fica no cartão do colega (atividade do time) — com o nome de quem pediu, nunca id. */
function conflitoComentario(base){ return 'Pediu pra resolver o conflito com a '+(String(base||'').replace(/^origin\//,'').trim()||'main')+': trazer a base pra branch, resolver mantendo os dois lados, rodar os testes e fazer push.'; }
// @ap-puro-fim

// ---------------------------------------------------------------- estado
// pending: a aprovação na janela do Desfazer · busy: passo em andamento por tarefa · ui: campo aberto no painel
// ('ask' = pedir alteração · 'why' = aprovar mesmo assim, com motivo) · draft: o que a pessoa digitou · gone: pediu
// alteração (sai da fila até o status mudar) · ok: integrada agora há pouco (o painel diz "aprovada")
const AP={ pending:null, busy:{}, ui:{}, draft:{}, focus:'', gone:{}, ok:{}, selId:'', meuExp:'', meuSel:'', tick:null, soon:null };
function apTaskOf(id){ return ((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===id)||null; }
function apMe(){ return (typeof cloudUserId==='function'&&cloudUserId())||''; }
function apTemTime(){ try{ return !!(SB.sess() && cloudTeamId()); }catch(_){ return false; } }
function apCode(t){
  let c='';
  try{ const ch=typeof chainOfNow==='function'?chainOfNow(t):null; c=(ch&&ch.issue&&ch.issue.code)||''; }catch(_){ }
  return c||(t.spec&&t.spec.issueCode)||(typeof issueCodeOf==='function'&&issueCodeOf(t))||'';
}
function apTitle(t){ return typeof mdTitle==='function'?mdTitle(t.title||''):String(t.title||''); }
// o cartão do time desta tarefa: pelo mapa local→nuvem (72); sem mapa, pelo local_id do cartão (time ou irmãs do épico)
function apCard(t){
  try{ const c=typeof tcLocalCtx==='function'?tcLocalCtx(t, false):null; if(c&&c.card) return c.card; }catch(_){ }
  const byLid=L=>(L||[]).find(c=>c && c.local_id===t.id)||null;
  let c=byLid(typeof teamTasks!=='undefined'?teamTasks:null);
  if(!c && typeof epQueue!=='undefined' && t.epic && t.epic.epicId) c=byLid((epQueue.sibsOf||{})[t.epic.epicId]);
  return c;
}
function apEpic(t){ const id=t&&t.epic&&t.epic.epicId; if(!id) return null; return ((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===id)||{ id }; }
function apWave(t){ return Math.max(1, parseInt(((t&&t.epic)||{}).wave,10)||1); }
function apWho(t){ const c=apCard(t); return (c&&c.assignee)||apMe()||''; }
function apWhoName(uid){ return !uid||uid===apMe()?'você':typeof personName==='function'?personName(uid,{ noYou:true }):''; }

/** Está na fila "Para aprovar"? Terminou (pronta pra revisar ou PR aberto) e não foi integrada; ou o revisor pediu
 *  mudança e a IA não resolveu sozinha (needs-you com veredito "muda"); ou PR aberto com conflito. */
function apAprovavel(t){
  if(!t || t._cross || t.status==='draft' || t.status==='cancelled' || (typeof taskIsDone==='function'&&taskIsDone(t))) return false;
  const g=AP.gone[t.id];
  if(g){ if(t.status!==g.st || Date.now()-g.at>10*60000) delete AP.gone[t.id]; else return false; }
  if(AP.pending && AP.pending.id===t.id) return true;
  if(typeof pendingOf==='function' && pendingOf(t.id).length) return false; // pergunta aberta: primeiro responder
  if(['running','thinking','queued','paused','plan-review','error','aborted','blocked'].includes(t.status) || t.busy) return false;
  if(t.status==='needs-you'){ const l=(typeof rvRounds==='function'?rvRounds(t):[]).slice(-1)[0]; return !!(l&&l.verdict==='muda'); }
  if(t.status==='conflict') return !!t.prUrl;
  const b=typeof flowBucket==='function'?flowBucket(t):'';
  return b==='prontas'||b==='praberto';
}
/** Pode ser você a aprovar esta? (o painel mostra "aprova: Fulano" sem o botão pra quem não pode) */
function apPodeDe(t){
  const ep=apEpic(t), card=apCard(t);
  const pediu=(ep&&ep.created_by)||(card&&card.created_by)||'';
  let lider=false; try{ lider=typeof tmCanAssignNow==='function' && tmCanAssignNow((card&&card.team_id)||cloudTeamId()); }catch(_){ }
  return apPode({ me:apMe(), temTime:apTemTime(), pediu, lider });
}
function apMod(t){
  const ev=typeof lastEventOf==='function'?lastEventOf(t.id):null;
  return (typeof modTs==='function'?modTs(ev&&ev.ts, t.finishedAt, t.updatedAt, t.createdAt):0)||(+t.finishedAt||+t.createdAt||0);
}
/** A fila: aprováveis desta máquina, a mais recente primeiro (a que está integrando continua até o fim). */
function apFila(){ return ((typeof state!=='undefined'&&state.tasks)||[]).filter(apAprovavel).sort((a,b)=>apMod(b)-apMod(a)); }
function apFilaCount(){ return apFila().filter(t=>apPodeDe(t).pode).length; }

// ---------------------------------------------------------------- dados do painel
function apRefreshSoon(){ clearTimeout(AP.soon); AP.soon=setTimeout(apRefresh, 120); }
// carrega o que falta (uma vez por tarefa; o cache de cada fonte decide) e repinta quando chega
function apEnsure(t){
  if(typeof reqProofCache!=='undefined' && reqProofCache[t.id]===undefined && Array.isArray(t.requirements) && t.requirements.length && typeof loadReqProofs==='function') loadReqProofs(t.id).then(apRefreshSoon).catch(()=>{});
  if(t.prUrl && typeof prCache!=='undefined' && typeof loadPr==='function' && (prCache[t.id]===undefined || (typeof prIsStale==='function' && prIsStale(t.id)))) loadPr(t.id, prCache[t.id]!==undefined).then(apRefreshSoon).catch(()=>{});
}
function apPrInfo(t){ const i=(typeof prCache!=='undefined')?prCache[t.id]:null; return i&&i.exists?i:null; }
/** Os portões de AGORA (os mesmos da aba PR: rvGatesOf), com o que esta tela tem sem abrir a tarefa. */
function apGates(t){
  const rows=typeof reqRows==='function'?reqRows(t):[];
  const live=rows.filter(r=>r.status!=='deferred');
  const pg=typeof proofGate==='function'?proofGate(t):{ st:'none', missing:[] };
  const st=(typeof rvSt!=='undefined')?rvSt[t.id]:null, acc=(st&&st.acc)||{};
  const info=apPrInfo(t), open=!!(info && info.state==='OPEN');
  const sp=t.spec||{};
  let G=rvGatesOf({
    proof:{ st:pg.st, n:live.length, missing:(pg.missing||[]).length },
    acc:{ n:live.length, done:live.filter(r=>acc[rvNorm(r.text)]).length, loading:st==null },
    rev:{ has:typeof rvHasReviewer==='function'&&rvHasReviewer(t), rounds:typeof rvRounds==='function'?rvRounds(t):[], override:!!(sp.reviewOverride&&sp.reviewOverride.reason) },
    pr:open?{ checksTotal:info.checksTotal, checksFail:info.checksFail, checksPending:info.checksPending, failing:info.failingChecks||[], mergeable:info.mergeable, base:info.baseRefName||'main' }:{},
  });
  if(!open) G=G.filter(g=>g.id!=='conflito'); // sem PR ainda: o GitHub não conferiu nada (aprovar abre o PR)
  if(t.status==='conflict') G=G.filter(g=>g.id!=='conflito').concat([{ id:'conflito', label:'Conflitos', st:'bad', val:'conflita com a main', why:'resolver o conflito' }]);
  return G;
}
const AP_IMG=/\.(png|jpe?g|gif|webp)$/i;
function apRevName(last){ const n=String((last&&(last.reviewer||last.agentId))||'Revisor'); return n.charAt(0).toUpperCase()+n.slice(1); }
// o estado do painel (uma chave de STATUS_META: o selo vem de lá, nunca de mapa daqui)
function apStKey(t, dec){
  if(AP.pending && AP.pending.id===t.id) return 'integrando';
  if(AP.ok[t.id] || t.status==='merged') return 'merged';
  if(!apAprovavel(t)) return typeof taskSt==='function'?taskSt(t):t.status;
  if(dec.kind==='conflito') return 'conflict';
  if(dec.precisa.includes('revisor')) return 'mudanca-pedida';
  return 'para-aprovar';
}
function apEpicoVm(t){
  const eid=t.epic&&t.epic.epicId; if(!eid) return null;
  const onda=apWave(t);
  let items=[]; try{ items=typeof epqEpicTasks==='function'?epqEpicTasks(eid):[]; }catch(_){ items=[]; }
  const me=x=>x.local===t.id;
  const lab=x=>({ code:x.code||String(x.title||'tarefa').slice(0,28), quem:x.who?apWhoName(x.who):'', st:typeof stShort==='function'?stShort(x.st):'' });
  const cfg=(typeof window.apEpicoCfg==='function')?(window.apEpicoCfg(eid)||{}):{}; // a aba do épico (outra frente) diz se a próxima começa sozinha
  return { id:eid, nome:(typeof epNameOf==='function'&&epNameOf(eid))||'épico', onda,
    mesmaOnda:items.filter(x=>x.wave===onda && !me(x) && x.b!=='ok').map(lab),
    proxima:items.filter(x=>x.wave===onda+1).map(lab), ultima:!items.some(x=>x.wave>onda && x.b!=='ok'), auto:cfg.auto!==false };
}
function apVm(t){
  apEnsure(t);
  const rows=typeof reqRows==='function'?reqRows(t):[];
  const gates=apGates(t);
  const rounds=typeof rvRounds==='function'?rvRounds(t):[], last=rounds.slice(-1)[0]||null;
  const info=apPrInfo(t), pr=(typeof prNumOf==='function'&&prNumOf(t))||(info&&info.number)||'';
  const d=(typeof diffOf==='function'&&diffOf(t.id))||{};
  const ev=typeof lastEventOf==='function'?lastEventOf(t.id):null;
  const dec=apDecide(gates, { motivo:'' });
  const ep=apEpicoVm(t);
  const imgs=[...new Set(rows.flatMap(r=>(r.evidence||[]).map(String)).filter(x=>AP_IMG.test(x)))];
  const pd=apPodeDe(t);
  return { t, id:t.id, code:apCode(t), title:apTitle(t), who:apWho(t), ep, pr, prUrl:t.prUrl||(info&&info.url)||'', info,
    files:typeof diffFiles==='function'?diffFiles(d):0, add:+d.additions||0, del:+d.deletions||0,
    frase:apFrase({ dids:rows.map(r=>r.did), msg:ev&&ev.type!=='test'?ev.text:'', objetivo:t.objective }),
    rows:rows.filter(r=>r.status!=='deferred'), adiados:rows.filter(r=>r.status==='deferred').length, gates, chips:apChips(gates, last?apRevName(last):'Revisor'), dec,
    rev:last?{ name:apRevName(last), verdict:last.verdict, items:last.items||[], round:last.round, n:rounds.filter(r=>r.verdict==='muda').length }:null,
    hasRev:typeof rvHasReviewer==='function'&&rvHasReviewer(t), imgs, after:apAoAprovar({ pr, epico:ep }), pode:pd.pode, quem:pd.quem, st:apStKey(t, dec), aprovavel:apAprovavel(t) };
}

// ---------------------------------------------------------------- o painel (HTML)
const AP_IC={
  check:'<path d="M3.4 8.4 6.5 11.4 12.6 4.8" stroke-linecap="round" stroke-linejoin="round"/>',
  x:'<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" stroke-linecap="round"/>',
  dot:'<circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/>',
  eye:'<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2"/>',
  shield:'<path d="M8 1.9l4.7 1.8v3.6c0 3.1-2.1 5.5-4.7 6.8-2.6-1.3-4.7-3.7-4.7-6.8V3.7z" stroke-linejoin="round"/>',
  code:'<path d="M5.6 4.6 2.4 8l3.2 3.4M10.4 4.6 13.6 8l-3.2 3.4" stroke-linecap="round" stroke-linejoin="round"/>',
  merge:'<circle cx="4.5" cy="3.6" r="1.5"/><circle cx="4.5" cy="12.4" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.1v5.8M4.5 5.6c0 2 1.6 2.4 5.5 2.4" stroke-linecap="round"/>',
  clock:'<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2 1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:'<path d="M8 2.3 14 13H2z" stroke-linejoin="round"/><path d="M8 6.4v3M8 11.2v.05" stroke-linecap="round"/>',
  msg:'<path d="M2.6 3.4h10.8v7.2H7.2L4.2 13v-2.4H2.6z" stroke-linejoin="round"/>',
  undo:'<path d="M5.6 3.6 2.6 6.6l3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.8 6.6h6.4a3.6 3.6 0 0 1 0 7.2H7" stroke-linecap="round"/>',
  spark:'<path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8 6.7 6.7z" stroke-linejoin="round"/>',
  send:'<path d="M2.4 8 13.6 2.6 10.6 13.4 7.6 9.2z" stroke-linejoin="round"/><path d="M7.6 9.2 13.6 2.6" stroke-linecap="round"/>',
  arrow:'<path d="M3 8h9.4M8.8 4.4 12.4 8l-3.6 3.6" stroke-linecap="round" stroke-linejoin="round"/>',
};
function apIc(k){ return `<svg class="apic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${AP_IC[k]||''}</svg>`; }
function apKbd(k){ return `<span class="apkbd" aria-hidden="true">${esc(k)}</span>`; }
function apShotsHtml(v, max){
  const L=v.imgs.slice(0, max);
  if(!L.length) return `<p class="apv-dim">Sem prints nesta tarefa${v.rows.some(r=>(r.evidence||[]).length)?' — as provas são testes e arquivos (na lista ao lado)':''}.</p>`;
  let miss=false;
  const h=L.map((n,i)=>{ const th=typeof artThumb==='function'?artThumb(v.id, n):null; if(!th) miss=true;
    return `<button type="button" class="apv-shot" data-ap="shot" data-i="${i}" aria-label="${escA('abrir o print '+n)}">${th?`<img src="${escA(th)}" alt="" loading="lazy">`:'<span class="apv-shotph" aria-hidden="true"></span>'}<span class="apv-cap mono">${esc(n.split('/').pop())}</span></button>`; }).join('');
  if(miss) setTimeout(apRefreshSoon, 500); // fora do Tauri a miniatura chega depois
  return `<div class="apv-shots">${h}</div>`;
}
function apReqsHtml(v){
  if(!v.rows.length) return `<p class="apv-dim">Esta tarefa não tem requisitos com prova${v.adiados?` (${v.adiados} adiado${v.adiados>1?'s':''} com motivo)`:''}.</p>`;
  return v.rows.map((r,i)=>{ const ok=r.st==='ok' && (r.evidence||[]).length;
    const e0=String((r.evidence||[])[0]||''), t0=(r.tests||[])[0];
    const evd=ok?(AP_IMG.test(e0)?'print · '+e0.split('/').pop():t0&&t0.name?'teste · '+t0.name:'prova · '+e0.split('/').pop()):(r.note?'sem prova · '+r.note:'sem prova');
    return `<div class="apv-rq"><span class="apv-rid mono">R${i+1}</span><span class="apv-rt">${esc(typeof mdPlain==='function'?mdPlain(r.text):r.text)}<span class="apv-evd mono">${esc(evd)}</span></span><span class="apv-stamp${ok?'':' no'}">${apIc(ok?'check':'x')}${ok?'PROVADO':'SEM PROVA'}</span></div>`; }).join('')
    +(v.adiados?`<p class="apv-dim">+ ${v.adiados} adiado${v.adiados>1?'s':''} com motivo</p>`:'');
}
function apRevHtml(v){
  if(!v.rev) return `<p class="apv-dim">${v.hasRev?'O revisor ainda não deu o veredito.':'Sem revisor nesta tarefa.'}</p>`;
  const ok=v.rev.verdict==='aprova', bad=v.rev.verdict==='muda', n=v.rev.items.length;
  const sp=v.t.spec||{}, ov=sp.reviewOverride&&sp.reviewOverride.reason;
  const ini=v.rev.name.slice(0,2).toUpperCase();
  const sub=ok?(n?`${n} observaç${n===1?'ão':'ões'}, não bloqueia`:'nada a apontar'):bad?`${n} problema${n===1?'':'s'}${v.rev.n>1?` · ${v.rev.n} rodadas`:''}`:'veredito ilegível';
  return `<div class="apv-nyx"><span class="apv-av" aria-hidden="true">${esc(ini)}</span><div><span class="apv-vd ${ok?'ok':bad?'bad':'wn'}">${esc(v.rev.name)} ${ok?'aprovou':bad?'pediu mudança':'deu veredito ilegível'}</span><span class="apv-dim"> · ${esc(sub)}</span>${n?`<ul>${v.rev.items.slice(0,6).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${ov?`<p class="apv-dim">Seguiu com motivo: “${esc(ov)}”</p>`:''}</div></div>`;
}
// a faixa de cima do rodapé: o aviso que manda (conflito / revisor / sem prova / bloqueado) ou "Ao aprovar: …"
function apAlertHtml(v){
  if(!v.aprovavel) return '';
  const d=v.dec;
  if(!v.pode) return `<div class="apv-after w">${apIc('clock')}<span><b>Quem aprova: ${esc(apWhoName(v.quem))}</b>${v.ep?' (pediu o épico)':' (pediu a demanda)'} ou o líder do time. Você vê as provas; a decisão é dele.</span></div>`;
  if(d.kind==='conflito') return `<div class="apv-after r">${apIc('alert')}<span><b>Ainda não dá pra integrar.</b> A branch conflita com a main${v.info&&v.info.baseRefName&&v.info.baseRefName!=='main'?' ('+esc(v.info.baseRefName)+')':''}: outra tarefa mudou as mesmas linhas. A IA resolve sozinha e os testes rodam de novo antes de voltar pra cá.</span></div>`;
  if(d.kind==='bloqueado') return `<div class="apv-after w">${apIc('clock')}<span><b>Ainda não dá pra aprovar.</b> ${esc(d.why)}</span></div>`;
  if(d.kind==='motivo'){
    const rv=d.precisa.includes('revisor'), pv=d.precisa.includes('prova');
    const parts=[]; if(rv) parts.push(`<b>O revisor pediu mudança${v.rev&&v.rev.n>1?' '+v.rev.n+' vezes':''}</b>${v.t.status==='needs-you'?' e a IA não conseguiu resolver sozinha':''}`);
    if(pv){ const m=v.rows.filter(r=>!(r.st==='ok'&&(r.evidence||[]).length)).length; parts.push(`<b>${m} requisito${m===1?'':'s'} sem prova</b>`); }
    return `<div class="apv-after r">${apIc('alert')}<span>${parts.join(' e ')}. Peça a alteração (já vem preenchida) ou aprove mesmo assim dizendo por quê.</span></div>`;
  }
  return `<div class="apv-after ${v.after.c}">${apIc(v.after.c?'clock':'merge')}<span><b>Ao aprovar:</b> ${v.after.h}</span></div>`;
}
function apFootHtml(v, mode){
  const id=escA(v.id), open=mode!=='task'?`<button type="button" class="btn ghost apv-open" data-ap="abrir" data-id="${id}">Abrir tarefa ${apKbd('↵')}</button>`:'';
  if(AP.pending && AP.pending.id===v.id){ const s=Math.max(0, Math.ceil((AP.pending.until-Date.now())/1000));
    return `<div class="apv-pend" role="status"><span class="apv-ring" aria-hidden="true"></span><span>Aprovada. ${v.pr?'Integrando o PR #'+esc(String(v.pr)):'Integrando'} em <b data-apcd>${s}</b> s…</span><span class="apv-sp"></span><button type="button" class="btn sm" data-ap="undo">${apIc('undo')}Desfazer ${apKbd('Z')}</button></div>`; }
  if(AP.busy[v.id]) return `<div class="apv-pend" role="status"><span class="apv-ring" aria-hidden="true"></span><span>${esc(AP.busy[v.id].tx||'aprovando…')}</span></div>`;
  if(AP.ok[v.id] || v.t.status==='merged'){ const o=AP.ok[v.id]; const hh=o?new Date(o.at).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' }):'';
    return `<div class="apv-pend ok">${apIc('check')}<span>${o?'Aprovada por você · ':''}${v.pr?'PR #'+esc(String(v.pr))+' integrado':'Integrada'} na main${hh?' às '+esc(hh):''}</span></div>`; }
  if(!v.aprovavel) return `<div class="apv-acts"><span class="apv-dim">${esc(['running','thinking','queued'].includes(v.t.status)||v.t.busy?'A IA ainda está trabalhando — as provas aparecem aqui quando ela terminar.':'Nada pra aprovar agora: '+(typeof stLabel==='function'?stLabel(v.st):v.st)+'.')}</span><span class="apv-sp"></span>${open}</div>`;
  const ui=AP.ui[v.id];
  if(ui && ui.mode==='ask'){
    const sug=apSugestoes(typeof rvRounds==='function'?rvRounds(v.t):[]);
    return `<div class="apv-ask"><label for="apTa-${id}" class="apv-askl">O que mudar na ${esc(v.code||'tarefa')}? <span class="apv-dim">vai pra Conversa da tarefa${v.who&&v.who!==apMe()?'; '+esc(apWhoName(v.who))+' vê o pedido':' e a IA volta a trabalhar nela'}</span></label>`
      +`<textarea id="apTa-${id}" class="apv-ta" rows="3" data-apta="ask" data-id="${id}" placeholder="Ex.: o aviso de juros precisa aparecer no celular">${esc(ui.prefill||'')}</textarea>`
      +`<div class="apv-sugs">${sug.map((x,i)=>`<button type="button" data-ap="sug" data-id="${id}" data-i="${i}" title="${escA(x)}">${esc(x.length>58?x.slice(0,56)+'…':x)}</button>`).join('')}</div>`
      +`<div class="apv-row"><button type="button" class="btn primary sm" data-ap="enviar" data-id="${id}">${apIc('send')}Mandar pra IA ${apKbd('⌘↵')}</button><button type="button" class="btn ghost sm" data-ap="cancelar" data-id="${id}">Cancelar ${apKbd('Esc')}</button></div></div>`;
  }
  if(ui && ui.mode==='why'){
    const rv=v.dec.precisa.includes('revisor');
    return `<div class="apv-ask"><label for="apTa-${id}" class="apv-askl">Aprovar mesmo ${rv?'com o revisor pedindo mudança':'sem a prova de todos os requisitos'}. Por quê? <span class="apv-dim">fica registrado no PR, na entrega e na Semana do time</span></label>`
      +`<textarea id="apTa-${id}" class="apv-ta" rows="2" data-apta="why" data-id="${id}" placeholder="Ex.: os R$ 0,02 viram uma tarefa separada; o aviso no celular já está na LOJA-27"></textarea>`
      +`<div class="apv-row"><button type="button" class="btn primary sm" data-ap="motivo" data-id="${id}">${apIc('check')}Aprovar com motivo ${apKbd('⌘↵')}</button><button type="button" class="btn ghost sm" data-ap="cancelar" data-id="${id}">Cancelar ${apKbd('Esc')}</button></div></div>`;
  }
  if(!v.pode) return `<div class="apv-acts"><span class="apv-dim">aprova: <b>${esc(apWhoName(v.quem))}</b></span><button type="button" class="btn sm" data-ap="pedir" data-id="${id}">${apIc('msg')}Pedir alteração ${apKbd('P')}</button><span class="apv-sp"></span>${open}</div>`;
  const d=v.dec; let prim;
  if(d.kind==='conflito') prim=`<button type="button" class="btn primary" data-ap="conflito" data-id="${id}">${apIc('spark')}Resolver conflito</button><button type="button" class="btn" disabled aria-disabled="true" title="Resolva o conflito primeiro">${apIc('check')}Aprovar</button>`;
  else if(d.kind==='motivo') prim=`<button type="button" class="btn primary" data-ap="pedir" data-id="${id}">${apIc('msg')}Pedir alteração ${apKbd('P')}</button><button type="button" class="btn" data-ap="aprovar" data-id="${id}">Aprovar mesmo assim… ${apKbd('A')}</button>`;
  else if(d.kind==='bloqueado') prim=`<button type="button" class="btn primary" data-ap="pedir" data-id="${id}">${apIc('msg')}Pedir alteração ${apKbd('P')}</button><button type="button" class="btn" disabled aria-disabled="true" title="${escA(d.why)}">${apIc('check')}Aprovar</button>`;
  else prim=`<button type="button" class="btn primary" data-ap="aprovar" data-id="${id}">${apIc('check')}Aprovar ${apKbd('A')}</button><button type="button" class="btn" data-ap="pedir" data-id="${id}">${apIc('msg')}Pedir alteração ${apKbd('P')}</button>`;
  return `<div class="apv-acts">${prim}<span class="apv-sp"></span>${open}</div>`;
}
/**
 * O PAINEL DE PROVAS — o mesmo na fila ('full'), na Central e no Meu trabalho ('compact') e na Revisão ⌘3 ('task').
 * Frase do que mudou · portões · requisitos com a prova de cada um · prints · veredito do revisor · arquivos (link pro
 * Código explicado) · "Ao aprovar: …" · rodapé (Aprovar / Pedir alteração / Abrir tarefa, ou o estado: integrando com
 * Desfazer, aprovada, campo de pedir alteração, motivo pra aprovar mesmo assim).
 */
function proofPanel(taskId, mode){
  mode=['full','compact','task'].includes(mode)?mode:'full';
  const t=apTaskOf(taskId);
  if(!t) return `<section class="apv apv-${mode}" data-proof="${escA(taskId)}" data-mode="${mode}"><p class="apv-dim apv-pad">Esta tarefa não está nesta máquina.</p></section>`;
  let v; try{ v=apVm(t); }catch(e){ console.error('painel de provas', e); return `<section class="apv apv-${mode}" data-proof="${escA(taskId)}" data-mode="${mode}"><p class="apv-dim apv-pad">Não consegui montar as provas desta tarefa.</p></section>`; }
  const cmp=mode==='compact';
  const meta=[`<span class="mono apv-code">${esc(v.code||'')}</span>`, v.who&&typeof personChip==='function'?personChip(v.who,{ short:true }):'<span>com você</span>',
    v.ep?`<span class="apv-ep">◆ ${esc(v.ep.nome)} · onda ${v.ep.onda}</span>`:'', v.pr&&v.prUrl?`<button type="button" class="lnk apv-pr" data-ap="pr" data-id="${escA(v.id)}">PR #${esc(String(v.pr))} ↗</button>`:'',
    v.files?`<span>${v.files} arquivo${v.files===1?'':'s'} · +${v.add} −${v.del}</span>`:''].filter(Boolean).join('');
  const head=`<div class="apv-h"><div class="apv-tt"><div class="apv-t">${esc(v.title)}</div><div class="apv-m">${meta}</div></div>${typeof stBadge==='function'?stBadge(v.st):''}</div>`;
  const chips=v.chips.length?`<div class="apv-gates" aria-label="Portões">${v.chips.map(c=>`<span class="apv-gate ${c.st}">${apIc(c.st==='ok'?'check':c.st==='run'?'dot':'x')}${esc(c.tx)}</span>`).join('')}</div>`:'';
  const sent=v.frase?`<div class="apv-sent"><span class="apv-lb">O que mudou, em uma frase</span>${esc(v.frase)}</div>`:'';
  const blk=(ic, h, body)=>`<div class="apv-blk"><h4>${apIc(ic)}${h}</h4>${body}</div>`;
  const reqs=blk('check','REQUISITOS E PROVAS', apReqsHtml(v));
  const shots=blk('eye','PRINTS', apShotsHtml(v, cmp?2:4));
  const rev=blk('shield','REVISOR', apRevHtml(v));
  const codeB=blk('code','CÓDIGO', `<p class="apv-codep">${v.files?`${v.files} arquivo${v.files===1?'':'s'} · +${v.add} −${v.del} · `:''}<button type="button" class="lnk" data-ap="codigo" data-id="${escA(v.id)}">ver no Código explicado</button></p>`);
  const revClean=v.rev && v.rev.verdict==='aprova' && !v.rev.items.length;
  const body=cmp
    ? `<div class="apv-b">${sent}${chips}<div class="apv-g2"><div class="apv-col">${reqs}</div><div class="apv-col">${shots}${revClean?'':rev}</div></div>${v.dec.kind!=='ok'||!v.pode?apAlertHtml(v):''}</div>`
    : `<div class="apv-b">${sent}${chips}<div class="apv-g2"><div class="apv-col">${reqs}${rev}</div><div class="apv-col">${shots}${codeB}</div></div>${apAlertHtml(v)}</div>`;
  return `<section class="apv apv-${mode}" data-proof="${escA(v.id)}" data-mode="${mode}" aria-label="${escA('Provas da '+(v.code||v.title))}">${head}${body}${apFootHtml(v, mode)}</section>`;
}
window.proofPanel=proofPanel;

// ---------------------------------------------------------------- APROVAR (uma ação)
async function apStLoad(id){
  if(typeof rvSt==='undefined') return;
  if(rvSt[id] && !rvSt[id].err) return;
  const j=await invokeQuiet('review_state_get',{ taskId:id }); let v=null; try{ v=j?JSON.parse(j):null; }catch(_){ v=null; }
  rvSt[id]={ acc:(v&&v.acc)||{}, out:(v&&v.out)||{} };
}
// aceita de uma vez os requisitos com prova (o MESMO review_state do "aceito este requisito" da Revisão por requisito);
// sem prova só entra com o motivo (o mesmo registro do "aceitar sem prova…")
async function apAceitarTodos(t, motivo){
  await apStLoad(t.id);
  const st=rvSt[t.id]; if(!st) return false;
  let ch=false;
  for(const r of (typeof reqRows==='function'?reqRows(t):[]).filter(r=>r.status!=='deferred')){
    const k=rvNorm(r.text); if(st.acc[k]) continue;
    const ok=r.st==='ok' && (r.evidence||[]).length;
    if(ok){ st.acc[k]={ at:Date.now(), sig:null, via:'aprovar' }; ch=true; }
    else if(motivo){ st.acc[k]={ at:Date.now(), sig:null, via:'aprovar', noProof:String(motivo).slice(0,400) }; ch=true; }
  }
  return ch ? rvStSave(t.id) : true;
}
// espera a janela "Preparando o PR" (21) terminar: ela é de quem decide se a verificação falhar
async function apEsperaPreparo(id){
  const t0=Date.now();
  while(typeof prepRunning!=='undefined' && prepRunning.has(id) && Date.now()-t0<15*60000) await new Promise(r=>setTimeout(r, 400));
}
function apBusy(id, tx){ if(tx) AP.busy[id]={ tx }; else delete AP.busy[id]; apRefresh(); }
/**
 * APROVAR — uma ação: portões → aceitar os requisitos com prova → abrir o PR se não houver → 4 s com Desfazer (Z) →
 * integrar na main → avisar a onda. Com o revisor pedindo mudança ou requisito sem prova, só com { motivo } (registrado).
 * Devolve uma Promise<boolean> (true = integrou; false = parou, desfeito ou recusado).
 */
async function aprovarTarefa(taskId, o){
  o=o||{};
  const t=apTaskOf(taskId); if(!t){ toast('Essa tarefa não está nesta máquina — abra o projeto dela pra aprovar.','warn'); return false; }
  if(AP.pending){ if(AP.pending.id!==taskId) toast(`Espere a ${apCode(apTaskOf(AP.pending.id)||{})||'tarefa anterior'} integrar (ou desfaça com Z) antes de aprovar outra.`,'info'); return false; }
  if(AP.busy[taskId]) return false;
  if(!apAprovavel(t)){ toast('Esta tarefa não está pronta pra aprovar agora.','info'); return false; }
  const pd=apPodeDe(t); if(!pd.pode){ toast(`Quem aprova esta tarefa é ${apWhoName(pd.quem)} (ou o líder do time).`,'warn'); return false; }
  if(typeof entregaNonCode==='function' && entregaNonCode(t)){ if(typeof approveGate==='function') approveGate(t); return false; } // documentos: o fim é salvar os entregáveis
  const motivo=String(o.motivo||'').trim();
  let info=null;
  apBusy(taskId, 'conferindo os portões…');
  try{
    await Promise.all([
      (typeof reqProofCache!=='undefined' && reqProofCache[t.id]===undefined && typeof loadReqProofs==='function')?loadReqProofs(t.id).catch(()=>{}):null,
      t.prUrl&&typeof loadPr==='function'?loadPr(t.id, true).catch(()=>{}):null,
      apStLoad(t.id).catch(()=>{}),
    ]);
    const dec=apDecide(apGates(t), { motivo });
    if(dec.kind==='conflito'){ toast(`A ${apCode(t)||'tarefa'} não pode ser aprovada: ${dec.why}.`,'warn'); return false; }
    if(dec.kind==='bloqueado'){ toast('Ainda não dá pra aprovar. '+dec.why,'warn'); return false; }
    if(dec.kind==='motivo'){
      if(motivo) toast('Escreva o motivo em uma frase (pelo menos 3 palavras): ele vai pro PR e pra entrega.','warn');
      AP.ui[taskId]={ mode:'why' }; AP.focus=taskId; return false; }
    // motivo registrado — o mesmo log do "aprovar mesmo assim" (checks_override_log) e o mesmo campo do ciclo (reviewOverride)
    if(dec.precisa.includes('prova') && typeof proofOverride==='function' && !await proofOverride(t, motivo)) return false;
    if(dec.precisa.includes('revisor')){
      const last=rvRounds(t).slice(-1)[0]||{ items:[] }, ov={ reason:motivo, at:Date.now(), kind:'aprovar' };
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ needsYou:null, reviewOverride:ov } });
      t.spec=Object.assign({}, t.spec||{}, { needsYou:null, reviewOverride:ov });
      invokeQuiet('checks_override_log',{ taskId:t.id, reason:'[revisor] '+motivo, fingerprint:'', failing:(last.items||[]).map(x=>'revisor: '+x) }).catch(()=>{});
    }
    apBusy(taskId, 'aceitando os requisitos com prova…');
    if(!await apAceitarTodos(t, dec.precisa.includes('prova')?motivo:'')) return false;
    info=apPrInfo(t);
    if(!(info && info.state==='OPEN')){
      apBusy(taskId, 'abrindo o PR…');
      await approveGate(t); // a porta única: verificação → push → PR (janela "Preparando o PR")
      await apEsperaPreparo(t.id);
      info=await loadPr(t.id, true).catch(()=>null);
      if(!(info && info.exists && info.state==='OPEN')){ toast('O PR ainda não abriu — termine na janela "Preparando o PR" e aprove de novo.','info'); return false; }
    }
    const why=typeof prMergeBlock==='function'?prMergeBlock(info):'';
    if(why){ toast('Não dá pra integrar agora. '+(typeof capFirst==='function'?capFirst(why):why),'warn'); return false; }
  }catch(e){ showErr(e, 'Não consegui aprovar'); return false; }
  finally{ delete AP.busy[taskId]; apRefresh(); }
  return apAgendar(t, info, motivo);
}
window.aprovarTarefa=aprovarTarefa;
function apAgendar(t, info, motivo){
  return new Promise(res=>{
    AP.ui[t.id]=null; AP.focus='';
    AP.pending={ id:t.id, until:Date.now()+AP_UNDO_MS, motivo, res, pr:(info&&info.number)||prNumOf(t) };
    AP.pending.timer=setTimeout(()=>apIntegrar(t.id), AP_UNDO_MS);
    clearInterval(AP.tick); AP.tick=setInterval(apTickCd, 250);
    toast(`Aprovada ${apCode(t)||apTitle(t).slice(0,40)}${motivo?' com motivo':''} · integrando em ${AP_UNDO_MS/1000} s`, 'ok', { label:'Desfazer (Z)', fn:()=>apDesfazer() });
    apRefresh();
  });
}
function apTickCd(){
  const p=AP.pending; if(!p){ clearInterval(AP.tick); AP.tick=null; return; }
  const s=String(Math.max(0, Math.ceil((p.until-Date.now())/1000)));
  document.querySelectorAll('[data-apcd]').forEach(el=>{ if(el.textContent!==s) el.textContent=s; });
}
/** Desfaz a aprovação na janela de 4 s (nada foi integrado). */
function apDesfazer(){
  const p=AP.pending; if(!p) return false;
  clearTimeout(p.timer); clearInterval(AP.tick); AP.tick=null; AP.pending=null;
  const t=apTaskOf(p.id);
  toast(`Desfeito: ${(t&&apCode(t))||'a tarefa'} voltou pra fila. Nada foi integrado.`,'info');
  try{ p.res(false); }catch(_){ }
  apRefresh(); return true;
}
window.apDesfazer=apDesfazer;
async function apIntegrar(id){
  const p=AP.pending; if(!p || p.id!==id) return;
  clearInterval(AP.tick); AP.tick=null; AP.pending=null;
  apBusy(id, 'integrando na main…');
  let ok=false;
  try{ ok=await mergePrRun(id); }catch(e){ showErr(e, 'Merge do PR falhou'); }
  delete AP.busy[id];
  if(ok){ AP.ok[id]={ at:Date.now(), pr:p.pr }; apDepoisDoMerge(id, p.pr); }
  try{ p.res(ok); }catch(_){ }
  apRefresh();
}
// a onda: se fechou, avisa (a aba do épico solta a próxima — regra #166/onda inteira) e acorda o início automático que já
// existe; se era a última, dispara a verificação final
function apDepoisDoMerge(id, pr){
  const t=apTaskOf(id)||{ id, title:'' };
  let msg=`${apCode(t)||apTitle(t).slice(0,40)} integrada na main${pr?' (PR #'+pr+')':''}`;
  const eid=t.epic&&t.epic.epicId;
  if(eid){
    const w=apWave(t);
    let items=[]; try{ items=(typeof epqEpicTasks==='function'?epqEpicTasks(eid):[]).map(x=>({ id:x.local||x.cloud, wave:x.wave, b:x.b })); }catch(_){ }
    if(!items.some(x=>x.id===id)) items.push({ id, wave:w, b:'ok' });
    const r=apOndaDepois(items, w, id);
    if(r.fechou){
      window.dispatchEvent(new CustomEvent('sf:epico-onda-fechada', { detail:{ epicId:eid, wave:w } }));
      if(r.ultima){ window.dispatchEvent(new CustomEvent('sf:epico-ultima-integrada', { detail:{ epicId:eid } })); msg+=' · era a última do épico: a verificação final começa'; }
      else { const cfg=(typeof window.apEpicoCfg==='function')?(window.apEpicoCfg(eid)||{}):{}; msg+=` · onda ${w} completa: a onda ${w+1} ${cfg.auto===false?'está liberada pra começar':'começa sozinha'}`;
        try{ if(typeof epicAutoStartTick==='function') epicAutoStartTick(); }catch(_){ } }
    }
  }
  toast(msg, 'ok');
}

// ---------------------------------------------------------------- PEDIR ALTERAÇÃO
/** Manda o pedido pra Conversa da tarefa (o mesmo caminho do "Pedir alteração": rqChangeText + fwSendText) e tira da fila. */
async function pedirAlteracao(taskId, texto){
  const t=apTaskOf(taskId); if(!t){ toast('Essa tarefa não está nesta máquina.','warn'); return false; }
  const g=typeof rqChangeGate==='function'?rqChangeGate(t):{ ok:true }; if(!g.ok){ toast(g.why,'warn'); return false; }
  const msg=typeof rqChangeText==='function'?rqChangeText({ text:texto, from:'app' }):String(texto||'').trim();
  if(!msg){ toast('Escreva o que mudar.','warn'); AP.focus=taskId; apRefresh(); return false; }
  apBusy(taskId, 'mandando o pedido pra IA…');
  let ok=false;
  try{ ok=await fwSendText(taskId, msg); }finally{ delete AP.busy[taskId]; }
  if(!ok){ apRefresh(); return false; }
  AP.gone[taskId]={ st:t.status, at:Date.now() }; AP.ui[taskId]=null; delete AP.draft[taskId]; AP.focus=''; if(AP.meuExp===taskId) AP.meuExp='';
  // avisa quem está com a tarefa (pelo nome) quando não é você
  const card=apCard(t), who=card&&card.assignee, me=apMe();
  if(card && who && who!==me && typeof sbPost==='function') sbPost('task_activity',{ task_id:card.id, user_id:me, kind:'comment', body:'Pediu alteração: '+String(texto||'').trim().slice(0,300) }).catch(()=>{});
  const l1=String(texto||'').trim().split('\n')[0];
  toast(`Pedido mandado pra Conversa da ${apCode(t)||'tarefa'}: “${l1.slice(0,48)}${l1.length>48?'…':''}” · ${who&&who!==me?apWhoName(who)+' foi avisado':'a IA volta a trabalhar'} · saiu da fila`,'ok');
  apRefresh(); return true;
}
window.pedirAlteracao=pedirAlteracao;

// ---------------------------------------------------------------- RESOLVER CONFLITO (fonte única)
/** A tarefa DESTA máquina conflita com a base? status 'conflict' ou o PR que o GitHub diz CONFLICTING (prCache). */
function conflitoDe(t){
  if(!t) return false;
  if(t.status==='conflict') return true;
  if(t._cross) return false; // outro projeto: o prCache é deste
  const pc=(typeof prCache!=='undefined' && prCache[t.id])||null;
  return !!(pc && pc.exists && pc.mergeable==='CONFLICTING' && !['MERGED','CLOSED'].includes(String(pc.state||'').toUpperCase()));
}
/** A base do PR da tarefa (o que o GitHub disse; senão o que a tarefa pediu; senão main). */
function conflitoBase(t){ const pc=(typeof prCache!=='undefined' && t && prCache[t.id])||null; return (pc&&pc.baseRefName)||(t&&(t.prBase||(t.spec&&t.spec.prBase)||t.base))||'main'; }
/** Manda o pedido de resolver o conflito pro terminal da tarefa. Sessão encerrada → reabre o terminal (o mesmo de abrir a tarefa). */
async function resolverConflito(taskId, btn){
  const t=apTaskOf(taskId);
  if(!t){ if(typeof crossRun==='function') return crossRun(taskId, ()=>resolverConflito(taskId)); toast('Essa tarefa não está nesta máquina.','warn'); return false; }
  if(AP.busy[taskId]) return false;
  const working=!!(t.busy || (typeof ACTIVE_ST!=='undefined' && ACTIVE_ST.has(t.status)) || t.status==='thinking');
  const orig=btn?btn.innerHTML:''; if(btn){ btn.disabled=true; btn.textContent='mandando…'; }
  apBusy(taskId, 'mandando o pedido de resolver o conflito…');
  let ok=false, reabriu=false;
  try{
    // terminal da tarefa: abre a aba no Terminal e, se a sessão foi encerrada, retoma o PTY ANTES de escrever
    if(typeof termViewOf==='function' && termViewOf(t) && typeof openWorkspace==='function'){
      const same=typeof fwTask!=='undefined' && fwTask===taskId && $id('fwOverlay') && $id('fwOverlay').style.display!=='none';
      if(!same) openWorkspace(taskId);
      // a aba vai pro Terminal (⌘1): a pessoa VÊ o pedido chegando na IA
      if(typeof fwMode!=='undefined' && fwMode!=='conversa'){ fwMode='conversa'; if(typeof fwRememberTab==='function') fwRememberTab(); if(typeof renderWorkspace==='function') renderWorkspace(); }
      const st=typeof TERM!=='undefined'?TERM[taskId]:null;
      if(!working && typeof termResume==='function' && !(st && st.alive)){ reabriu=true; try{ await termResume(taskId, { quiet:true, auto:true }); }catch(_){ } } // falhou: o talk_task retoma sozinho
    }
    ok=await fwSendText(taskId, conflitoPedido({ base:conflitoBase(t), branch:t.branch||'' }));
  }finally{ delete AP.busy[taskId]; if(btn && btn.isConnected && !ok){ btn.disabled=false; btn.innerHTML=orig; } }
  if(ok){
    const card=apCard(t), who=card&&card.assignee, me=apMe();
    if(card && who && who!==me && typeof sbPost==='function') sbPost('task_activity',{ task_id:card.id, user_id:me, kind:'comment', body:conflitoComentario(conflitoBase(t)) }).catch(()=>{});
    toast(conflitoAviso({ working, reabriu, code:apCode(t) }), 'ok');
  }
  apRefresh(); try{ lastSig=''; if(typeof render==='function') render(); }catch(_){ }
  return ok;
}
window.resolverConflito=resolverConflito; window.conflitoDe=conflitoDe; window.conflitoPedido=conflitoPedido;
/** Cartão de COLEGA com conflito: pede pra ele resolver — comentário no cartão (a atividade do time é o aviso). */
async function conflitoPedirA(ct, btn){
  if(!ct || !ct.assignee) return false;
  if(typeof personEnsure==='function') await personEnsure(ct.assignee);
  const nome=typeof personName==='function'?personName(ct.assignee,{ noYou:true, settled:true }):'';
  if(btn){ btn.disabled=true; btn.textContent='pedindo…'; }
  try{
    await sbPost('task_activity',{ task_id:ct.id, user_id:apMe(), kind:'comment', body:conflitoComentario((ct.spec||{}).prBase||(ct.spec||{}).base) });
    if(typeof teamFetchedAt!=='undefined') teamFetchedAt=0;
    toast(`Pedi a ${nome} pra resolver o conflito de “${String(ct.title||'').slice(0,50)}” — fica no cartão e ${nome} é avisado.`, 'ok');
    return true;
  }catch(e){ showErr(e, 'Não consegui pedir'); if(btn && btn.isConnected){ btn.disabled=false; btn.textContent=`Pedir a ${typeof personShort==='function'?personShort(ct.assignee,{ noYou:true }):nome} pra resolver`; } return false; }
}
/** Assumir e resolver: o cartão passa pra você (o colega é avisado) e uma tarefa NESTA máquina parte da branch do PR. */
async function conflitoAssumir(ct, btn){
  if(!ct || !ct.branch){ toast('Esse cartão não diz a branch do PR — peça pra quem está com ele resolver.','warn'); return false; }
  if(typeof personEnsure==='function') await personEnsure(ct.assignee);
  const nome=ct.assignee?personName(ct.assignee,{ noYou:true, settled:true }):'';
  if(!await askYes((nome?nome+' é avisado e o cartão passa pra você. ':'')+'Uma tarefa nesta máquina parte da branch do PR, traz a base, resolve o conflito, roda os testes e faz push no mesmo PR.', 'Assumir e resolver “'+String(ct.title||'').slice(0,50)+'”?')) return false;
  if(btn){ btn.disabled=true; btn.textContent='assumindo…'; }
  try{
    const me=apMe();
    if(ct.assignee!==me){ await cloudAssign(ct.id, me); ct.assignee=me; }
    sbPost('task_activity',{ task_id:ct.id, user_id:me, kind:'comment', body:'Assumiu pra resolver o conflito com a base.' }).catch(()=>{});
    const base=(ct.spec||{}).prBase||'main';
    const localId=await teamClaimStart(ct, null, { silent:true, payload:{ base:ct.branch, prBase:base, autoPr:'no', objective:conflitoPedido({ base, branch:ct.branch, pushTo:ct.branch }) } });
    if(localId && typeof openWorkspace==='function') openWorkspace(String(localId));
    toast(`Você assumiu “${String(ct.title||'').slice(0,50)}”: a IA resolve o conflito no terminal e faz push no mesmo PR.`, 'ok');
    return true;
  }catch(e){ showErr(e, 'Não deu pra assumir e resolver'); if(btn && btn.isConnected){ btn.disabled=false; btn.textContent='Assumir e resolver'; } return false; }
}
window.conflitoPedirA=conflitoPedirA; window.conflitoAssumir=conflitoAssumir;
// [data-fixconf] em qualquer tela (Central, épico, entregas, quadro): o mesmo resolverConflito
document.addEventListener('click', (e)=>{
  const b=e.target.closest && e.target.closest('[data-fixconf]'); if(!b || b.disabled) return;
  e.stopPropagation(); resolverConflito(b.dataset.fixconf, b);
});
function apPedirAbrir(id){
  const t=apTaskOf(id); if(!t || !apAprovavel(t)) return;
  const l=(typeof rvRounds==='function'?rvRounds(t):[]).slice(-1)[0];
  AP.ui[id]={ mode:'ask', prefill:l&&l.verdict==='muda'?(l.items||[]).join('\n'):'' }; AP.focus=id;
  if(AP.draft[id]==null && AP.ui[id].prefill) AP.draft[id]=AP.ui[id].prefill;
  apRefresh();
}
window.apPedirAbrir=apPedirAbrir;

// ---------------------------------------------------------------- abrir a tarefa numa etapa (Revisão = este painel)
function apAbrirTarefa(id, etapa){
  const t=apTaskOf(id); if(!t) return;
  etapa=etapa||'revisao';
  if(etapa==='revisao' && typeof rvViewM!=='undefined') rvViewM[id]='provas';
  const same=typeof fwTask!=='undefined' && fwTask===id && $id('fwOverlay') && $id('fwOverlay').style.display!=='none';
  if(!same) openWorkspace(id);
  const tab=(typeof tabById==='function')?tabById('task:'+id):null; if(tab) tab.mode=etapa;
  fwMode=etapa; if(typeof fwRememberTab==='function') fwRememberTab();
  renderWorkspace(); if(typeof teSync==='function') teSync();
}
window.apAbrirTarefa=apAbrirTarefa;
/** Revisão ⌘3, vista "Provas" (20-workspace chama): o mesmo painel, com a revisão por requisito a um clique. */
function apRenderTask(t, main){
  const html=`<div class="apv-task">${proofPanel(t.id, 'task')}<p class="apv-more">Quer ir fundo? <button type="button" class="lnk" data-ap="porreq" data-id="${escA(t.id)}">Revisar por requisito</button> (o trecho de cada requisito, aceitar um por um) ou <button type="button" class="lnk" data-ap="diff" data-id="${escA(t.id)}">ver o diff completo</button>.</p></div>`;
  if(main.__apHtml===html && main.querySelector('.apv-task')) return;
  main.innerHTML=html; main.__apHtml=html; main.__rvHtml='';
  apRestore(main);
}
window.apRenderTask=apRenderTask;

// ---------------------------------------------------------------- repintar
// o campo digitado não entra no HTML (o painel repinta sem apagar o rascunho nem o foco)
function apRestore(root){
  (root||document).querySelectorAll('[data-apta]').forEach(ta=>{ const id=ta.dataset.id;
    if(AP.draft[id]!=null && ta.value!==AP.draft[id]) ta.value=AP.draft[id];
    if(AP.focus===id && document.activeElement!==ta){ try{ ta.focus({ preventScroll:false }); const L=ta.value.length; ta.setSelectionRange(L, L); ta.scrollIntoView({ block:'nearest' }); }catch(_){ } } });
  (root||document).querySelectorAll('[data-proof]').forEach(el=>{ el.__aph=el.outerHTML; });
}
function apRefreshPanels(){
  document.querySelectorAll('[data-proof]').forEach(el=>{
    if(el.closest('#aprovarPage') || el.closest('#meuPage')) return; // essas páginas repintam inteiras (com guarda)
    const h=proofPanel(el.dataset.proof, el.dataset.mode);
    if(el.__aph===h) return;
    const tmp=document.createElement('div'); tmp.innerHTML=h; const n=tmp.firstElementChild; if(!n) return;
    el.replaceWith(n); apRestore(n.parentElement||document);
  });
}
function apRefresh(){
  apPaintFila(); apRefreshPanels(); apSideSync();
  try{ if(typeof semRepintar==='function') semRepintar(); }catch(_){ }
}
window.apRefresh=apRefresh;

// ---------------------------------------------------------------- a fila "Para aprovar" (aba, nunca modal)
if(typeof VIEW_META!=='undefined'){
  VIEW_META.aprovar={ title:'Para aprovar', icon:'<path d="M8 1.9l4.7 1.8v3.6c0 3.1-2.1 5.5-4.7 6.8-2.6-1.3-4.7-3.7-4.7-6.8V3.7z" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6L10.4 6.6" stroke-linecap="round" stroke-linejoin="round"/>' };
  VIEW_OVERLAY.aprovar='aprovarOverlay';
}
if(typeof SEM_NAV!=='undefined') SEM_NAV.aprovar='aprovarBtn'; // a lateral marca o item da aba aberta (76)
if(typeof viewOpen==='function' && !viewOpen.__ap){ const vo=viewOpen; viewOpen=function(kind){
    if(kind==='aprovar'){ const pg=$id('aprovarPage'); if(pg) pg.__html=''; apPaintFila(true); if(typeof ovShow==='function') ovShow('aprovarOverlay'); return; }
    return vo.apply(this, arguments); }; viewOpen.__ap=true; }
function apFilaAtiva(){ const t=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null; return !!(t && t.kind==='aprovar'); }
function apSelIdx(L){ const i=L.findIndex(t=>t.id===AP.selId); return i>=0?i:0; }
function apFilaHtml(){
  const L=apFila();
  const head=(sub)=>typeof semHead==='function'?semHead('Para aprovar', sub):`<header class="semhead"><div><h1>Para aprovar</h1><p class="semsub">${esc(sub)}</p></div></header>`;
  if(!L.length) return `<div class="sempg">${head('nada esperando você')}<div class="apq-vazio"><b>Fila vazia.</b><p>Quando a IA terminar uma tarefa com as provas, ela aparece aqui com tudo pra decidir sem abrir: o que mudou, a prova de cada requisito, os prints e o veredito do revisor.</p></div></div>`;
  const i=apSelIdx(L); AP.selId=L[i].id;
  const items=L.map((t,j)=>{ const v=apVm(t); const sel=j===i;
    const stx=AP.pending&&AP.pending.id===t.id?['ok','integrando…']:v.dec.kind==='conflito'?['bad','conflito']:v.dec.precisa.includes('revisor')?['bad','revisor pediu mudança']:v.dec.kind==='motivo'?['bad','falta prova']:v.dec.kind==='bloqueado'?['wn','ainda não dá']:['info',v.rows.length?`${v.rows.filter(r=>r.st==='ok'&&(r.evidence||[]).length).length}/${v.rows.length} provas`:'sem requisitos'];
    return `<button type="button" class="apq-i" role="option" aria-selected="${sel}" data-apsel="${escA(t.id)}"><span class="apq-t">${esc(v.title)}</span>${typeof personAv==='function'&&v.who?personAv(v.who,{ decor:true }):''}<span class="apq-m"><span class="mono">${esc(v.code||'')}</span>${v.ep?`<span>◆ onda ${v.ep.onda}</span>`:''}<span class="apq-s ${stx[0]}">${esc(stx[1])}</span>${v.pode?'':`<span class="apv-dim">aprova: ${esc(apWhoName(v.quem))}</span>`}</span></button>`; }).join('');
  const hint=`<div class="apq-hint"><span>${apKbd('J')}${apKbd('K')} troca</span><span>${apKbd('A')} aprova</span><span>${apKbd('P')} pede alteração</span><span>${apKbd('↵')} abre</span><span>${apKbd('Z')} desfaz</span></div>`;
  return `<div class="sempg apq-pg">${head(`${L.length} tarefa${L.length>1?'s':''} com provas prontas · a mais recente primeiro`)}<div class="apq"><div class="apq-l"><div class="apq-list" role="listbox" aria-label="Tarefas pra aprovar">${items}</div>${hint}</div><div class="apq-r">${proofPanel(L[i].id, 'full')}</div></div></div>`;
}
function apPaintFila(force){
  const pg=$id('aprovarPage'); if(!pg || (!force && !apFilaAtiva())) return;
  let html=''; try{ html=apFilaHtml(); }catch(e){ console.error('para aprovar', e); html=`<div class="sempg"><p>Não consegui montar a fila: ${esc(String(e&&e.message||e))}</p></div>`; }
  if(pg.__html===html) return;
  const sc=pg.scrollTop, ae=document.activeElement, sel=ae&&pg.contains(ae)&&ae.dataset?ae.dataset.apsel:'';
  pg.__html=html; pg.innerHTML=html; pg.scrollTop=sc;
  if(sel){ const b=pg.querySelector(`[data-apsel="${CSS.escape(AP.selId)}"]`); if(b) b.focus({ preventScroll:true }); }
  apRestore(pg);
}
let apSideSig='';
function apSideSync(){
  const n=(()=>{ try{ return apFilaCount(); }catch(_){ return 0; } })();
  const sig=String(n); if(sig===apSideSig) return; apSideSig=sig;
  const e=$id('aprovarCnt'); if(e){ e.hidden=!n; e.textContent=n>99?'99+':String(n||''); }
}
bindClick('aprovarBtn', ()=>openTab('aprovar'));
window.openParaAprovar=function(){ openTab('aprovar'); };
window.apAprovavel=apAprovavel; window.apFilaCount=apFilaCount;

// ---------------------------------------------------------------- Meu trabalho (76 chama): "A IA terminou…" com Aprovar e Ver provas
function apMeuEvento(x, meta){
  const t=x.local, v=apVm(t), id=t.id, tt=`<span class="tt">${esc(v.title)}</span>`;
  const ok=v.rows.filter(r=>r.st==='ok'&&(r.evidence||[]).length).length, n=v.rows.length;
  const espera=v.ep && !v.ep.ultima && !v.ep.mesmaOnda.length ? ` · a onda ${v.ep.onda+1} espera isso` : v.ep&&v.ep.ultima&&!v.ep.mesmaOnda.length?' · é a última do épico':'';
  let s;
  if(v.dec.kind==='conflito') s=`${tt} conflita com a main — a IA resolve se você pedir.`;
  else if(v.dec.precisa.includes('revisor')) s=`<b>O revisor</b> pediu mudança em ${tt}${v.rev&&v.rev.n>1?` (${v.rev.n} rodadas)`:''}.`;
  else s=`<b>A IA</b> terminou ${tt}${n?` com ${ok} de ${n} requisitos provados`:''}${espera}.`;
  const a=[];
  if(v.pode && v.dec.kind==='ok') a.push({ l:'Aprovar', pri:true, ap:'aprovar', act:()=>aprovarTarefa(id) });
  a.push({ l:AP.meuExp===id?'Esconder provas':'Ver provas', pri:!(v.pode&&v.dec.kind==='ok'), act:()=>{ AP.meuExp=AP.meuExp===id?'':id; AP.meuSel=id; apRefresh(); } });
  const m=[meta, v.ep?`◆ ${v.ep.nome} · onda ${v.ep.onda}`:'', v.rev?`${v.rev.name}: ${v.rev.verdict==='aprova'?'aprovou':v.rev.verdict==='muda'?'pediu mudança':'ilegível'}`:'', v.pode?'':'aprova: '+apWhoName(v.quem)].filter(Boolean).join(' · ');
  return { ms:apMod(t), av:'ia', s, m, a, tid:id };
}
window.apMeuEvento=apMeuEvento;
/** O painel compacto embaixo do evento aberto (76: meuHtml). */
function apMeuExpHtml(tid){ return AP.meuExp===tid?`<div class="mevx">${proofPanel(tid, 'compact')}</div>`:''; }
window.apMeuExpHtml=apMeuExpHtml;
function apMeuSel(){ return AP.meuSel; }
window.apMeuSel=apMeuSel;
// a fiação das páginas da Semana (76) devolve o rascunho e o foco do campo
if(typeof semWire==='function' && !semWire.__ap){ const w0=semWire; semWire=function(pg, k){ w0.apply(this, arguments); try{ if(k==='meu') apRestore(pg); }catch(_){ } }; semWire.__ap=true; }

// ---------------------------------------------------------------- cliques (delegação: vale pro painel em qualquer lugar)
document.addEventListener('click', (e)=>{
  const sel=e.target.closest && e.target.closest('[data-apsel]');
  if(sel){ AP.selId=sel.dataset.apsel; apPaintFila(); const b=document.querySelector(`#aprovarPage [data-apsel="${CSS.escape(AP.selId)}"]`); if(b) b.focus({ preventScroll:true }); return; }
  const b=e.target.closest && e.target.closest('[data-ap]'); if(!b) return;
  const panel=b.closest('[data-proof]'), id=b.dataset.id||(panel&&panel.dataset.proof)||'', k=b.dataset.ap;
  e.stopPropagation();
  if(k==='aprovar') return void aprovarTarefa(id);
  if(k==='motivo'){ const ta=document.getElementById('apTa-'+id); return void aprovarTarefa(id, { motivo:ta?ta.value:'' }); }
  if(k==='pedir') return apPedirAbrir(id);
  if(k==='enviar'){ const ta=document.getElementById('apTa-'+id); return void pedirAlteracao(id, ta?ta.value:''); }
  if(k==='cancelar'){ AP.ui[id]=null; AP.focus=''; apRefresh(); return; }
  if(k==='sug'){ const ta=document.getElementById('apTa-'+id); const tx=(b.getAttribute('title')||b.textContent||'').trim(); if(ta){ ta.value=(ta.value.trim()?ta.value.replace(/\s+$/,'')+'\n':'')+tx; AP.draft[id]=ta.value; ta.focus(); } return; }
  if(k==='undo') return void apDesfazer();
  if(k==='abrir') return apAbrirTarefa(id, 'revisao');
  if(k==='codigo') return apAbrirTarefa(id, 'codigo');
  if(k==='porreq'){ if(typeof rvViewM!=='undefined') rvViewM[id]='req'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace(); return; }
  if(k==='diff'){ if(typeof rvViewM!=='undefined') rvViewM[id]='diff'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace(); return; }
  if(k==='pr'){ const t=apTaskOf(id); if(t&&t.prUrl) openExternal(t.prUrl); return; }
  if(k==='conflito') return void resolverConflito(id, b);
  if(k==='shot'){ const t=apTaskOf(id); if(!t) return; const v=apVm(t); if(typeof lbOpen==='function') lbOpen(id, v.imgs, +b.dataset.i||0); return; }
});
// o campo do painel: o rascunho fica no estado (repintar não apaga); ⌘↵ manda, Esc fecha
document.addEventListener('input', (e)=>{ const ta=e.target; if(ta && ta.dataset && ta.dataset.apta){ AP.draft[ta.dataset.id]=ta.value; AP.focus=ta.dataset.id; } });
document.addEventListener('keydown', (e)=>{
  const ta=e.target; if(!ta || !ta.dataset || !ta.dataset.apta) return;
  const id=ta.dataset.id;
  if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); e.stopPropagation();
    if(ta.dataset.apta==='ask') pedirAlteracao(id, ta.value); else aprovarTarefa(id, { motivo:ta.value }); return; }
  if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); AP.ui[id]=null; AP.focus=''; apRefresh(); }
}, true);

// ---------------------------------------------------------------- teclado (J/K, A, P, ↵, Espaço, Z) — nunca dentro de campo nem do terminal
function apTyping(el){
  if(!el || !el.tagName) return false;
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  return !!(el.closest && el.closest('.xterm,[contenteditable="true"]'));
}
function apModalAberto(){ try{ return typeof escBusy==='function' && escBusy({ target:document.body }); }catch(_){ return false; } }
function apCtx(){
  const t=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null; if(!t) return '';
  if(t.kind==='aprovar') return 'fila';
  if(t.kind==='meu') return 'meu';
  if(t.kind==='task' && typeof fwMode!=='undefined' && fwMode==='revisao' && typeof rvViewOf==='function' && rvViewOf(t.taskId)==='provas') return 'task';
  return '';
}
function apMeuIds(){ return (typeof meuEvAtual!=='undefined'?meuEvAtual:[]).map(x=>x.tid).filter(Boolean); }
document.addEventListener('keydown', (e)=>{
  if(e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || apTyping(e.target) || apModalAberto()) return;
  const k=e.key.length===1?e.key.toLowerCase():e.key;
  if(k==='z' && AP.pending){ e.preventDefault(); apDesfazer(); return; }
  const c=apCtx(); if(!c) return;
  if(c==='fila'){
    const L=apFila(); if(!L.length) return; const i=apSelIdx(L), cur=L[i].id;
    if(k==='j'||k==='ArrowDown'||k==='k'||k==='ArrowUp'){ e.preventDefault(); AP.selId=L[apNav(L.length, i, (k==='k'||k==='ArrowUp')?-1:1)].id; apPaintFila(); const b=document.querySelector(`#aprovarPage [data-apsel="${CSS.escape(AP.selId)}"]`); if(b){ b.focus({ preventScroll:true }); b.scrollIntoView({ block:'nearest' }); } return; }
    if(k==='a'){ e.preventDefault(); aprovarTarefa(cur); return; }
    if(k==='p'){ e.preventDefault(); apPedirAbrir(cur); return; }
    if(k==='Enter' && !(e.target.closest && e.target.closest('button:not([data-apsel]),a'))){ e.preventDefault(); apAbrirTarefa(cur, 'revisao'); return; }
    return;
  }
  if(c==='meu'){
    const L=apMeuIds(); if(!L.length) return; let i=L.indexOf(AP.meuSel); if(i<0) i=0;
    if(k==='j'||k==='k'){ e.preventDefault(); AP.meuSel=L[apNav(L.length, i, k==='k'?-1:1)]; if(AP.meuExp) AP.meuExp=AP.meuSel; apRefresh(); const el=document.querySelector(`#meuPage [data-aptid="${CSS.escape(AP.meuSel)}"]`); if(el) el.scrollIntoView({ block:'nearest' }); return; }
    const cur=L[i];
    if(k===' ' && !(e.target.closest && e.target.closest('button,[role=button]'))){ e.preventDefault(); AP.meuSel=cur; AP.meuExp=AP.meuExp===cur?'':cur; apRefresh(); return; }
    if(k==='a'){ e.preventDefault(); AP.meuSel=cur; aprovarTarefa(cur); return; }
    if(k==='p'){ e.preventDefault(); AP.meuSel=cur; AP.meuExp=cur; apPedirAbrir(cur); return; }
    return;
  }
  if(c==='task'){ const id=fwTask;
    if(k==='a'){ e.preventDefault(); aprovarTarefa(id); return; }
    if(k==='p'){ e.preventDefault(); apPedirAbrir(id); return; }
  }
});

// ---------------------------------------------------------------- render: acompanha o estado (sem timer novo)
if(typeof render==='function' && !render.__ap){ const r0=render; render=function(){ const out=r0.apply(this, arguments);
    try{ apSideSync(); if(apFilaAtiva()) apPaintFila(); }catch(e){ console.error('para aprovar render', e); }
    return out; }; render.__ap=true; }
apSideSync();
