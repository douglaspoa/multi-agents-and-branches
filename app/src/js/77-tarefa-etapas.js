// Starfork — 77-tarefa-etapas
// ===== DENTRO DE UMA TAREFA: AS ETAPAS NA LATERAL (redesenho "Semana", aprovado pelo dono em 14/10 —
// _bmad-output/redesenho-foco/mesa-semana-app.md §2 e §7, mock starfork-semana-completo.html) =====
// Com uma tarefa na tela, a lateral do app vira as ETAPAS dela: Conversa ⌘1 · Código explicado ⌘2 · Revisão ⌘3 ·
// Prévia ⌘4 · Entrega ⌘5 — uma superfície por vez, cada etapa com o seu estado numa linha. Em cima, "← de onde veio"
// e "Precisa de mim"; embaixo, as outras tarefas abertas, "Nova" e "Onde fica".
//  - Conversa = o terminal PTY de verdade, sozinho e largo (≥ 100 colunas a 1000 px: a lateral da tarefa é estreita,
//    176 px). Nada de terminal em doca embaixo das outras etapas: trocar de etapa NÃO mexe no PTY (60-terminal só
//    desliga a pintura do xterm escondido; voltar pede o retrato de novo — a sessão segue viva).
//  - As etapas são os modos que a tela da tarefa já tinha (fwMode do 20-workspace-tarefa): 'pr' mora dentro da
//    Revisão. A barra de modos do cabeçalho some neste modo (a lateral é a navegação).
//  - Atalhos ⌘1–⌘5 (Ctrl fora do Mac) valem MESMO com o foco no terminal: ⌘ não é tecla de shell no macOS (o xterm
//    não manda ⌘+número pro PTY). Fora do Mac, Ctrl+número com o foco no terminal fica com o shell.
//  - A lateral é desenhada AQUI (sideTaskMode(t) devolve o HTML; cliques por delegação em [data-te]) — a casca global
//    pode chamar sideTaskMode(t) dentro da lateral nova; sem casca, este arquivo monta num nó próprio dentro de #sidebar.
// Só na janela principal: no painel da tela dividida (SF_PANE) a tarefa continua com os modos no cabeçalho.
// Fontes únicas: taskSt/stMeta (status), reqRows (provas), diffOf/diffFiles, personChip, tcLocalCtx (72), chainOfNow (08).

// @te-puro-inicio (puro: só esc/escA — testado em app/tests/tarefa-etapas.test.mjs)
const TE_STEPS=[
  { k:'conversa', n:'Conversa', sub:'terminal de verdade, só desta tarefa', ic:'term' },
  { k:'codigo', n:'Código explicado', sub:'o diff com o porquê de cada trecho', ic:'code' },
  { k:'revisao', n:'Revisão', sub:'requisito, prova e o trecho que prova', ic:'shield' },
  { k:'previa', n:'Prévia', sub:'o app rodando nesta branch', ic:'eye' },
  { k:'entrega', n:'Entrega', sub:'comprovante para mandar a quem pediu', ic:'box' },
];
const TE_RAIL_W=172; // lateral da tarefa (px): estreita pro terminal manter ≥ 100 colunas a 1000 px (veto do Téo)
const TE_IC={
  term:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M4.8 6.4 6.6 8l-1.8 1.6M8.2 10h3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  code:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 4.6 2.4 8l3.2 3.4M10.4 4.6 13.6 8l-3.2 3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 13 4v3.6c0 3-2.2 5.2-5 6.2-2.8-1-5-3.2-5-6.2V4z" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6L10.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.9"/></svg>',
  box:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 5 8 2.4 13.4 5v6L8 13.6 2.6 11z" stroke-linejoin="round"/><path d="M2.6 5 8 7.6 13.4 5M8 7.6v6" stroke-linejoin="round"/></svg>',
  back:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.6 5.4 8l4.4 4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  home:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 7.2 8 2.8l5.4 4.4V13a.6.6 0 0 1-.6.6H3.2a.6.6 0 0 1-.6-.6z" stroke-linejoin="round"/><path d="M6.4 13.6V9.8h3.2v3.8" stroke-linejoin="round"/></svg>',
  chev:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.6 6.4 3.4 3.4 3.4-3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" stroke-linecap="round"/></svg>',
  spark:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4 9.3 6.7 13.6 8 9.3 9.3 8 13.6 6.7 9.3 2.4 8 6.7 6.7z" stroke-linejoin="round"/></svg>',
  note:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 2.6h7l2.2 2.2v8.6H3.4z" stroke-linejoin="round"/><path d="M5.6 6.6h4.8M5.6 9h4.8M5.6 11.2h3" stroke-linecap="round"/></svg>',
  users:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><path d="M2.4 12.6c0-2 1.6-3.1 3.6-3.1s3.6 1.1 3.6 3.1M10.6 4.1a2.1 2.1 0 0 1 0 4M11.2 9.6c1.6.2 2.6 1.1 2.6 2.9" stroke-linecap="round"/></svg>',
};
/** fwMode (20-workspace) → etapa: o PR mora dentro da Revisão; modo desconhecido cai na Conversa. */
function teStepOfMode(m){ return m==='pr'?'revisao':(TE_STEPS.some(s=>s.k===m)?m:'conversa'); }
/** Etapas que esta tarefa mostra: entrega que não é código (investigação, design, relatório…) não tem Código nem Revisão
 *  (a MESMA regra dos modos — 27-entregas fwModesNonCode). O número do atalho é fixo por etapa (⌘4 é sempre Prévia). */
function teStepsOf(nonCode){ return TE_STEPS.map((s,i)=>Object.assign({ i, key:i+1 }, s)).filter(s=>!nonCode || (s.k!=='codigo' && s.k!=='revisao')); }
/**
 * Tecla → índice da etapa (0–4) ou -1. mac: ⌘1–⌘5 (vale com o foco no terminal: ⌘ não vai pro shell no macOS).
 * Fora do Mac: Ctrl+1–5, menos com o foco no terminal (lá o Ctrl é do shell). Shift/Alt = outro atalho.
 */
function teStepKey(e, mac, inTerm){
  if(!e || e.shiftKey || e.altKey) return -1;
  const mod=mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
  if(!mod || (!mac && inTerm)) return -1;
  return /^[1-5]$/.test(String(e.key||'')) ? (+e.key-1) : -1;
}
/**
 * O estado de cada etapa numa linha (lateral). o: { done, stLabel, running, turn, files, hunks, threads, reqOk, reqTot,
 * prevChanged, nonCode }. Nada inventado: sem dado, a linha diz o que falta ("nada mudou ainda", "sem requisitos").
 */
function teStepMeta(k, o){
  o=o||{};
  const pl=(n,s,p)=>n+' '+(n===1?s:(p||s+'s'));
  if(k==='conversa'){
    if(o.done) return 'encerrada';
    const st=String(o.stLabel||'');
    return (st?st.charAt(0).toUpperCase()+st.slice(1):'—')+(o.running && o.turn>0?' · '+o.turn+'ª resposta':'');
  }
  if(k==='codigo'){
    if(!(o.files>0)) return 'nada mudou ainda';
    return pl(o.files,'arquivo')+(o.hunks>0?' · '+pl(o.hunks,'trecho'):'')+(o.threads>0?' · '+pl(o.threads,'conversa'):'');
  }
  if(k==='revisao') return o.reqTot>0 ? o.reqOk+' de '+o.reqTot+' com prova' : 'sem requisitos';
  if(k==='previa') return o.prevChanged ? 'mudou · comparar' : 'navegador, iPhone, Android';
  if(k==='entrega') return o.done ? 'comprovante' : 'ainda não';
  return '';
}
/** "foi pro agente" (cabeçalho da Conversa): o que a tarefa REGISTROU que rodou — spec.roleRuns (motor, P10) e as
 *  notas de memória (spec.memNotes, quando o motor gravar). → { skills:[nome@vN], agents:['Vega v3'], notes:[título] } */
function teRanWith(spec){
  const runs=Array.isArray(spec&&spec.roleRuns)?spec.roleRuns:[];
  const skills=[], agents=[];
  for(const r of runs){
    for(const s of (Array.isArray(r&&r.skills)?r.skills:[])){ const x=String(s||'').trim(); if(x && !skills.includes(x)) skills.push(x); }
    const nm=String((r&&(r.name||r.agentId))||'').trim(); if(!nm) continue;
    const v=r.version!=null&&r.version!==''?' v'+r.version:'';
    const tag=nm.charAt(0).toUpperCase()+nm.slice(1)+v;
    if(!agents.includes(tag)) agents.push(tag);
  }
  const notes=(Array.isArray(spec&&spec.memNotes)?spec.memNotes:[]).map(n=>String((n&&(n.title||n.slug))||n||'').trim()).filter(Boolean);
  return { skills, agents, notes };
}
/** A lateral da tarefa (HTML). v: { taskId, back:{label}, needMe, code, title, who(html), steps:[{k,n,ic,key,meta,color}], cur,
 *  open:[{id,code,title,color}] }. Tudo clicável é [data-te] (delegação — a casca só precisa pôr o HTML). */
function teRailHtml(v){
  const st=v.steps.map(s=>`<button type="button" class="te-step${s.k===v.cur?' on':''}" data-te="step" data-k="${escA(s.k)}" aria-current="${s.k===v.cur?'page':'false'}" aria-keyshortcuts="Meta+${s.key}" title="${escA(s.n+' (⌘'+s.key+')')}">`+
    `<span class="te-ic">${TE_IC[s.ic]||''}</span><span class="te-l">${esc(s.n)}</span><span class="te-k">⌘${s.key}</span>`+
    `<span class="te-s"${s.color?` style="color:${escA(s.color)}"`:''}>${esc(s.meta||'')}</span></button>`).join('');
  const open=(v.open||[]).map(o=>`<button type="button" class="te-open" data-te="open" data-id="${escA(o.id)}" title="${escA(o.title)}"><span class="te-dot" style="--c:${escA(o.color||'var(--muted)')}" aria-hidden="true"></span><span class="te-otx"><span class="te-oc mono">${esc(o.code||'')}</span><span class="te-ot">${esc(o.title)}</span></span></button>`).join('');
  return `<div class="te-rail" data-te-task="${escA(v.taskId)}">`+
    `<div class="te-top"><button type="button" class="te-back" data-te="back">${TE_IC.back}<span>${esc(v.back&&v.back.label||'Central')}</span></button>`+
    `<button type="button" class="te-back" data-te="needme">${TE_IC.home}<span>Precisa de mim</span>${v.needMe>0?`<span class="te-cnt">${v.needMe}</span>`:''}</button></div>`+
    `<div class="te-head">${v.code?`<button type="button" class="te-code mono" data-te="chain" aria-expanded="${v.chainOpen?'true':'false'}" title="de onde veio, com quem está e pra onde vai">${esc(v.code)}${TE_IC.chev}</button>`:''}`+
    `<div class="te-title" title="${escA(v.title)}">${esc(v.title)}</div>${v.who?`<div class="te-who">${v.who}</div>`:''}</div>`+
    `<nav class="te-steps" aria-label="Etapas da tarefa">${st}</nav>`+
    (open?`<div class="te-grp">Abertas</div><div class="te-opens">${open}</div>`:'<div class="te-sp"></div>')+
    `<div class="te-foot"><button type="button" class="te-fb" data-te="nova">${TE_IC.plus}<span>Nova</span></button><button type="button" class="te-fb" data-te="onde" title="onde fica cada coisa e os atalhos (?)"><span>Onde fica</span><span class="te-kq">?</span></button></div></div>`;
}
// @te-puro-fim

// ---------------------------------------------------------------- estado
const TE={ on:false, cur:'', back:null, chain:false, railSig:'', headSig:'', host:null };
/** Modo etapas ligado? (janela principal, tarefa sozinha na tela — a mesma regra do cabeçalho docado). */
function teWanted(){
  if(typeof SF_PANE!=='undefined' && SF_PANE) return false;
  if(typeof fwVisible!=='function' || !fwVisible() || typeof fwTask==='undefined' || !fwTask) return false;
  const tab=(typeof tabById==='function' && typeof activeTab!=='undefined')?tabById(activeTab):null;
  if(!tab || tab.kind!=='task' || tab.taskId!==fwTask) return false;
  return !(typeof cvInSplit==='function' && cvInSplit(tab.id));
}
/** A tarefa que a lateral mostra agora (pra casca): null fora do modo etapas. */
function sideTaskActive(){ return TE.on && typeof fwTaskObj==='function' ? fwTaskObj() : null; }
function teNonCode(t){ return typeof fwModesNonCode==='function' && fwModesNonCode(t); }
/** Os dados de cada etapa, das fontes que a tela da tarefa já usa (nada de leitura nova aqui). */
function teMetaCtx(t){
  const st=typeof taskSt==='function'?taskSt(t):t.status, m=typeof stMeta==='function'?stMeta(st):{ pt:st, c:'' };
  const d=typeof diffOf==='function'?diffOf(t.id):null;
  const files=(typeof diffFiles==='function' && d)?diffFiles(d):((typeof fwFiles!=='undefined'&&fwTask===t.id)?fwFiles.filter(f=>!f.doc).length:0);
  const rows=typeof reqRows==='function'?reqRows(t):[];
  const cx=(typeof cxCounts==='function')?cxCounts(t.id):{ hunks:0, threads:0 };
  return { done:typeof taskIsDone==='function' && taskIsDone(t), stLabel:m.pt, stColor:m.c, running:['running','thinking'].includes(t.status)||!!t.busy,
    turn:(typeof cxTurnCount==='function')?cxTurnCount(t.id):0, files, hunks:cx.hunks, threads:cx.threads,
    reqOk:rows.filter(r=>r.st==='ok').length, reqTot:rows.length, prevChanged:typeof mrChanged==='function' && mrChanged(t.id), nonCode:teNonCode(t) };
}
function teNeedMeCount(){
  const L=(typeof state!=='undefined' && state.tasks)||[];
  return L.filter(x=>{ const s=typeof taskSt==='function'?taskSt(x):x.status; return ['asking','needs-you','plan-review','review'].includes(s); }).length;
}
function teCodeOf(t){
  let code='';
  try{ const c=typeof chainOfNow==='function'?chainOfNow(t):null; code=(c&&c.issue&&c.issue.code)||''; }catch(_){ }
  if(!code) code=(t.spec&&t.spec.issueCode)||(typeof issueCodeOf==='function'?issueCodeOf(t):'')||'';
  return code||String(t.branch||'').replace(/^(feat|fix|agent|sf)\//,'').slice(0,22);
}
function teWhoHtml(t){
  let who=null;
  try{ const ctx=typeof tcLocalCtx==='function'?tcLocalCtx(t, false):null; who=(ctx&&ctx.card&&ctx.card.assignee)||null; }catch(_){ }
  if(!who && typeof cloudUserId==='function') who=cloudUserId()||null;
  if(!who || typeof personChip!=='function') return '<span class="te-wl">com você</span>';
  return `<span class="te-wl">com</span>${personChip(who,{ short:true })}`;
}
function teRailView(t){
  const ctx=teMetaCtx(t);
  const steps=teStepsOf(ctx.nonCode).map(s=>Object.assign({}, s, { meta:teStepMeta(s.k, ctx), color:s.k==='conversa'&&!ctx.done?ctx.stColor:'' }));
  const open=((typeof TABS!=='undefined'&&TABS)||[]).filter(x=>x.kind==='task' && x.taskId && x.taskId!==t.id).map(x=>{
    const o=(state.tasks||[]).find(y=>y.id===x.taskId); const s=o&&typeof taskSt==='function'?taskSt(o):'';
    return { id:x.id, code:o?teCodeOf(o):'', title:o?mdTitle(o.title||''):(x.title||'tarefa'), color:s&&typeof stMeta==='function'?stMeta(s).c:'' }; });
  return { taskId:t.id, back:TE.back||{ label:'Central' }, needMe:teNeedMeCount(), code:teCodeOf(t), chainOpen:TE.chain,
    title:typeof mdTitle==='function'?mdTitle(t.title||''):String(t.title||''), who:teWhoHtml(t), steps, cur:TE.cur, open };
}
/** API pra casca global: o HTML da lateral desta tarefa (os cliques são delegados — [data-te]). */
function sideTaskMode(t){ return t ? teRailHtml(teRailView(t)) : ''; }
window.sideTaskMode=sideTaskMode; window.sideTaskActive=sideTaskActive;

// ---------------------------------------------------------------- montagem (lateral + cabeçalho da etapa)
// a casca nova pode assumir a lateral: window.sideTaskHost(on) devolve o nó onde pintar (ou null = ela pinta sozinha)
function teRailHostEl(){
  if(typeof window.sideTaskHost==='function'){ try{ return window.sideTaskHost(TE.on); }catch(_){ return null; } }
  const sb=$id('sidebar'); if(!sb) return null;
  let h=$id('sbTask');
  if(!h){ h=document.createElement('div'); h.id='sbTask'; h.className='sbtask'; h.hidden=true; sb.appendChild(h); }
  return h;
}
function teRailPaint(t, force){
  const host=teRailHostEl(); if(!host) return;
  if(!TE.on || !t){ if(!host.hidden){ host.hidden=true; host.innerHTML=''; TE.railSig=''; } return; }
  const html=sideTaskMode(t);
  if(!force && html===TE.railSig && !host.hidden) return;
  const hadFocus=host.contains(document.activeElement)?(document.activeElement.dataset.k||document.activeElement.dataset.te||''):'';
  TE.railSig=html; host.innerHTML=html; host.hidden=false;
  if(hadFocus){ const b=host.querySelector(`[data-k="${CSS.escape(hadFocus)}"]`)||host.querySelector(`[data-te="${CSS.escape(hadFocus)}"]`); if(b) try{ b.focus({ preventScroll:true }); }catch(_){ } }
}
function teHeadEl(){
  let h=$id('teHead'); if(h) return h;
  const fw=document.querySelector('#fwOverlay .fw'); if(!fw) return null;
  h=document.createElement('div'); h.id='teHead'; h.className='tehead'; h.hidden=true;
  const before=$id('fwChain'); fw.insertBefore(h, before||fw.firstChild); return h;
}
function teChipsHtml(t){
  const r=teRanWith(t.spec||{}); if(!r.skills.length && !r.agents.length && !r.notes.length) return '';
  const b=(k, ic, tx, tip)=>`<button type="button" class="te-chip" data-te="${k}" title="${escA(tip)}">${TE_IC[ic]}<span>${esc(tx)}</span></button>`;
  return `<div class="te-ran"><span class="te-ranl">foi pro agente:</span>`+
    (r.skills.length?b('ranskills','spark', r.skills.length+(r.skills.length===1?' skill':' skills'), 'skills que entraram: '+r.skills.join(', ')+' — clique pra rodar uma no terminal'):'')+
    (r.notes.length?b('rannotes','note', r.notes.length+(r.notes.length===1?' nota de memória':' notas de memória'), 'notas usadas: '+r.notes.join(' · ')):'')+
    (r.agents.length?b('ranagents','users', r.agents.join(' · '), 'agentes e versões que rodaram nesta tarefa — clique pra ver os agentes'):'')+`</div>`;
}
function teHeadPaint(t){
  const h=teHeadEl(); if(!h) return;
  if(!TE.on || !t){ if(!h.hidden){ h.hidden=true; h.innerHTML=''; TE.headSig=''; } return; }
  const s=TE_STEPS.find(x=>x.k===TE.cur)||TE_STEPS[0];
  const html=`<div class="te-ht"><h1 class="te-h1">${esc(s.n)}</h1><span class="te-hsub">${esc(s.sub)}</span></div>`+(s.k==='conversa'?teChipsHtml(t):'')+
    `<span class="te-hsp"></span>${s.k==='revisao' && typeof teRevTabsHtml==='function'?teRevTabsHtml(t):''}`;
  if(html===TE.headSig && !h.hidden) return;
  TE.headSig=html; h.innerHTML=html; h.hidden=false;
}
/** Liga/desliga o modo etapas (chamado pelo fwHeadDock — toda troca de aba e todo render da tarefa passam por lá). */
function teSync(){
  const want=teWanted();
  const root=document.documentElement;
  // de onde veio: a última tela que NÃO era tarefa (Central, Semana, Issues…)
  { const tab=(typeof tabById==='function' && typeof activeTab!=='undefined')?tabById(activeTab):null;
    if(tab && tab.kind!=='task'){ const meta=(typeof VIEW_META!=='undefined'&&VIEW_META[tab.kind])||{}; TE.back={ id:tab.id, label:tab.kind==='flow'?'Central':(meta.title||tab.title||'Voltar') }; } }
  if(want!==TE.on){ TE.on=want; root.classList.toggle('te-on', want); if(!want){ TE.chain=false; } }
  const t=want&&typeof fwTaskObj==='function'?fwTaskObj():null;
  if(t){ TE.cur=teStepOfMode(fwMode); root.dataset.teStep=TE.cur; } else delete root.dataset.teStep;
  { const ch=$id('fwChain'); if(ch) ch.classList.toggle('te-chain-open', !!(want && TE.chain)); }
  teRailPaint(t); teHeadPaint(t);
}
/** Depois de cada render da tarefa (20-workspace chama no fim do renderWorkspace). */
function teAfterRender(t){ if(typeof mrAfterRender==='function') mrAfterRender(); if(!TE.on) return; TE.cur=teStepOfMode(fwMode); document.documentElement.dataset.teStep=TE.cur; teRailPaint(t); teHeadPaint(t); }
/** Poll da tarefa aberta (fwLiveUpdate): a lateral acompanha status, provas e conversas (só pinta se mudou). */
function teLive(t){ if(typeof cxLive==='function') cxLive(t); if(TE.on) teRailPaint(t); }
/** Vai pra etapa (clique na lateral ou ⌘N). Mantém o PTY: só troca o fwMode. */
async function teGo(k){
  const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(!t) return;
  if(!teStepsOf(teNonCode(t)).some(s=>s.k===k)){ toast('esta tarefa não muda código — não tem '+((TE_STEPS.find(s=>s.k===k)||{}).n||k), 'info'); return; }
  let mode=k;
  if(k==='revisao' && fwMode==='pr') mode='pr'; // já estava no PR: ⌘3 não tira de lá
  if(k==='codigo' && typeof fwPath!=='undefined'){ fwEditing=false; }
  await fwSetMode(mode);
  TE.cur=k; teSync();
  // Conversa: o teclado volta pro terminal. Outra etapa: o foco sai do xterm escondido (senão as teclas iam pro PTY
  // sem ninguém ver) e vai pro botão da etapa na lateral — visível, e Tab segue pra dentro da superfície
  if(k==='conversa'){ if(typeof tlFocusTerm==='function') setTimeout(()=>tlFocusTerm(t.id), 30); }
  else { const ae=document.activeElement; if(!ae || ae===document.body || (ae.closest && ae.closest('.xterm'))){ const b=document.querySelector(`.te-rail [data-te="step"][data-k="${CSS.escape(k)}"]`); if(b) try{ b.focus({ preventScroll:true }); }catch(_){ } } }
}

// ---------------------------------------------------------------- Revisão (⌘3): requisitos e o PR numa superfície só
/** Alternador no cabeçalho da Revisão: "Por requisito" (63-revisao-pr) · "Pull request" (21) quando a tarefa tem PR. */
function teRevTabsHtml(t){
  if(!t || !t.prUrl) return '';
  const pr=fwMode==='pr';
  return `<div class="te-seg" role="group" aria-label="O que revisar"><button type="button" data-te="rev" data-v="revisao" aria-pressed="${!pr}">Por requisito</button><button type="button" data-te="rev" data-v="pr" aria-pressed="${pr}">Pull request${typeof fwPrNum==='function'&&fwPrNum(t)?' #'+esc(fwPrNum(t)):''}</button></div>`;
}
// ---------------------------------------------------------------- Entrega (⌘5): "Feito com"
/** Agentes (com versão e o que fez), skills (com versão) e as notas de memória que entraram — só o que a tarefa registrou. */
function teFeitoComHtml(t){
  const sp=(t&&t.spec)||{};
  const runs=Array.isArray(sp.roleRuns)?sp.roleRuns:[];
  const r=teRanWith(sp);
  if(!runs.length && !r.notes.length) return '';
  const VERB={ planner:'planejou', builder:'construiu', reviewer:'revisou', tester:'testou', designer:'desenhou', docs:'documentou' };
  const seen=new Set();
  const ag=runs.filter(x=>{ const k=(x.agentId||x.name)+'|'+x.role; if(seen.has(k)) return false; seen.add(k); return true; }).map(x=>{
    const nm=String(x.name||x.agentId||'agente'); const v=x.version!=null&&x.version!==''?' v'+x.version:'';
    const model=(typeof boardModelName==='function'&&x.model)?boardModelName(x.model):'';
    return `<li>${TE_IC.users}<span><b>${esc(nm.charAt(0).toUpperCase()+nm.slice(1)+v)}</b> ${esc(VERB[x.role]||x.role||'')}${model?' · '+esc(model):''}</span></li>`; }).join('');
  const sk=r.skills.map(s=>{ const m=String(s).match(/^(.+?)@v?(.+)$/); return `<li>${TE_IC.spark}<span>${esc(m?m[1]:s)}${m?` <span class="te-dim">${esc(m[2])}</span>`:''}</span></li>`; }).join('');
  const notes=(Array.isArray(sp.memNotes)?sp.memNotes:[]).map(n=>`<li>${TE_IC.note}<span>${esc(n.title||'')}${n.by?` <span class="te-dim">· ${esc(n.by)}</span>`:''}</span></li>`).join('');
  const col=(h, body, empty, foot)=>`<div class="te-fc"><div class="te-fch">${h}</div>${body?`<ul>${body}</ul>`:`<div class="te-dim">${empty}</div>`}${foot||''}</div>`;
  return `<section class="en-sec te-feito" aria-label="Feito com"><div class="seclbl2">Feito com <span class="dim">· quem trabalhou, as skills e o que a IA sabia</span></div><div class="te-fcs">`+
    col('Agentes', ag, 'nenhum agente registrado')+col('Skills aplicadas', sk, 'nenhuma skill ligada')+
    col('Memória usada', notes, 'sem nota registrada nesta tarefa', notes?'<button type="button" class="lnk" data-te="rannotes">ver as notas</button>':'')+`</div></section>`;
}

// ---------------------------------------------------------------- cliques (delegação: vale pro HTML pintado pela casca)
document.addEventListener('click', (e)=>{
  const b=e.target && e.target.closest && e.target.closest('[data-te]'); if(!b) return;
  const k=b.dataset.te;
  if(k==='step'){ e.preventDefault(); teGo(b.dataset.k); return; }
  if(k==='back'){ e.preventDefault(); const bk=TE.back; if(bk && typeof tabById==='function' && tabById(bk.id)) activateTab(bk.id); else openTab('flow'); return; }
  if(k==='needme'){ e.preventDefault(); if(typeof window.openMeuTrabalho==='function') window.openMeuTrabalho(); else openTab('flow'); return; }
  if(k==='open'){ e.preventDefault(); const id=b.dataset.id; if(typeof tabLeaveGuard==='function') tabLeaveGuard(id, false).then(ok=>{ if(ok) activateTab(id); }); else activateTab(id); return; }
  if(k==='chain'){ e.preventDefault(); TE.chain=!TE.chain; teSync(); const t=fwTaskObj(); if(t){ TE.railSig=''; teRailPaint(t, true); } if(TE.chain){ const c=$id('fwChain'); if(c && c.hidden) toast('esta tarefa não veio de issue nem de épico','info'); } return; }
  if(k==='nova'){ e.preventDefault(); openTab('nova'); return; }
  if(k==='onde'){ e.preventDefault(); if(typeof window.openOndeFica==='function') window.openOndeFica(); else openTab('kbd'); return; }
  if(k==='rev'){ e.preventDefault(); if(typeof fwSetMode==='function') fwSetMode(b.dataset.v==='pr'?'pr':'revisao').then(()=>teSync()); return; }
  if(k==='ranskills'){ e.preventDefault(); const t=fwTaskObj(); if(t && typeof tiSheetOpen==='function') tiSheetOpen(t.id, 'skill', b); return; }
  if(k==='ranagents'){ e.preventDefault(); openTab('agents'); return; }
  if(k==='rannotes'){ e.preventDefault(); openTab('memoria'); return; }
});
// ⌘1–⌘5 dentro da tarefa (captura: antes do ⌘1…⌘9 das abas, do 15-config). Ctrl fora do Mac, menos no terminal.
window.addEventListener('keydown', (e)=>{
  if(!TE.on) return;
  const inTerm=!!(e.target && e.target.closest && e.target.closest('.xterm'));
  const i=teStepKey(e, typeof osKind==='function'?osKind()==='mac':true, inTerm); if(i<0) return;
  const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(!t) return;
  e.preventDefault(); e.stopPropagation();
  // o menu do app (Tela › Painel 1–3, ⌘1–⌘3) também dispara: marca a tecla pro cvMenuKey (58) não trocar de aba junto
  try{ window.__sfLastKey={ k:String(e.key), at:Date.now() }; }catch(_){ }
  teGo(TE_STEPS[i].k);
}, true);
