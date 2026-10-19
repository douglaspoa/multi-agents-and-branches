// Starfork — 81-epico-aba: a ABA DO ÉPICO redesenhada (mock aprovado pelo dono em 15/10 — epico-fluxo.md §3 D1–D10).
// Três camadas, de cima pra baixo:
//   1. a frase "agora" com a ÚNICA ação do momento (começar · ver provas e aprovar · liberar a onda · verificar · entregar);
//   2. o metrô: Onda 1 → … → Verificação final → Entregue, cada parada com o estado e de quem espera;
//   3. colunas por onda, um cartão por tarefa: quem faz (nome), o estado (STATUS_META) e o porquê da espera COM NOME
//      ("espera você aprovar LOJA-12", "espera LOJA-15 destravar (Bruno)").
// Ao lado: "Como o épico anda" (as 3 chaves, gravadas em spec.flow — 46: epFlowOf) e o "Pronto quando". Embaixo:
// "Parado agora" (cada coisa com o próximo passo) e "Para aprovar neste épico" (o painel de provas da outra frente,
// window.proofPanel, quando existe — senão a lista com "abrir a tarefa").
// Fim do épico: ao ouvir `sf:epico-ultima-integrada` {epicId} (quem aprova dispara) — ou pelo tick, quando todas as
// tarefas estão integradas — roda a VERIFICAÇÃO FINAL: uma tarefa da IA na main fresca que prova cada item do "pronto
// quando" (o mesmo pedido do autopilot.ts; o revisor marca com mcp__cardume__check_done_when e o 46 espelha na nuvem).
// Depois, "Entregar o épico" (⌘↵): grava spec.delivery, fecha o épico (done), gera o relatório (73: relGerar, recortado
// no épico) e avisa quem pediu (aviso na máquina dela, pelo teamEpics que já chega — sem consulta nova).
// Fontes únicas: status = epEffSt/taskSt/STATUS_META; portão das ondas = epFlowOf/epStrictOk (46); travada = entTravaTx
// (70); pessoa = personName/personAv (08); trocar quem faz = semMenu (76, teclas 1–9).

const EPA_IC={
  layers:'<path d="M8 2.4 14 5.6 8 8.8 2 5.6z" stroke-linejoin="round"/><path d="M2 8.4 8 11.6 14 8.4M2 11 8 14.2 14 11" stroke-linejoin="round"/>',
  play:'<path d="M5 3.4v9.2L12.4 8z" stroke-linejoin="round"/>',
  shield:'<path d="M8 1.9l4.7 1.8v3.6c0 3.1-2.1 5.5-4.7 6.8-2.6-1.3-4.7-3.7-4.7-6.8V3.7z" stroke-linejoin="round"/>',
  eye:'<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2"/>',
  alert:'<path d="M8 2.3 14 13H2z" stroke-linejoin="round"/><path d="M8 6.4v3M8 11.2v.05" stroke-linecap="round"/>',
  check:'<path d="M3.4 8.4 6.5 11.4 12.6 4.8" stroke-linecap="round" stroke-linejoin="round"/>',
  box:'<path d="M2.6 5 8 2.4 13.4 5v6L8 13.6 2.6 11z" stroke-linejoin="round"/><path d="M2.6 5 8 7.6 13.4 5M8 7.6v6" stroke-linejoin="round"/>',
  clock:'<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2 1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  gear:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8M4 4l1.3 1.3M10.7 10.7L12 12M12 4l-1.3 1.3M5.3 10.7L4 12" stroke-linecap="round"/>',
  lock:'<rect x="3.6" y="7.2" width="8.8" height="6.2" rx="1.4"/><path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8" stroke-linecap="round"/>',
  chev:'<path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  link:'<path d="M6.6 9.4 9.4 6.6M7.2 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.8 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1" stroke-linecap="round"/>',
  spark:'<path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8 6.7 6.7z" stroke-linejoin="round"/>',
  term:'<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M4.6 6.4 6.6 8l-2 1.6M8 10h3" stroke-linecap="round" stroke-linejoin="round"/>',
  dots:'<circle cx="3.6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r=".9" fill="currentColor" stroke="none"/>',
};
function epaIc(k, cls){ return `<svg class="epai${cls?' '+cls:''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${EPA_IC[k]||''}</svg>`; }

// @ep-aba-puro-inicio (puro: testado em app/tests/epico-aba.test.mjs)
const EPA_PL=(n, a, b)=>n+' '+(n===1?a:b);
// a tarefa numa palavra: done (integrada / concluída sem PR) · off (cancelada) · ready (pra aprovar) · stuck (parada,
// precisa de alguém) · run (IA trabalhando) · queue (ainda não começou). x: { st (status efetivo), flag, pr (PR aberto) }
function epaKind(x){
  const st=String(x&&x.st||'');
  if(st==='merged'||st==='done') return 'done';
  if(st==='cancelled'||st==='aborted') return 'off';
  if(x.flag==='closed'||st==='closed') return x.pr?'ready':'done';
  if(['error','conflict','needs-you','asking','blocked','plan-review','paused'].includes(st) || x.flag==='blocked') return 'stuck';
  if(['running','thinking','queued'].includes(st)) return 'run';
  if(['review','delivered','pr-open'].includes(st) || x.pr) return 'ready';
  return 'queue';
}
// a chave do STATUS_META que o cartão mostra (a fonte única dos rótulos e cores); null = sem selo (plano)
function epaKey(x, k, wait, begun){
  if(k==='done') return (x.st==='merged'||x.st==='done')?'merged':'closed';
  if(k==='off') return x.st;
  if(k==='ready') return 'review'; // PR aberto ou pronta: pra quem aprova é a mesma coisa (pra revisar)
  if(k==='stuck') return x.flag==='blocked'?'blocked':x.st;
  if(k==='run') return 'running';
  return wait?'waiting':begun?'backlog':null;
}
// "LOJA-12" ou o começo do título
function epaNm(x){ const c=String(x&&x.code||'').trim(); if(c) return c; const t=String(x&&x.title||'tarefa'); return '“'+(t.length>28?t.slice(0,27)+'…':t)+'”'; }
// a frase de espera COM NOME: quem segura e por quê (o 1º de maior peso; o resto vira "e mais N")
// apr = quem aprova ("você" ou o nome)
function epaWaitTx(blk, apr){
  const L=(blk||[]).slice(); if(!L.length) return '';
  const pe={ ready:0, stuck:1, off:2, run:3, queue:4 }; L.sort((a,b)=>(pe[a.k]??5)-(pe[b.k]??5));
  const y=L[0], who=y.whoName?' ('+y.whoName+')':'';
  const base=y.k==='ready'?`espera ${apr} aprovar ${epaNm(y)}`
    : y.k==='stuck'?`espera ${epaNm(y)} destravar${who}`
    : y.k==='off'?`espera ${epaNm(y)}, que foi cancelada`
    : `espera ${epaNm(y)} terminar${who}`;
  return base+(L.length>1?` e mais ${L.length-1}`:'');
}
// a frase curta de uma coisa parada ("LOJA-15 travou (Bruno)", "LOJA-26 tem conflito", "o revisor pediu mudança na LOJA-9")
function epaStuckTx(x){
  const n=epaNm(x), who=x.whoName?' ('+x.whoName+')':'';
  if(x.k==='off') return `${n} foi cancelada`;
  if(x.st==='conflict') return `${n} tem conflito`;
  if(x.st==='error') return `${n} parou com erro${who}`;
  if(x.st==='needs-you' && (x.nyKind==='rodadas'||x.nyKind==='veredito')) return `o revisor pediu mudança na ${n}`;
  if(x.st==='needs-you' && x.nyKind==='teto') return `${n} bateu no teto de custo${who}`;
  if(x.st==='asking') return `${n} tem pergunta${who}`;
  if(x.st==='plan-review') return `${n} tem plano pra aprovar${who}`;
  return `${n} travou${who}`;
}
// O MODELO da aba (sem DOM). o = {
//   items:[{ id, code, title, wave, after, st, flag, pr, who, whoName, reqOk, reqTot, at, stuckTx, nyKind, cloud, local }],
//   flow (46: epFlowOf), dw:[{ id, text, checkedBy }], delivered, apr ("você"|nome de quem aprova), meApr (sou eu),
//   req (nome de quem pediu), final:{ state:'running'|'' } }
function epaModel(o){
  o=o||{}; const flow=o.flow||{ strict:true, auto:true, released:1 };
  const items=(o.items||[]).map(x=>({ ...x, k:epaKind(x), wave:Math.max(1, parseInt(x.wave,10)||1) }));
  const byId={}; items.forEach(x=>{ byId[x.id]=x; if(x.cloud) byId[x.cloud]=x; if(x.local) byId[x.local]=x; });
  const waves=[...new Set(items.map(x=>x.wave))].sort((a,b)=>a-b);
  const begun=items.some(x=>x.k!=='queue') || !!o.begun;
  const okStrict=y=>y.k==='done', okDep=y=>y.k==='done'||y.k==='off';
  const apr=o.apr||'você';
  // quem segura cada tarefa que ainda não começou (o portão da chave "onda inteira" ou o `after` do #166)
  const blockers=x=>{
    if(x.k!=='queue') return [];
    if(flow.strict) return items.filter(y=>y.wave<x.wave && !okStrict(y));
    const af=(x.after||[]).map(a=>byId[a]).filter(y=>y && y!==x);
    if((x.after||[]).length) return af.filter(y=>!okDep(y));
    return items.filter(y=>y.wave<x.wave && !okDep(y));
  };
  const released=w=>flow.auto || w<=flow.released;
  const cards=items.map(x=>{
    const blk=blockers(x), held=begun && x.k==='queue' && (blk.length>0 || !released(x.wave));
    let why='', c='';
    if(x.k==='queue' && !begun){ const af=(x.after||[]).map(a=>byId[a]).filter(Boolean).map(epaNm);
      why=af.length?'depois de '+af.join(', '):(x.wave>1&&flow.strict?`depois da onda ${x.wave-1}`:'roda logo no começo'); }
    else if(x.k==='queue' && blk.length){ why=epaWaitTx(blk, apr); c='a'; }
    else if(x.k==='queue' && !released(x.wave)){ why=`pronta · espera ${apr} começar a onda ${x.wave}`; c='a'; }
    else if(x.k==='queue'){ why='pronta pra começar · começa sozinha'; }
    else if(x.k==='run'){ why=x.reqTot?`${x.reqOk||0} de ${x.reqTot} requisitos com prova`:'a IA está trabalhando'; }
    else if(x.k==='ready'){ why=`provas prontas · falta ${apr}`; c='b'; }
    else if(x.k==='done'){ why=(x.st==='merged'||x.st==='done')?('integrada'+(x.atTx?' '+x.atTx:'')):'concluída sem PR (nada pra integrar)'; c='g'; }
    else if(x.k==='stuck'){ why=x.stuckTx||epaStuckTx(x); c='r'; }
    else if(x.k==='off'){ why=flow.strict?'cancelada · segura a próxima onda':'cancelada'; c='r'; }
    return { ...x, key:epaKey(x, x.k, held, begun), why, whyC:c, lock:held, blk:blk.map(y=>y.id),
      bar:x.k==='run'&&x.reqTot?[x.reqOk||0, x.reqTot]:null };
  });
  const cw=w=>cards.filter(x=>x.wave===w);
  const waveState=w=>{ const L=cw(w);
    if(L.length && L.every(okStrict)) return 'feita';
    if(!begun) return 'plano';
    if(L.some(x=>x.k==='stuck' || (flow.strict && x.k==='off'))) return 'problema';
    if(L.some(x=>x.k==='run' || (x.k==='queue' && !x.lock))) return 'rodando';
    if(L.some(x=>x.k==='ready')) return 'aprovar';
    if(!flow.strict && L.every(okDep)) return 'feita';
    return 'aguarda'; };
  const W=waves.map(w=>{ const s=waveState(w), L=cw(w), prev=w>waves[0]?waves[waves.indexOf(w)-1]:0;
    const miss=prev?cards.filter(y=>y.wave===prev && !okStrict(y)).length:0, prevN=prev?cards.filter(y=>y.wave===prev).length:0;
    const n=L.length;
    const head=s==='plano'?(n===1?'1 tarefa roda sozinha':`${n} tarefas rodam juntas`)
      : s==='feita'?'aprovada e integrada'
      : s==='rodando'?'rodando'
      : s==='aprovar'?`esperando ${apr} aprovar`
      : s==='problema'?'tem algo parado'
      : (flow.strict&&miss)?`espera a onda ${prev} inteira: ${miss} de ${prevN} faltando`
      : L.some(x=>x.k==='queue'&&x.blk.length)?'espera as tarefas de que depende'
      : `pronta · espera ${apr} começar`;
    return { n:w, state:s, head, cards:L }; });
  const total=cards.length, integ=cards.filter(okStrict).length;
  const allDone=total>0 && cards.every(x=>okStrict(x) || (!flow.strict && x.k==='off'));
  const stuck=cards.filter(x=>x.k==='stuck' || (flow.strict && x.k==='off'));
  const ready=cards.filter(x=>x.k==='ready');
  const dw=(o.dw||[]).filter(Boolean), dwN=dw.length, dwOk=dw.filter(d=>d.checkedBy).length;
  const cur=W.find(w=>w.state!=='feita');
  const nextOf=w=>W[W.indexOf(w)+1]||null;
  const finalRun=!!(o.final&&o.final.state==='running') && dwOk<dwN;
  const pplN=new Set(cards.map(x=>x.who).filter(Boolean)).size;
  const toRelease=W.find(w=>w.cards.some(x=>x.k==='queue' && !x.blk.length && !released(w.n)));
  let phase='rodando';
  if(o.delivered) phase='entregue';
  else if(!total) phase='vazio';
  else if(!begun) phase='plano';
  else if(allDone) phase=(dwN && dwOk<dwN)?'verificar':'entregar';
  else if(stuck.length) phase='parado';
  else if(ready.length) phase='aprovar';
  else if(toRelease && !cards.some(x=>x.k==='run')) phase='liberar';
  // a frase "agora": s (frase), m (detalhe), tone (''|you|bad|ok), act ({ k, label, kbd }) — a única ação do momento
  const me=!!o.meApr, nm=(xs)=>xs.map(epaNm);
  const juntar=a=>a.length<=1?(a[0]||''):a.slice(0,-1).join(', ')+' e '+a[a.length-1];
  let ag={ s:'', m:'', tone:'', act:null };
  if(phase==='vazio') ag={ s:'Nenhuma tarefa neste épico ainda.', m:'Monte as tarefas pela Nova demanda (“montar com IA”) ou pelo Time.', tone:'', act:null };
  else if(phase==='plano'){ const w1=W[0], n1=w1?w1.cards.length:0;
    ag={ s:`Pronto para começar: ${EPA_PL(total,'tarefa','tarefas')} em ${EPA_PL(W.length,'onda','ondas')}, com ${EPA_PL(Math.max(1,pplN),'pessoa','pessoas')}.`,
      m:`A onda ${w1?w1.n:1} tem ${n1===1?'1 tarefa':n1+' tarefas que rodam juntas'}. `+(flow.strict?'Cada onda só começa quando a anterior estiver inteira aprovada e integrada.':'Cada tarefa começa quando as que ela depende estiverem integradas.'),
      tone:'', act:{ k:'start', label:`Começar a onda ${w1?w1.n:1}`, kbd:'⌘↵', ic:'play' } }; }
  else if(phase==='parado'){ const w=stuck[0].wave, nx=W.find(x=>x.n>w);
    ag={ s:`${stuck.length===1?'1 coisa parada':stuck.length+' coisas paradas'} na onda ${w}.`+(nx?` A onda ${nx.n} não começa até ${stuck.length===1?'ela se resolver':'as '+stuck.length+' se resolverem'}.`:''),
      m:stuck.slice(0,4).map(epaStuckTx).join(' · ')+(stuck.length>4?` · e mais ${stuck.length-4}`:''), tone:'bad', act:{ k:'parado', label:'Ver o que parou', kbd:'', ic:'alert' } }; }
  else if(phase==='aprovar'){ const w=ready[0].wave, wObj=W.find(x=>x.n===w), nx=wObj&&nextOf(wObj);
    const quem=nx?`A onda ${nx.n}`:'A verificação final';
    ag={ s:`${quem} está esperando ${apr} aprovar ${juntar(nm(ready.slice(0,3)))}${ready.length>3?' e mais '+(ready.length-3):''}.`,
      m:me?'As provas estão aqui embaixo, não precisa abrir a tarefa. Aprovar integra o PR e libera a próxima onda.':`${o.aprNome||apr} aprova (quem pediu o épico ou o líder do time). Você é avisado quando a próxima onda começar.`,
      tone:me?'you':'', act:me?{ k:'aprovar', label:'Ver provas e aprovar', kbd:'A', ic:'eye' }:null }; }
  else if(phase==='liberar'){ const w=toRelease.n;
    ag={ s:`A onda ${w} está pronta pra começar.`, m:'A chave “Começar a próxima onda sozinho” está desligada: a onda espera o clique de quem aprova.', tone:me?'you':'', act:me?{ k:'liberar', label:`Começar a onda ${w}`, kbd:'⌘↵', ic:'play', wave:w }:null }; }
  else if(phase==='verificar'){
    ag=finalRun?{ s:'Verificação final conferindo o “Pronto quando” na main.', m:`Todas as ${EPA_PL(total,'tarefa foi integrada','tarefas foram integradas')}. Ela marca ${dwN===1?'o D1':'D1…D'+dwN} com prova e chama ${apr} só para entregar.`, tone:'', act:null }
      :{ s:`Todas as tarefas foram integradas. Falta conferir o “Pronto quando”: ${dwOk} de ${dwN}.`, m:'A verificação final roda a main e marca cada item com prova (uma rodada de IA, dentro do teto).', tone:me?'you':'', act:me?{ k:'verificar', label:'Rodar a verificação final', kbd:'⌘↵', ic:'shield' }:null }; }
  else if(phase==='entregar'){
    ag={ s:(dwN?`Tudo aprovado e o “Pronto quando” foi conferido: ${dwOk} de ${dwN}.`:`Todas as ${EPA_PL(total,'tarefa foi integrada','tarefas foram integradas')}.`)+` Falta ${apr} entregar.`,
      m:`Entregar fecha o épico, gera o relatório e avisa ${o.reqMe?'o time':(o.req||'quem pediu')+', que pediu'}. Todo o código já está na main.`, tone:me?'you':'', act:me?{ k:'entregar', label:'Entregar o épico', kbd:'⌘↵', ic:'box' }:null }; }
  else if(phase==='entregue'){ const d=o.delivered||{};
    ag={ s:`Entregue ${d.quando||''}.`.replace(' .','.')+(o.reqMe?'':` ${o.req||'Quem pediu'} recebeu o aviso com o relatório.`),
      m:`${EPA_PL(total,'tarefa','tarefas')} · ${EPA_PL(d.prs!=null?d.prs:integ,'PR integrado','PRs integrados')} na main${dwN?` · Pronto quando ${dwOk}/${dwN}`:''} · aparece em Entregas`, tone:'ok', act:{ k:'entregas', label:'Ver em Entregas', kbd:'', ic:'' } }; }
  else { const runs=cur?cur.cards.filter(x=>x.k==='run'||x.k==='queue'):[], nx=cur&&nextOf(cur);
    const desc=runs.length===1?`${epaNm(runs[0])}${runs[0].whoName?' com '+runs[0].whoName:''}`:EPA_PL(runs.length||(cur?cur.cards.length:0),'tarefa','tarefas');
    ag={ s:`Onda ${cur?cur.n:1} rodando: ${desc}. Nada precisa de ${me?'você':'ninguém'} agora.`,
      m:nx?`A onda ${nx.n} começa quando ${juntar(nm((cur?cur.cards:[]).filter(x=>!okStrict(x)).slice(0,4)))} estiverem aprovadas e integradas.`:'Depois dela, a verificação final confere o “Pronto quando” sozinha e chama só para entregar.', tone:'', act:null }; }
  // o metrô: as ondas + verificação final + entregue
  const finalDone=allDone && (!dwN || dwOk===dwN);
  const metro=W.map(w=>({ lab:`Onda ${w.n}`, sub:w.state==='plano'?EPA_PL(w.cards.length,'tarefa','tarefas'):w.state==='feita'?'aprovada e integrada':w.state==='aguarda'?'esperando':w.state==='aprovar'?`esperando ${apr} aprovar`:w.state==='problema'?'tem algo parado':'rodando',
    cls:w.state==='feita'?'done':w.state==='aprovar'?'wait':w.state==='problema'?'bad':w.state==='rodando'?'cur':'' }));
  metro.push({ lab:'Verificação final', sub:!dwN?'sem “pronto quando”':finalDone?`Pronto quando: ${dwOk}/${dwN}`:finalRun?'conferindo':`confere ${dwN===1?'D1':'D1–D'+dwN}`, cls:finalDone?'done':finalRun||phase==='verificar'?'cur':'' });
  metro.push({ lab:'Entregue', sub:phase==='entregue'?((o.delivered||{}).quando||'entregue'):phase==='entregar'?`falta ${apr} entregar`:'—', cls:phase==='entregue'?'done':phase==='entregar'?'wait':'' });
  const lastW=W.length?W[W.length-1].n:1;
  const finalHead=!dwN?'sem “pronto quando”: entrega quando todas forem integradas':finalDone?`Pronto quando conferido: ${dwOk} de ${dwN}`:finalRun?'conferindo na main…':!begun?'IA confere o “Pronto quando” no fim':`espera a onda ${lastW} ser aprovada`;
  return { phase, agora:ag, waves:W, metro, cards, total, integ, stuck, ready, dwN, dwOk, begun, finalRun, finalDone, finalHead, pplN, allDone };
}
// o relatório curto do épico (texto puro pt-BR, pronto pra colar) — vai em spec.delivery.report e no "copiar relatório"
// o = { nome, req, apr, quando, itens:[{ code, title, who, pr }], dw:[{ id, text, evidence }] }
function epaRelatorioTx(o){
  o=o||{}; const L=o.itens||[], prs=L.filter(x=>x.pr).length;
  const out=[`Épico entregue: ${o.nome||'épico'}${o.quando?' · '+o.quando:''}`, `Pedido por ${o.req||'—'} · aprovado por ${o.apr||'—'} · ${EPA_PL(L.length,'tarefa','tarefas')}, ${EPA_PL(prs,'PR integrado','PRs integrados')} na main.`];
  if((o.dw||[]).length){ out.push('', 'Pronto quando:'); o.dw.forEach(d=>out.push(`• ${d.id}: ${d.text}${d.evidence?' — prova: '+d.evidence:''}`)); }
  if(L.length){ out.push('', 'Tarefas:'); L.forEach(x=>out.push(`• ${x.code?x.code+' · ':''}${x.title}${x.who?' — '+x.who:''}${x.pr?' (PR #'+x.pr+')':''}`)); }
  return out.join('\n');
}
// @ep-aba-puro-fim

// ===================== estado da aba (só UI desta máquina) =====================
const EPA={ sel:0, last:null, eid:'', cfgOpen:null };
const EPA_FINAL_VIVO=new Set(['draft','queued','running','thinking','plan-review','asking','needs-you','paused']); // verificação final ainda trabalhando
const epaMe=()=>(typeof cloudUserId==='function'&&cloudUserId())||'';
function epaNome(uid, cap){ const me=epaMe(); if(!uid) return ''; if(uid===me) return cap?'Você':'você'; return (typeof personShort==='function'?personShort(uid,{ noYou:true }):personName(uid,{ noYou:true }))||''; }
function epaAv(uid){ return uid && typeof personAv==='function' ? personAv(uid,{ decor:true }) : ''; }
// "sem time/local: você aprova"; com time: quem pediu o épico ou owner/admin (46: epCanCheck)
function epaPodeAprovar(ep){
  try{ if(!SB.sess() || !(typeof cloudEpicId==='function'&&cloudEpicId(ep.id))) return true; }catch(_){ return true; }
  return typeof epCanCheck==='function' ? epCanCheck(ep) : true;
}
// a tarefa LOCAL desta máquina pra um cartão (tmap / local_id)
function epaLocalOf(ct){
  const ts=(typeof state!=='undefined'&&state.tasks)||[]; if(!ct) return null;
  if(ct._local) return ts.find(x=>x.id===ct._local)||null;
  if(ct.local_id){ const t=ts.find(x=>x.id===ct.local_id); if(t) return t; }
  const m=(typeof tmap==='function')?tmap():{}; const lid=Object.keys(m).find(k=>m[k]===ct.id);
  return lid?(ts.find(x=>x.id===lid)||null):null;
}
function epaHora(ms){ if(!ms) return ''; const d=new Date(ms), hoje=new Date(); const hh=d.toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' });
  return d.toDateString()===hoje.toDateString()?'hoje às '+hh:'em '+d.toLocaleDateString('pt-BR',{ day:'2-digit', month:'2-digit' })+' '+hh; }
// cartões da nuvem + rascunhos locais (46 já juntou) → itens do modelo
function epaItems(ep, tasks){
  const me=epaMe();
  return (tasks||[]).map(t=>{
    const loc=!!t._local, lt=epaLocalOf(t), sp=t.spec||{}, st=epEffSt(t);
    const code=String(sp.issueCode||(lt&&(lt.issueCode||(lt.spec||{}).issueCode))||'').trim();
    const who=loc?me:(t.assignee||'');
    const rq=(!loc && typeof entReqs==='function')?entReqs(t):null;
    const reqTot=rq?rq.tot:((sp.requirements||(lt&&lt.requirements)||[]).length), reqOk=rq?rq.ok:0;
    let stuckTx=''; try{ if(!loc && typeof entTravaTx==='function') stuckTx=entTravaTx(t)||''; }catch(_){ }
    let nyKind=''; try{ const d=lt&&typeof cicloDecision==='function'?cicloDecision(lt):null; nyKind=d?d.kind:''; }catch(_){ }
    const at=(lt&&lt.finishedAt)||Date.parse(t.updated_at||'')||0;
    return { id:t.id, cloud:loc?null:t.id, local:lt?lt.id:(loc?t._local:null), code, title:(typeof mdTitle==='function'?mdTitle(t.title||''):t.title)||'tarefa',
      wave:Math.max(1, parseInt(sp.wave,10)||1), after:Array.isArray(sp.after)?sp.after:[], st, flag:t.flag||(lt&&lt.flag)||null, pr:epPrOpen(t),
      who, whoName:epaNome(who), reqOk, reqTot, at, atTx:epaHora(at), stuckTx, nyKind,
      covers:Array.isArray(sp.covers)?sp.covers:[], prUrl:t.pr_url||(lt&&lt.prUrl)||'', ct:loc?null:t, lt };
  });
}
function epaModelOf(ep, c, tasks){
  const sp=ep.spec||{}, me=epaMe(), pode=epaPodeAprovar(ep);
  const items=epaItems(ep, tasks);
  const req=ep.created_by?epaNome(ep.created_by):'', reqMe=!ep.created_by || ep.created_by===me;
  const dlv=sp.delivery||null;
  const delivered=dlv?{ quando:epaHora(Date.parse(dlv.at||'')||0), prs:dlv.prs }:(ep.status==='done'&&!sp.flow?{ quando:'' }:null);
  const finalLocal=epFinalLocalOf(ep.id), ft=finalLocal&&((typeof state!=='undefined'&&state.tasks)||[]).find(x=>x.id===finalLocal);
  // rodando = a tarefa da verificação está viva aqui · ou outra máquina (de quem aprova) pegou e ainda não marcou tudo
  const fc=sp.finalCheck||null, finalRunning=ft?EPA_FINAL_VIVO.has(ft.status):!!(fc && fc.state==='running' && fc.by && fc.by!==me);
  const aprNome=pode?'você':(ep.created_by?epaNome(ep.created_by):'quem pediu');
  const begun=items.some(x=>x.st!=='backlog'&&x.st!=='draft') || !!(sp.flow&&sp.flow.startedAt);
  return { m:epaModel({ items, flow:epFlowOf(sp), dw:Array.isArray(sp.doneWhen)?sp.doneWhen:[], delivered, apr:pode?'você':aprNome, aprNome, meApr:pode, req, reqMe, final:{ state:finalRunning?'running':'' }, begun }),
    items, pode, req, reqMe, aprNome, finalTask:ft||null, sp };
}

// ===================== render =====================
// chamado pelo 46 (epicPageRender) — devolve true quando desenhou
function epAbaRender(main, ep, c, tasks, locOnly){
  if(!main || !ep) return false;
  if(!c.loaded && !(c.tasks||[]).length && !(locOnly||[]).length){ main.innerHTML=`<div class="epa">${epaHeadHtml(ep, null)}${typeof skeletonHtml==='function'?skeletonHtml('lista',{ n:4, compact:true, inline:true, label:'carregando as tarefas do épico' }):''}</div>`; return true; }
  if(c.err && !(tasks||[]).length) return false; // erro de leitura: a página antiga já mostra o "tentar de novo"
  const R=epaModelOf(ep, c, tasks), M=R.m, sp=R.sp;
  if(EPA.eid!==ep.id){ EPA.eid=ep.id; EPA.sel=0; }
  EPA.last={ ep, c, tasks, R };
  const q=M.ready, selId=q.length?q[Math.min(EPA.sel, q.length-1)].id:'';
  const one=M.phase==='entregar'||M.phase==='entregue';
  const rule=`<div class="epa-rule">${epaIc('lock')}<span>${epFlowOf(sp).strict?'<b>Regra das ondas:</b> uma onda só começa quando <b>todas</b> as tarefas da anterior estiverem aprovadas e com o PR integrado na main. Concluir sem integrar, cancelar ou apagar uma tarefa não libera a próxima onda.':'<b>Regra das ondas:</b> cada tarefa começa quando as tarefas de que ela depende estiverem integradas na main (a chave “onda inteira” está desligada).'}</span></div>`;
  const html=`<div class="epa" data-phase="${escA(M.phase)}">${epaHeadHtml(ep, R)}${epaAgoraHtml(M)}${epaMetroHtml(M)}
    <div class="epa-grid${one?' one':''}"><div class="epa-col">${M.phase==='plano'?rule:''}${one?epaDwBigHtml(ep, R):''}${epaWavesHtml(ep, R)}${epaParadoHtml(R)}${epaQueueHtml(R, selId)}</div>
    <aside class="epa-side">${epaCfgHtml(ep, R)}${one?'':epaDwHtml(ep, R)}${M.phase==='plano'?`<p class="epa-note">Ao começar: as tarefas da onda 1 abrem com a IA de quem faz; as outras ficam na Semana do time com cadeado e o nome de quem elas esperam.</p>`:''}</aside></div></div>`;
  main.innerHTML=html;
  epaWire(main, ep, R);
  epaMountProofs(main, selId, R);
  { const h=$id('epicPageName'); if(h) h.textContent=ep.name||'Épico'; const s=$id('epicPageSub'); if(s) s.textContent=''; }
  return true;
}
window.epAbaRender=epAbaRender;
function epaProjName(tasks){
  const pid=((tasks||[]).find(t=>t&&t.project_id)||{}).project_id;
  const pj=pid&&(((typeof teamProj!=='undefined'&&teamProj)||{})[pid]||((typeof epQueue!=='undefined'&&epQueue.projOf)||{})[pid]);
  if(pj&&pj.name) return pj.name;
  return (typeof state!=='undefined'&&state.repo&&typeof pathBase==='function')?pathBase(state.repo):'';
}
function epaHeadHtml(ep, R){
  const me=epaMe();
  const req=ep.created_by?`pedido por <span class="epa-who">${epaAv(ep.created_by)}${esc(epaNome(ep.created_by, true))}</span>`:'';
  const apr=R?(R.pode?`<span class="epa-who">${epaAv(me)}Você</span>`:`<span class="epa-who">${epaAv(ep.created_by)}${esc(R.aprNome)}</span>`):'';
  const M=R&&R.m, pj=R?epaProjName((EPA.last&&EPA.last.tasks)||[]):'';
  const sub=[req, apr?'aprova: '+apr:'', pj?esc(pj):'', M?(M.begun||M.phase==='entregue'?`${M.integ} de ${M.total} tarefas integradas`:`${EPA_PL(M.total,'tarefa','tarefas')} em ${EPA_PL(M.waves.length,'onda','ondas')}`):''].filter(Boolean).join('<span class="epa-sep" aria-hidden="true">·</span>');
  return `<header class="epa-head"><div class="epa-ht"><div class="epa-eyebrow">${epaIc('layers')}ÉPICO</div><h1 class="epa-h1">${esc(ep.name||'Épico')}</h1>${sub?`<div class="epa-sub">${sub}</div>`:''}</div><span class="epa-sp"></span><button type="button" class="btn icon quiet" id="epicPageMore" aria-haspopup="menu" title="Mais ações" aria-label="Mais ações">${epaIc('dots')}</button></header>`;
}
function epaAgoraHtml(M){
  const a=M.agora, ic=M.phase==='plano'?'play':M.phase==='parado'?'alert':M.phase==='aprovar'?'shield':M.phase==='entregar'?'box':M.phase==='entregue'?'check':M.phase==='verificar'?'shield':M.phase==='liberar'?'play':'clock';
  const act=a.act?`<button type="button" class="btn ${a.act.k==='parado'||a.act.k==='entregas'?'':'primary'} epa-act" data-epact="${escA(a.act.k)}"${a.act.wave?` data-wave="${a.act.wave}"`:''}>${a.act.ic?epaIc(a.act.ic):''}${esc(a.act.label)}${a.act.kbd?` <span class="kbd">${esc(a.act.kbd)}</span>`:''}</button>`:'';
  const extra=M.phase==='entregue'?`<button type="button" class="btn quiet" data-epact="relatorio">${epaIc('link')}Relatório do épico</button>`:'';
  return `<section class="epa-agora${a.tone?' '+a.tone:''}" aria-live="polite" aria-label="Agora no épico"><span class="epa-agic${M.phase==='rodando'?' run':''}">${epaIc(ic)}</span><div class="epa-agt"><div class="s">${esc(a.s)}</div>${a.m?`<div class="m">${esc(a.m)}</div>`:''}</div>${act||extra?`<div class="epa-acts">${act}${extra}</div>`:''}</section>`;
}
function epaMetroHtml(M){
  return `<ol class="epa-metro" aria-label="Ondas do épico" style="--n:${M.metro.length}">${M.metro.map(s=>`<li class="st ${s.cls}"><b>${esc(s.lab)}</b><span>${esc(s.sub)}</span></li>`).join('')}</ol>`;
}
function epaChip(key, x){ if(!key) return ''; const m=stMeta(key); const lab=(m.short||m.pt||'');
  return `<span class="epa-chip" style="--stc:${m.c}" title="${escA(m.pt)}"><i aria-hidden="true"></i>${esc(lab.charAt(0).toUpperCase()+lab.slice(1))}</span>`; }
function epaCardHtml(x, R, selId){
  const plano=R.m.phase==='plano';
  const whoH=(plano && x.ct && R.pode)?`<button type="button" class="epa-whobtn" data-epawho="${escA(x.id)}" aria-haspopup="menu" title="Trocar quem faz (teclas 1–9 no menu)">${epaAv(x.who)}${esc(x.who?epaNome(x.who, true):'Sem dono')}${epaIc('chev')}</button>`
    : `<span class="epa-who">${x.who?epaAv(x.who)+esc(epaNome(x.who, true)):'<span class="dim">sem dono</span>'}</span>`;
  const sel=x.id===selId;
  return `<div class="epa-card${sel?' sel':''}" role="button" tabindex="0" data-epacard="${escA(x.id)}" aria-label="${escA((x.code?x.code+' · ':'')+x.title+' — '+(x.why||''))}"><div class="epa-ctop"><span class="code">${esc(x.code||'')}</span><span class="epa-sp"></span>${epaChip(x.key, x)}</div><div class="t">${esc(x.title)}</div>${x.bar?`<div class="epa-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${x.bar[1]}" aria-valuenow="${x.bar[0]}"><i style="width:${Math.round(x.bar[0]/x.bar[1]*100)}%"></i></div>`:''}${x.why?`<div class="why ${x.whyC}">${x.lock?epaIc('lock'):''}${esc(x.why)}</div>`:''}<div class="bot">${whoH}<span class="epa-sp"></span>${x.reqTot?`<span class="dim">${x.reqTot} req.</span>`:''}</div></div>`;
}
function epaWavesHtml(ep, R){
  const M=R.m, selId=M.ready.length?M.ready[Math.min(EPA.sel, M.ready.length-1)].id:'';
  const wv=M.waves.map(w=>`<section class="epa-wave ${w.state==='rodando'?'cur':w.state==='aprovar'?'wt':w.state==='problema'?'bd':''}" aria-label="Onda ${w.n}"><div class="wh"><b>Onda ${w.n}<span class="dim">${EPA_PL(w.cards.length,'tarefa','tarefas')}</span></b><div class="ws ${w.state==='feita'?'g':w.state==='aguarda'||w.state==='aprovar'?'a':w.state==='problema'?'r':w.state==='rodando'?'g':''}">${w.state==='feita'?epaIc('check'):w.state==='aguarda'?epaIc('lock'):''}${esc(w.head)}</div></div>${w.cards.map(x=>epaCardHtml(x, R, selId)).join('')}</section>`).join('');
  const ft=R.finalTask, nomes=ft&&Array.isArray(ft.roles)?ft.roles.map(r=>r&&r.name).filter(Boolean).slice(0,2):[];
  const fin=`<section class="epa-wave fin${M.finalRun?' cur':''}" aria-label="Verificação final"><div class="wh"><b>${epaIc('shield')}Verificação final</b><div class="ws${M.finalDone?' g':''}">${esc(M.finalHead)}</div></div>
    <div class="epa-card final"${ft?` role="button" tabindex="0" data-epafinal="${escA(ft.id)}"`:''}><div class="epa-ctop"><span class="epa-iaav" aria-hidden="true">${epaIc('spark')}</span><span class="fnm">${esc(nomes.length?nomes.map(n=>n.charAt(0).toUpperCase()+n.slice(1)).join(' + '):'IA do épico')}</span><span class="epa-sp"></span>${M.finalDone&&M.dwN?`<span class="epa-chip" style="--stc:${stColor('merged')}"><i aria-hidden="true"></i>Conferido</span>`:M.finalRun?epaChip('running'):''}</div><div class="why">Roda o app inteiro na main e marca ${M.dwN?(M.dwN===1?'o D1':'D1–D'+M.dwN):'o “pronto quando”'} com prova. Sem pessoa: é automático.</div></div></section>`;
  return `<div class="epa-waves" style="--c:${Math.min(4, M.waves.length+1)}">${wv}${fin}</div>`;
}
// "Parado agora": cada coisa com o próximo passo
function epaParadoHtml(R){
  const M=R.m, L=M.stuck; if(!L.length || M.phase==='plano') return '';
  const row=x=>{ let acts='';
    if(x.st==='conflict' && x.local) acts=`<button type="button" class="btn sm primary" data-fixconf="${escA(x.local)}" title="no terminal da tarefa: traz a base, resolve, roda os testes e faz push">${epaIc('spark')}Resolver conflito</button><button type="button" class="btn sm quiet" data-epaopen="${escA(x.id)}" data-step="codigo">Ver o conflito</button>`;
    else if(x.st==='conflict' && x.ct && x.who && x.who!==epaMe()) acts=`<button type="button" class="btn sm primary" data-epaaskfix="${escA(x.id)}" title="fica no cartão e a pessoa é avisada">${epaIc('spark')}Pedir a ${esc(epaNome(x.who, true))} pra resolver</button><button type="button" class="btn sm quiet" data-epaopen="${escA(x.id)}" data-step="conversa">Ver o que houve</button>`;
    else if(x.st==='needs-you' && (x.nyKind==='rodadas'||x.nyKind==='veredito')) acts=`<button type="button" class="btn sm" data-epaopen="${escA(x.id)}" data-step="revisao">${epaIc('eye')}Ver provas</button>`;
    else if(x.k==='off') acts=x.cloud&&R.pode?`<button type="button" class="btn sm" data-epaunlink="${escA(x.id)}" title="a tarefa sai do épico e a próxima onda deixa de esperar por ela">Tirar do épico</button>`:'';
    else acts=`<button type="button" class="btn sm" data-epaopen="${escA(x.id)}" data-step="conversa">${epaIc('term')}${!x.local?'Abrir a tarefa':x.st==='asking'?'Responder no terminal':'Abrir no terminal'}</button>${x.ct&&R.pode?`<button type="button" class="btn sm quiet" data-epawho="${escA(x.id)}" aria-haspopup="menu">Passar ${epaIc('chev')}</button>`:''}`;
    return `<div class="epa-ev"><span class="epa-evav">${x.who?epaAv(x.who):epaIc('alert')}</span><div class="epa-evt"><div class="s"><b>${esc(x.code||epaNm(x))}</b> ${esc(x.why)}</div><div class="m">${esc(x.whoName?epaNome(x.who, true):'sem dono')}${x.at?' · '+esc(typeof agoTx==='function'?'há '+agoTx(new Date(x.at).toISOString()):''):''}</div></div><div class="epa-evacts">${acts}</div></div>`; };
  // quem espera por elas (a próxima onda), com o nome — começa sozinho quando liberar
  const esperando=M.cards.filter(x=>x.lock && x.blk.some(b=>L.some(s=>s.id===b))).slice(0,4);
  const wrow=x=>`<div class="epa-ev wait"><span class="epa-evav">${x.who?epaAv(x.who):epaIc('lock')}</span><div class="epa-evt"><div class="s"><b>${esc(x.code||epaNm(x))}</b> ${esc(x.why)}.</div><div class="m">${x.whoName?esc(epaNome(x.who, true))+' · ':''}começa sozinha quando liberar</div></div></div>`;
  return `<section class="epa-sec" id="epaParado" aria-label="Parado agora"><div class="epa-sech"><h2>Parado agora</h2><span class="n">cada um com o próximo passo</span></div>${L.map(row).join('')}${esperando.map(wrow).join('')}</section>`;
}
// "Para aprovar neste épico": o painel de provas (outra frente: window.proofPanel(id,'compact')) — sem ele, a lista
function epaQueueHtml(R, selId){
  const M=R.m, q=M.ready; if(!q.length || M.phase==='plano') return '';
  const hint=R.pode?(typeof window.proofPanel==='function'?'J/K troca, A aprova, ↵ abre a tarefa':'J/K troca, ↵ abre a tarefa na Revisão'):`aprova: ${R.aprNome}`;
  const tabs=q.length>1?`<div class="epa-filters" role="tablist" aria-label="Tarefas para aprovar">${q.map(x=>`<button type="button" role="tab" aria-selected="${x.id===selId}" data-epasel="${escA(x.id)}">${esc(x.code||epaNm(x))} · ${esc(epaNome(x.who, true)||'sem dono')}</button>`).join('')}</div>`:'';
  const pp=typeof window.proofPanel==='function';
  const list=pp?`<div class="epa-proof" id="epaProof" data-id="${escA(selId)}"></div>`
    : q.map(x=>`<div class="epa-ev${x.id===selId?' sel':''}" data-epasel="${escA(x.id)}"><span class="epa-evav">${x.who?epaAv(x.who):''}</span><div class="epa-evt"><div class="s"><b>${esc(x.code||'')}</b> ${esc(x.title)}</div><div class="m">${x.reqTot?`${x.reqOk||0} de ${x.reqTot} requisitos com prova · `:''}${x.prUrl?'PR aberto · ':''}${esc(x.whoName?'com '+epaNome(x.who):'')}</div></div><div class="epa-evacts"><button type="button" class="btn sm${R.pode?' primary':''}" data-epaopen="${escA(x.id)}" data-step="revisao">${epaIc('eye')}Abrir a tarefa <span class="kbd">↵</span></button></div></div>`).join('');
  return `<section class="epa-sec" id="epaFila" aria-label="Para aprovar neste épico"><div class="epa-sech"><h2>Para aprovar neste épico</h2><span class="n">${q.length} · ${esc(hint)}</span></div>${tabs}${list}</section>`;
}
function epaMountProofs(main, selId, R){
  const box=main.querySelector('#epaProof'); if(!box || !selId) return;
  const x=R.m.ready.find(y=>y.id===selId); if(!x) return;
  try{ const out=window.proofPanel(x.local||x.cloud||x.id, 'compact'); if(out==null) return;
    if(typeof out==='string') box.innerHTML=out; else if(out instanceof Node) box.replaceChildren(out); }
  catch(e){ console.warn('painel de provas', e); box.innerHTML=''; }
}
// "Como o épico anda": as 3 chaves (quem aprova muda; os outros veem)
function epaCfgHtml(ep, R){
  const f=epFlowOf(R.sp), can=R.pode, plano=R.m.phase==='plano';
  if(R.m.phase==='entregue') return '';
  const rows=[['strict','Próxima onda só com a anterior integrada','recomendado; desligado, cada tarefa espera só as que ela depende'],['auto','Começar a próxima onda sozinho','desligado, a onda espera o clique de quem aprova'],['plan','Eu aprovo o plano de cada tarefa antes de rodar','desligado, a IA segue o plano do épico']];
  const body=rows.map(([k,t,s])=>`<label class="epa-cfgrow"><span class="t">${esc(t)}<span>${esc(s)}</span></span><input type="checkbox" role="switch" data-epacfg="${k}"${f[k]?' checked':''}${can?'':` disabled title="${escA('só '+R.aprNome+' (quem pediu o épico) ou o líder do time muda')}"`}><span class="epa-tgl" aria-hidden="true"></span></label>`).join('');
  const open=EPA.cfgOpen==null?plano:EPA.cfgOpen;
  return `<details class="epa-panel epa-cfg" id="epaCfg"${open?' open':''}><summary><h3>${epaIc('gear')}Como o épico anda</h3>${open?'':`<span class="dim">${f.strict?'onda inteira':'por dependência'} · ${f.auto?'sozinho':'no clique'}</span>`}</summary>${body}</details>`;
}
function epaDwVem(d, R){ const codes=R.items.filter(x=>(x.covers||[]).some(c=>String(c).toUpperCase()===String(d.id||'').toUpperCase())).map(x=>x.code||epaNm(x)); return codes.length?'vem de '+codes.join(', '):''; }
function epaDwHtml(ep, R){
  const dw=Array.isArray(R.sp.doneWhen)?R.sp.doneWhen:[], can=typeof epCanCheck==='function'?epCanCheck(ep):R.pode;
  if(!dw.length) return `<section class="epa-panel"><h3>${epaIc('check')}Pronto quando</h3><p class="d">sem critérios: o épico fica pronto pra entregar quando todas as tarefas forem integradas.</p>${can?`<button type="button" class="btn sm" id="epDwSet">definir pronto quando</button>`:''}</section>`;
  return `<section class="epa-panel"><h3>${epaIc('check')}Pronto quando</h3><p class="d">${R.m.dwOk===dw.length?`${dw.length} de ${dw.length} conferidos`:'o que o épico promete; conferido no fim pela verificação final'}</p>${dw.map((d,i)=>{ const v=epaDwVem(d, R);
    return `<label class="epa-dw${d.checkedBy?' ok':''}"><span class="id">${esc(d.id||('D'+(i+1)))}</span><span class="tx">${typeof mdInline==='function'?mdInline(d.text||''):esc(d.text||'')}${v||d.checkedBy?`<span class="by">${esc(v)}${v&&d.checkedBy?' · ':''}${d.checkedBy?'marcado por '+(typeof epWho==='function'?epWho(d.checkedBy):''):''}</span>`:''}</span>${d.checkedBy?`<span class="epa-stamp">${epaIc('check')}OK</span>`:`<span class="dim nx">a conferir</span>`}<input type="checkbox" class="sr-only" data-epdw="${i}"${d.checkedBy?' checked':''}${can?'':' disabled'} aria-label="${escA((d.id||'D'+(i+1))+' conferido')}"></label>`; }).join('')}</section>`;
}
function epaDwBigHtml(ep, R){
  const dw=Array.isArray(R.sp.doneWhen)?R.sp.doneWhen:[]; if(!dw.length) return '';
  return `<section class="epa-panel epa-dwbig" aria-label="Conferência do Pronto quando"><h3>${epaIc('check')}Conferência do “Pronto quando”<span class="dim">feita pela verificação final na main · ${R.m.phase==='entregue'?'entregue':'você só confere e entrega'}</span></h3><div class="epa-dwgrid">${dw.map((d,i)=>{ const v=epaDwVem(d, R);
    return `<div class="epa-dwc${d.checkedBy?'':' no'}"><div class="h"><span class="code">${esc(d.id||('D'+(i+1)))}</span>${d.checkedBy?`<span class="epa-stamp">${epaIc('check')}CONFERIDO</span>`:`<span class="epa-stamp no">A CONFERIR</span>`}</div><div class="t">${esc(d.text||'')}</div><div class="dim">${d.evidence?`prova: <span class="mono">${esc(String(d.evidence).slice(0,140))}</span><br>`:''}${esc(v)}</div></div>`; }).join('')}</div></section>`;
}

// ===================== ações =====================
function epaFind(id){ const L=EPA.last; return L?L.R.items.find(x=>x.id===id):null; }
function epaOpen(id, step){
  const x=epaFind(id); if(!x) return;
  if(x.local && typeof openWorkspace==='function'){ openWorkspace(x.local); if(step && step!=='conversa' && typeof teGo==='function') setTimeout(()=>teGo(step).catch(()=>{}), 250); return; }
  if(x.ct && window.openCloudTaskPage) openCloudTaskPage(x.ct);
}
function epaRerender(){ if(typeof epTab!=='undefined' && epTab && typeof epicPageRender==='function') epicPageRender(); }
async function epaReload(eid){ try{ await epicPageLoad(eid); }catch(_){ } if(epTab&&epTab.id===eid) epicPageRender(); }
// grava UMA chave do fluxo no spec FRESCO (outra pessoa pode ter mexido); sem nuvem, só na memória
async function epaFlowSet(ep, patch){
  let spec0=ep.spec||{}; try{ const f=(await sbGet('epics?select=spec&id=eq.'+ep.id))[0]; if(f&&f.spec) spec0=f.spec; }catch(_){ }
  const flow={ ...epFlowOf(spec0), ...((spec0&&spec0.flow)||{}), ...patch }; delete flow.set;
  const spec=(typeof linhaMesclaSpec==='function')?linhaMesclaSpec(spec0, 'flow', flow):{ ...spec0, flow };
  if(typeof cloudEpicId==='function' && cloudEpicId(ep.id) && SB.sess()) await epicPatch(ep, { spec });
  else { ep.spec=spec; const c=epCache[ep.id]; if(c&&c.ep) c.ep.spec=spec; epaRerender(); }
  if(typeof epQueue!=='undefined'){ epQueue.flowOf=epQueue.flowOf||{}; epQueue.flowOf[ep.id]=spec; }
  return spec;
}
async function epaStart(ep, btn){
  // começar grava as chaves escolhidas no plano (o tick das ondas lê daqui) e roda o "Iniciar épico" de sempre
  try{ if(!epFlowOf(ep.spec||{}).set || !((ep.spec||{}).flow||{}).startedAt) await epaFlowSet(ep, { startedAt:new Date().toISOString() }); }catch(e){ showErr(e, 'Não consegui gravar como o épico anda'); return; }
  if(typeof epicStart==='function') await epicStart(ep.id, btn);
}
async function epaRelease(ep, w){
  try{ await epaFlowSet(ep, { released:Math.max(w, epFlowOf(ep.spec||{}).released) }); toast(`Onda ${w} liberada — as tarefas dela começam nas máquinas de quem faz.`,'ok'); if(typeof epicAutoStartTick==='function') epicAutoStartTick(); }
  catch(e){ showErr(e, 'Não consegui liberar a onda'); }
}
async function epaUnlink(ep, id){
  const x=epaFind(id); if(!x||!x.cloud) return;
  if(!await askYes(`“${x.title}” sai do épico. A próxima onda deixa de esperar por ela.`, 'Tirar do épico?')) return;
  try{ await sbFetch('/rest/v1/tasks?id=eq.'+x.cloud, { method:'PATCH', body:JSON.stringify({ epic_id:null }) }); toast('Tirada do épico.','ok'); await epaReload(ep.id); }
  catch(e){ showErr(e, 'Não consegui tirar do épico'); }
}
function epaWho(anchor, id){
  const x=epaFind(id); if(!x||!x.ct||typeof semMenu!=='function') return;
  semMenu(anchor, { id:x.id, card:x.ct, code:x.code, titulo:x.title, who:x.who, local:x.lt||null });
}
async function epaAct(k, btn){
  const L=EPA.last; if(!L) return; const ep=L.ep;
  if(k==='start') return epaStart(ep, btn);
  if(k==='liberar') return epaRelease(ep, +(btn&&btn.dataset.wave)||1);
  if(k==='verificar') return epFinalRun(ep.id, { manual:true });
  if(k==='entregar') return epEntregar(ep, btn);
  if(k==='entregas'){ if(window.openTab) openTab('entregas'); return; }
  if(k==='relatorio') return epaRelatorio(ep, btn);
  if(k==='parado'){ const s=$id('epaParado'); if(s){ s.scrollIntoView(typeof scrollOpts==='function'?scrollOpts('start'):{ block:'start' }); const b=s.querySelector('button'); if(b) b.focus({ preventScroll:true }); } return; }
  if(k==='aprovar'){ const s=$id('epaFila'); if(s){ s.scrollIntoView(typeof scrollOpts==='function'?scrollOpts('start'):{ block:'start' }); const b=s.querySelector('[data-epaopen],button'); if(b) b.focus({ preventScroll:true }); } }
}
function epaSelect(id){ const L=EPA.last; if(!L) return; const i=L.R.m.ready.findIndex(x=>x.id===id); if(i<0) return; EPA.sel=i; epaRerender(); }
function epaWire(main, ep, R){
  main.querySelectorAll('[data-epact]').forEach(b=>b.onclick=()=>epaAct(b.dataset.epact, b));
  main.querySelectorAll('[data-epacard]').forEach(el=>{ el.onclick=e=>{ if(e.target.closest('[data-epawho]')) return; const x=epaFind(el.dataset.epacard); if(x&&x.k==='ready'&&R.m.phase!=='plano'){ epaSelect(x.id); const s=$id('epaFila'); if(s) s.scrollIntoView({ block:'nearest' }); return; } epaOpen(el.dataset.epacard, 'conversa'); };
    el.onkeydown=e=>{ if((e.key==='Enter'||e.key===' ')&&e.target===el){ e.preventDefault(); epaOpen(el.dataset.epacard, R.m.ready.some(x=>x.id===el.dataset.epacard)?'revisao':'conversa'); } }; });
  main.querySelectorAll('[data-epafinal]').forEach(el=>{ el.onclick=()=>{ if(typeof openWorkspace==='function') openWorkspace(el.dataset.epafinal); }; el.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); el.onclick(); } }; });
  main.querySelectorAll('[data-epawho]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); epaWho(b, b.dataset.epawho); });
  main.querySelectorAll('[data-epaopen]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); epaOpen(b.dataset.epaopen, b.dataset.step); });
  main.querySelectorAll('[data-epaaskfix]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); const x=epaFind(b.dataset.epaaskfix); if(x&&x.ct&&typeof conflitoPedirA==='function') conflitoPedirA(x.ct, b); });
  main.querySelectorAll('[data-epaunlink]').forEach(b=>b.onclick=()=>epaUnlink(ep, b.dataset.epaunlink));
  main.querySelectorAll('[data-epasel]').forEach(b=>b.onclick=e=>{ if(e.target.closest('[data-epaopen]')) return; epaSelect(b.dataset.epasel); });
  main.querySelectorAll('[data-epacfg]').forEach(cb=>cb.onchange=async()=>{ cb.disabled=true; try{ await epaFlowSet(ep, { [cb.dataset.epacfg]:cb.checked }); if(typeof epicAutoStartTick==='function') epicAutoStartTick(); }catch(e){ showErr(e, 'Não consegui salvar'); cb.checked=!cb.checked; } finally{ cb.disabled=false; } });
  { const d=main.querySelector('#epaCfg'); if(d) d.addEventListener('toggle', ()=>{ EPA.cfgOpen=d.open; }); }
  main.querySelectorAll('[data-epdw]').forEach(cb=>cb.onchange=()=>{ if(typeof epicToggleDone==='function') epicToggleDone(ep, +cb.dataset.epdw, cb.checked); });
  if(typeof bindClick==='function') bindClick('epDwSet', async ev=>{ const dw2=await epDoneWhenAsk(ev&&ev.currentTarget); if(!dw2||!dw2.length) return;
    let spec0=ep.spec||{}; try{ const f=(await sbGet('epics?select=spec&id=eq.'+ep.id))[0]; if(f&&f.spec) spec0=f.spec; }catch(_){ }
    try{ await epicPatch(ep, { spec:(typeof linhaMesclaSpec==='function'?linhaMesclaSpec(spec0,'doneWhen',dw2):{ ...spec0, doneWhen:dw2 }) }); toast('Pronto quando definido — '+dw2.length+' ite'+(dw2.length===1?'m':'ns')+'.','ok'); }catch(e){ showErr(e,'Não consegui salvar o pronto quando'); } });
  const sp=ep.spec||{};
  { const mb=main.querySelector('#epicPageMore'); if(mb && typeof g1Menu==='function') mb.onclick=()=>g1Menu(mb, [
      { label:'Atualizar', hint:'da nuvem', act:()=>epaReload(ep.id) },
      { label:'Abrir no Time', hint:'quadro do time', act:()=>{ lsSet('tmEpic', ep.id); if(typeof tmView!=='undefined'){ tmView='board'; lsSet('tmView','board'); } openTab('time'); } },
      ...((typeof epStartPlanOf==='function'&&epStartPlanOf(ep.id).canPause)?[{ label:'Pausar o épico', hint:'as na espera não começam mais', act:()=>epicPause(ep.id, null) }]:[]),
      ...(sp.issue&&sp.issue.url?[{ label:'Abrir a issue do épico', hint:sp.issue.code||'', act:()=>openExternal(sp.issue.url) }]:[]) ]); }
}
// teclas da aba do épico: ⌘↵ = a ação do momento; J/K troca o "para aprovar"; A aprova (quando o painel de provas existe)
// ou leva às provas; ↵ no cartão abre. Nada de letra solta em campo de texto, no terminal ou com um menu aberto.
document.addEventListener('keydown', e=>{
  const tab=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null;
  if(!tab || tab.kind!=='epic' || !EPA.last) return;
  const tg=e.target, typing=/^(INPUT|TEXTAREA|SELECT)$/.test((tg&&tg.tagName)||'') || !!(tg&&tg.isContentEditable) || !!(tg&&tg.closest&&tg.closest('.xterm'));
  if(typing || (typeof semPopEl!=='undefined'&&semPopEl) || document.getElementById('g1menu')) return;
  const M=EPA.last.R.m;
  if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ const a=M.agora.act; if(a && a.kbd==='⌘↵'){ e.preventDefault(); const b=document.querySelector('#epicPageMain [data-epact="'+a.k+'"]'); epaAct(a.k, b); } return; }
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  const q=M.ready; if(!q.length) return;
  if(e.key==='j'||e.key==='J'||e.key==='k'||e.key==='K'){ e.preventDefault(); EPA.sel=(Math.min(EPA.sel, q.length-1)+(e.key.toLowerCase()==='j'?1:q.length-1))%q.length; epaRerender(); return; }
  if((e.key==='a'||e.key==='A') && EPA.last.R.pode){ e.preventDefault(); const x=q[Math.min(EPA.sel, q.length-1)];
    if(typeof window.aprovarTarefa==='function') window.aprovarTarefa(x.local||x.cloud||x.id); else epaAct('aprovar'); return; }
  if(e.key==='Enter' && !(tg&&tg.closest&&tg.closest('button,[role="button"],a'))){ e.preventDefault(); const x=q[Math.min(EPA.sel, q.length-1)]; epaOpen(x.id, 'revisao'); }
});
// as 3 chaves do épico pra frente "aprovar" (80: toast "a onda N começa sozinha / está liberada")
window.apEpicoCfg=function(eid){ const f=epFlowFor(eid); return { auto:f.auto, strict:f.strict, plan:f.plan }; };
// a onda fechou (80 integrou a última dela): a próxima começa já (sem esperar o tick de 20 s) e a aba relê
window.addEventListener('sf:epico-onda-fechada', e=>{ const d=(e&&e.detail)||{}; if(typeof epicAutoStartTick==='function') epicAutoStartTick(); if(epTab && (!d.epicId || epTab.id===d.epicId)) epaReload(epTab.id); });
// a pessoa da tarefa mudou pelo menu (76: semMenu) → a aba relê
window.addEventListener('sf:responsavel-mudou', ()=>{ if(epTab) epaReload(epTab.id); });

// ===================== verificação final =====================
// id da tarefa LOCAL que é a verificação final deste épico (por épico, nesta máquina) — o 46 tira ela das ondas
function epFinalLocalOf(eid){ if(!eid) return ''; try{ return lsGet('ep:final:'+eid)||((((epCache[eid]||{}).ep||{}).spec||{}).finalCheck||{}).localId||''; }catch(_){ return ''; } }
window.epFinalLocalOf=epFinalLocalOf;
// o pedido pra IA: o MESMO do autopilot.ts (verificação final do piloto), na main fresca, sem PR
function epFinalPayload(ep){
  const sp=ep.spec||{}, dw=(Array.isArray(sp.doneWhen)?sp.doneWhen:[]).filter(Boolean);
  return { workflow:null, agents:null, engine:typeof defaultAiEngine==='function'?defaultAiEngine():'claude', approval:'auto', owns:null, off:null,
    title:('Verificação final · '+(ep.name||'épico')).slice(0,120),
    objective:`VERIFICAÇÃO FINAL DO ÉPICO "${ep.name||'épico'}": rode o app a partir desta branch (igual à main, com tudo que foi integrado) seguindo o README.md e PROVE cada item do "pronto quando" com evidência real (teste rodado, tela vista, comando executado). Pode corrigir pequenos problemas que impeçam a prova; não implemente funcionalidades novas.`,
    deliverables:['Cada item do "pronto quando" provado na main'], requirements:dw.map((d,i)=>(d.id||'D'+(i+1))+': '+d.text), verify:'todos os itens do "pronto quando" provados no app rodando',
    doc:null, proof:true, tests:true, autoPr:'no', prBase:null, planApproval:'auto', refs:[], branchType:'chore', issue:null, base:null, linkedTo:null,
    epicId:ep.id, epicDoneWhen:dw.map((d,i)=>({ id:d.id||'D'+(i+1), text:d.text })), start:true };
}
const epFinalBusy=new Set(), epFinalWarned=new Set();
// roda a verificação final do épico (uma vez): só quem aprova, só com todas integradas e algo do "pronto quando" a conferir
async function epFinalRun(eid, o){
  o=o||{}; if(!eid || epFinalBusy.has(eid)) return;
  epFinalBusy.add(eid);
  try{
    let ep=((epCache[eid]||{}).ep)||((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===eid);
    try{ const f=(await sbGet('epics?select=*&id=eq.'+eid))[0]; if(f) ep={ ...(ep||{}), ...f }; }catch(_){ }
    if(!ep) return;
    const sp=ep.spec||{}, dw=(Array.isArray(sp.doneWhen)?sp.doneWhen:[]).filter(Boolean);
    if(sp.delivery || !dw.length || dw.every(d=>d.checkedBy)) return; // nada a conferir
    if(!epaPodeAprovar(ep)) return; // roda na máquina de quem aprova
    const fl=epFinalLocalOf(eid), ft=fl&&((state.tasks||[]).find(x=>x.id===fl));
    if(ft && EPA_FINAL_VIVO.has(ft.status)){ if(o.manual && typeof openWorkspace==='function') openWorkspace(ft.id); return; } // já rodando: só mostra (terminou sem provar tudo: roda de novo)
    if(sp.finalCheck && sp.finalCheck.state==='running' && sp.finalCheck.by && sp.finalCheck.by!==epaMe() && !o.manual) return; // outra máquina (o líder) já pegou
    // todas integradas? (a mesma regra da aba)
    let tasks=null; try{ tasks=await sbGet('tasks?select=*&epic_id=eq.'+eid+'&order=created_at'); }catch(_){ }
    if(Array.isArray(tasks)){ const M=epaModel({ items:epaItems(ep, tasks), flow:epFlowOf(sp), dw }).allDone; if(!M){ if(o.manual) toast('Ainda há tarefa do épico sem integrar — a verificação final roda depois da última.','warn'); return; } }
    // o projeto do épico precisa estar aberto aqui (a tarefa nasce no repositório aberto)
    const pid=(tasks||[]).map(t=>t.project_id).find(Boolean);
    if(pid){ const pj=await epProjOf({ project_id:pid }); const here=await repoRemoteIds().catch(()=>({}));
      if(pj && pj.repo_remote && !(here.remote && remoteSame(pj.repo_remote, here))){ if(!epFinalWarned.has(eid)||o.manual){ epFinalWarned.add(eid); toast(`A verificação final de “${ep.name}” roda no projeto ${pj.name||pj.repo_remote} — abra ele que ela começa.`,'warn'); } return; } }
    // automática (decisão do dono): sem pergunta — uma rodada de IA, dentro do teto de sempre (budgetApply)
    const payload=epFinalPayload(ep);
    if(typeof epicAttachRef==='function') await epicAttachRef(payload, eid, null);
    const nid=await invoke('new_task', typeof trkBeforeNewTask==='function'?await trkBeforeNewTask(payload):payload);
    if(typeof budgetApply==='function') await budgetApply(nid).catch(()=>{});
    lsSet('ep:final:'+eid, String(nid));
    // marca na nuvem que a verificação está com esta máquina (as outras não rodam de novo); spec FRESCO lido acima
    try{ const spec={ ...sp, flow:sp.flow||{ strict:true, auto:true }, finalCheck:{ state:'running', by:epaMe(), localId:String(nid), at:new Date().toISOString() } };
      if(cloudEpicId(eid) && SB.sess()) await sbFetch('/rest/v1/epics?id=eq.'+eid, { method:'PATCH', body:JSON.stringify({ spec, updated_at:new Date().toISOString() }) });
      const c=epCache[eid]; if(c&&c.ep) c.ep.spec=spec; }catch(e){ console.warn('verificação final: não marquei na nuvem', e); }
    toast(`Verificação final de “${ep.name}” começou — ela marca o “pronto quando” com prova e te chama pra entregar.`,'ok');
    lastSig=''; refresh().catch(()=>{}); if(epTab&&epTab.id===eid) epaReload(eid);
  }catch(e){ showErr(e, 'Não consegui rodar a verificação final'); }
  finally{ epFinalBusy.delete(eid); }
}
window.epFinalRun=epFinalRun;
// quem aprova integrou a última tarefa (outra frente dispara) → verificação final, sem esperar o tick
function epFinalOnEvent(e){ const d=(e&&e.detail)||{}; if(d.epicId) setTimeout(()=>epFinalRun(d.epicId), 1500); }
window.addEventListener('sf:epico-ultima-integrada', epFinalOnEvent);
document.addEventListener('sf:epico-ultima-integrada', epFinalOnEvent);
// e pelo tick: épico aberto (ou na fila dos épicos) com todas integradas e "pronto quando" pendente
const epFinalSeen=new Set();
function epFinalTick(){
  const ids=new Set(); Object.keys(epCache).forEach(k=>{ if(epCache[k]&&epCache[k].loaded) ids.add(k); });
  Object.keys((typeof epQueue!=='undefined'&&epQueue.sibsOf)||{}).forEach(k=>ids.add(k));
  ids.forEach(eid=>{
    const c=epCache[eid], ep=(c&&c.ep)||((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===eid); if(!ep) return;
    const sp=ep.spec||{}, dw=(Array.isArray(sp.doneWhen)?sp.doneWhen:[]).filter(Boolean);
    if(!sp.flow || sp.delivery || !dw.length || dw.every(d=>d.checkedBy) || sp.finalCheck || epFinalSeen.has(eid)) return;
    const ts=(c&&c.loaded&&c.tasks)||((epQueue.sibsOf||{})[eid])||[]; if(!ts.length) return;
    if(!epaModel({ items:epaItems(ep, ts), flow:epFlowOf(sp), dw }).allDone) return;
    epFinalSeen.add(eid); epFinalRun(eid);
  });
}
if(typeof tickLoop==='function') tickLoop('epFinal', ()=>{ try{ epFinalTick(); }catch(e){ if(typeof tickErr==='function') tickErr('epFinal', e); } }, 30000, 8000);

// ===================== entregar o épico =====================
async function epEntregar(ep, btn){
  const L=EPA.last; if(!L||!epaPodeAprovar(ep)) return;
  if(btn){ btn.disabled=true; btn.setAttribute('aria-busy','true'); }
  try{
    let spec0=ep.spec||{}; try{ const f=(await sbGet('epics?select=spec,status&id=eq.'+ep.id))[0]; if(f&&f.spec) spec0=f.spec; }catch(_){ }
    if(spec0.delivery){ toast('Este épico já foi entregue.','info'); return; }
    const R=L.R, me=epaMe(), nowIso=new Date().toISOString();
    const prN=u=>{ const m=String(u||'').match(/\/pull\/(\d+)/); return m?m[1]:''; };
    const itens=R.items.filter(x=>epaKind(x)==='done').map(x=>({ code:x.code, title:x.title, who:x.who?epaNome(x.who, true).replace(/^Você$/,personName(me,{ noYou:true })):'', pr:prN(x.prUrl) }));
    const dw=(Array.isArray(spec0.doneWhen)?spec0.doneWhen:[]).map((d,i)=>({ id:d.id||'D'+(i+1), text:d.text||'', evidence:d.evidence||'' }));
    const report=epaRelatorioTx({ nome:ep.name, req:ep.created_by?personName(ep.created_by,{ noYou:true }):'', apr:personName(me,{ noYou:true }), quando:new Date().toLocaleString('pt-BR',{ day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }), itens, dw });
    const delivery={ at:nowIso, by:me, tasks:R.items.length, prs:itens.filter(x=>x.pr).length, dwOk:dw.filter((d,i)=>(spec0.doneWhen[i]||{}).checkedBy).length, dwN:dw.length, report:report.slice(0,4000) };
    const spec={ ...spec0, delivery, flow:{ ...((spec0.flow)||{}), deliveredAt:nowIso } };
    if(cloudEpicId(ep.id) && SB.sess()) await epicPatch(ep, { spec, status:'done' });
    else { ep.spec=spec; ep.status='done'; const c=epCache[ep.id]; if(c&&c.ep){ c.ep.spec=spec; c.ep.status='done'; } epaRerender(); }
    const i=((typeof teamEpics!=='undefined'&&teamEpics)||[]).findIndex(e=>e.id===ep.id); if(i>=0) teamEpics[i]={ ...teamEpics[i], spec, status:'done' };
    const quem=(ep.created_by&&ep.created_by!==me)?personName(ep.created_by,{ noYou:true }):'';
    toast(`Épico “${ep.name}” entregue${quem?' · '+quem+' recebe o aviso com o relatório':''}.`, 'ok', { label:'copiar relatório', fn:()=>epaCopiar(report) });
    try{ window.dispatchEvent(new CustomEvent('sf:epico-entregue', { detail:{ epicId:ep.id } })); }catch(_){ }
  }catch(e){ showErr(e, 'Não consegui entregar o épico'); }
  finally{ if(btn&&btn.isConnected){ btn.disabled=false; btn.removeAttribute('aria-busy'); } }
}
window.epEntregar=epEntregar;
async function epaCopiar(t){ try{ await navigator.clipboard.writeText(t); toast('Relatório copiado — é só colar.','ok'); }catch(_){ try{ await window.__TAURI__.clipboardManager.writeText(t); toast('Relatório copiado — é só colar.','ok'); }catch(e){ showErr(e, 'Não consegui copiar'); } } }
// o relatório COMPLETO do épico (73: relGerar recortado no épico — provas, pessoas, PDF/Markdown/HTML)
function epaRelatorio(ep, btn){
  const L=EPA.last; const cards=((L&&L.c&&L.c.tasks)||[]).filter(t=>t&&t.team_id);
  if(typeof relGerar!=='function' || !cards.length){ const r=((ep.spec||{}).delivery||{}).report; if(r) epaCopiar(r); else toast('Sem relatório pra este épico ainda.','info'); return; }
  const ms=[Date.parse(ep.created_at||'')||Date.now()-30*86400000, Date.now()], dd=x=>perFmtDay(x);
  const range={ from:new Date(new Date(ms[0]).setHours(0,0,0,0)).getTime(), to:new Date(new Date(ms[1]).setHours(24,0,0,0)).getTime() };
  relGerar(btn, { all:cards, f:{ epic:ep.id }, per:{ key:'custom', from:dd(range.from), to:dd(range.to-1) }, range, pe:cards, escopo:'épico '+(ep.name||'') });
}
// Entregas (76: entHtml2) — o épico entregue vira um cartão próprio no DIA, acima das tarefas
function epEntregaDiaHtml(diaKey){
  const eps=((typeof teamEpics!=='undefined'&&teamEpics)||[]).filter(e=>e&&e.spec&&e.spec.delivery&&e.spec.delivery.at && semKeyDia(Date.parse(e.spec.delivery.at))===diaKey);
  return eps.map(e=>{ const d=e.spec.delivery, hh=new Date(Date.parse(d.at)).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' });
    const out=String((e.spec||{}).outcome||'').replace(/\s+/g,' ').trim();
    return `<button type="button" class="semdc epa-dcard" data-epaentrega="${escA(e.id)}"><span class="epa-eyebrow">${epaIc('layers')}ÉPICO ENTREGUE · ${esc(hh)}</span><span class="t">${esc(e.name||'Épico')}</span>${out?`<span class="s">${esc(out.slice(0,140))}</span>`:''}<span class="m">${e.created_by?epaAv(e.created_by):''}<span>${[e.created_by?esc(epaNome(e.created_by, true))+' pediu':'', d.by?'aprovado por '+esc(epaNome(d.by)):''].filter(Boolean).join(' · ')}</span></span><span class="m">${d.dwN?`<span class="semstamp">${typeof semIc==='function'?semIc('check'):''}PRONTO QUANDO ${d.dwOk||0}/${d.dwN}</span>`:''}<span class="semcode">${EPA_PL(d.tasks||0,'tarefa','tarefas')} · ${EPA_PL(d.prs||0,'PR','PRs')}</span></span></button>`; }).join('');
}
window.epEntregaDiaHtml=epEntregaDiaHtml;
document.addEventListener('click', e=>{ const b=e.target.closest&&e.target.closest('[data-epaentrega]'); if(!b) return; e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(b.dataset.epaentrega); }, true);
// avisa QUEM PEDIU: o épico dela foi entregue por outra pessoa (o teamEpics já chega com o spec — sem consulta nova)
function epEntregueAvisoTick(){
  const me=epaMe(); if(!me) return;
  const k=(typeof userKey==='function'?userKey('ep:entregueAvisado', me):'ep:entregueAvisado'); let seen=[]; try{ seen=JSON.parse(lsGet(k)||'[]'); }catch(_){ }
  const novos=((typeof teamEpics!=='undefined'&&teamEpics)||[]).filter(e=>e&&e.created_by===me && e.spec&&e.spec.delivery && e.spec.delivery.by!==me && !seen.includes(e.id) && (Date.now()-Date.parse(e.spec.delivery.at||0))<7*86400000);
  novos.forEach(e=>{ seen.push(e.id); if(typeof pushNotif==='function') pushNotif('Épico entregue: '+(e.name||''), personName(e.spec.delivery.by,{ noYou:true })+' entregou o épico que você pediu — o relatório está na aba do épico e em Entregas', null); });
  if(novos.length) lsSet(k, JSON.stringify(seen.slice(-200)));
}
if(typeof tickLoop==='function') tickLoop('epEntregueAviso', ()=>{ try{ epEntregueAvisoTick(); }catch(_){ } }, 30000, 12000);

// ===================== lista Épicos (Central › Épicos): barra por tarefa + estado =====================
// uma barrinha por tarefa (na ordem das ondas), na cor do status da tarefa; e o estado do épico numa frase curta
function epBarraHtml(ep, tasks){
  const ts=(tasks||[]).slice().sort((a,b)=>(parseInt((a.spec||{}).wave,10)||1)-(parseInt((b.spec||{}).wave,10)||1));
  if(!ts.length) return '';
  return `<span class="epa-wbar" role="img" aria-label="${escA(ts.length+' tarefas, na ordem das ondas')}">${ts.map(t=>{ const st=epEffSt(t); return `<i style="--stc:${stColor(st)}" title="${escA(((t.spec||{}).issueCode?t.spec.issueCode+' · ':'')+(t.title||'')+' — '+stLabel(st))}"></i>`; }).join('')}</span>`;
}
function epEstadoCurto(ep, tasks){
  try{ const sp=ep.spec||{}; const M=epaModel({ items:epaItems(ep, tasks), flow:epFlowOf(sp), dw:Array.isArray(sp.doneWhen)?sp.doneWhen:[], delivered:sp.delivery?{}:null, apr:epaPodeAprovar(ep)?'você':epaNome(ep.created_by) });
    const t={ plano:'não começou', parado:EPA_PL(M.stuck.length,'coisa parada','coisas paradas'), aprovar:'espera '+(epaPodeAprovar(ep)?'você':epaNome(ep.created_by))+' aprovar '+M.ready.slice(0,2).map(epaNm).join(', '), liberar:'onda pronta pra começar', verificar:M.finalRun?'verificação final rodando':'falta conferir o “pronto quando”', entregar:'pronto pra entregar', entregue:'entregue', vazio:'' }[M.phase];
    return t==null?'onda '+((M.waves.find(w=>w.state!=='feita')||{}).n||1)+' rodando':t; }catch(_){ return ''; }
}
window.epBarraHtml=epBarraHtml; window.epEstadoCurto=epEstadoCurto;
