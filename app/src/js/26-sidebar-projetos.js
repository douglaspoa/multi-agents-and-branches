// Starfork — 26-sidebar-projetos
// ---- sidebar por PROJETO (redesign p2): sessões de TODOS os repos salvos ----
let projOv=null, projOvAt=0;
async function railProjTick(){
  if(!connected) return;
  if(projOv && Date.now()-projOvAt<60000) return;
  try{ projOv=await invoke('projects_overview'); projOvAt=Date.now(); renderRailProj(); }catch(_){ }
}
function renderRailProj(){ safe(renderRail); } // a visão por projeto agora É a sidebar

// guarda de innerHTML: só reescreve quando o HTML mudou de fato. O 1º filho entra na conferência:
// se outro código escreveu direto no elemento (ex.: render() sem repo), o cache não vale mais.
function setHtmlGuarded(el, html){
  if(el.__html===html && el.__first===el.firstChild) return false;
  el.innerHTML=html; el.__html=html; el.__first=el.firstChild; return true;
}
function renderFeed(){
  const el = $id("feed");
  const evs = state.events.slice(-200);
  let html;
  if(evs.length===0) html = '<div class="empty">aguardando eventos…</div>';
  else html = evs.map(e=>{
    const g = GLYPH[e.type]||"·";
    const gc = GCOLOR[e.type]||"var(--muted)";
    return `<div class="fl">
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="ag" style="color:var(--text-2)">${esc(e.agent)}</span>
      <span class="gl" style="color:${gc}">${g}</span>
      <span class="tx">${esc(e.text)}</span>
    </div>`;
  }).join("");
  if(setHtmlGuarded(el, html) && evs.length) el.scrollTop = el.scrollHeight;
}

// Stepper vertical das etapas da tarefa — mostra "em que pé está".
function stageStepper(t){
  const roles=t.roles||[];
  if(!roles.length) return "";
  const finished=(t.status==='review'||t.status==='merged'||t.status==='done');
  let curIdx=roles.findIndex(r=>r.role===t.stage); if(curIdx<0) curIdx=0;
  const ev=lastEventOf(t.id);
  const steps=roles.map((r,i)=>{
    let cls;
    if(finished || i<curIdx) cls='done';
    else if(i===curIdx) cls=(t.status==='error'?'err':(ACTIVE_ST.has(t.status)?'cur':'wait'));
    else cls='wait';
    const mark = cls==='done'?IC.check : cls==='err'?'!' : cls==='cur'?'<span class="spin"></span>' : (i+1);
    const sub = (cls==='cur' && ev) ? `<div class="sact">${esc((GLYPH[ev.type]||'·')+' '+ev.text)}</div>` : '';
    const view = r.role==='planner'?'<span class="sview">ver plano ›</span>' : r.role==='designer'?'<span class="sview">ver design ›</span>' : '';
    return `<div class="step ${cls}" data-role="${escA(r.role)}" data-name="${escA(r.name)}"><span class="smark">${mark}</span><div class="stx"><span class="srole">${ROLE_PT[r.role]||r.role}${view}</span><span class="sname">${esc(r.name)}</span>${sub}</div></div>`;
  }).join("");
  return `<div class="seclbl" style="margin-top:13px">Etapas</div><div class="stepper">${steps}</div>`;
}
// MODO DESIGN (estilo Claude Design): diagnóstico → perguntas com opções
// concretas → iterações curtas com preview ao vivo → aprovação do humano.
const DESIGN_PROMPT = 'MODO DESIGN — refine o VISUAL desta entrega comigo, agindo como um designer sênior de produto:\n'
  +'1) Suba o ambiente (siga o .cardume/RUNBOOK.md) e ANUNCIE numa linha "PREVIEW: <url da tela em questão>" pra eu acompanhar ao vivo (também vejo do celular).\n'
  +'2) Faça um DIAGNÓSTICO visual objetivo da tela atual: hierarquia, espaçamento, tipografia, cores, estados vazios, consistência com o design system JÁ EXISTENTE no projeto (procure tokens/tema/componentes antes de inventar). Liste os 3 piores problemas em ordem.\n'
  +'3) ANTES de mexer, pergunte via mcp__cardume__ask_human O QUE PRIORIZAR — sempre com OPÇÕES CONCRETAS e mutuamente exclusivas (ex.: "mais denso ou mais respiro?", "seguir a paleta da tela X ou propor nova?", "manter esse layout e polir, ou redesenhar o bloco?"). NUNCA pergunta genérica tipo "o que você quer mudar?". Se referência visual ajudar, peça um print/link.\n'
  +'4) Aplique em ITERAÇÕES CURTAS: UM ajuste por vez, re-anuncie o preview depois de cada um e pergunte via ask_human "melhorou? sigo pro próximo?" com opções (aprovar / ajustar isso / voltar atrás).\n'
  +'5) Só finalize quando eu disser explicitamente que o design está bom. Ao final, resuma o que mudou e atualize os artefatos de prova (screenshot antes/depois).';

// SKILLS DO CHAT: digite "/" e escolha — cada uma é um prompt lapidado.
const CHAT_SKILLS=[
  { id:'design',     label:'design', desc:'refinar o visual comigo — diagnóstico, opções e iterações com preview', prompt:()=>DESIGN_PROMPT },
  { id:'preview',    label:'preview', desc:'subir o ambiente e me dar o link ao vivo', prompt:()=>'Suba o ambiente local desta branch AGORA (siga o .cardume/RUNBOOK.md) e ANUNCIE "PREVIEW: <url da tela desta tarefa>". Mantenha rodando e re-anuncie se trocar de página.' },
  { id:'requisitos', label:'requisitos', desc:'verificar cada requisito e gerar as provas', prompt:()=>'Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar.' },
  { id:'testes',     label:'testes', desc:'rodar a suíte real e anexar a saída', prompt:()=>'Rode os testes REAIS na suíte do projeto pra esta branch (comandos do .cardume/RUNBOOK.md). Salve .cardume/artifacts/tests.md com os comandos e a SAÍDA literal. Falhou algo? Investigue a causa e corrija antes de me responder.' },
  { id:'provas',     label:'provas', desc:'provar na UI real com screenshots', prompt:()=>'Prove que a entrega funciona NA UI REAL: suba o ambiente (RUNBOOK), execute o fluxo desta tarefa de ponta a ponta e capture screenshots reais em .cardume/artifacts/ (antes/depois quando fizer sentido). Anuncie o PREVIEW: <url> enquanto estiver de pé.' },
  { id:'resumo',     label:'resumo', desc:'estado atual em 1 minuto de leitura', prompt:()=>'Me dê um resumo executivo do estado ATUAL desta tarefa: o que já foi feito (com os arquivos), o que falta, riscos/decisões em aberto. NÃO execute nada novo — só leia e resuma.' },
  { id:'seguranca',  label:'segurança', desc:'auditar riscos no diff da branch', prompt:()=>'Audite o diff desta branch (contra a base) com olhar de segurança: injeção, authz/escopo de tenant, segredos expostos, dados sensíveis em log. Liste os achados por severidade com arquivo:linha e a correção proposta. NÃO corrija ainda — me apresente primeiro via ask_human.' },
];

// URL de preview mais recente que o agente anunciou ('PREVIEW: http://…')
function taskPreviewUrl(taskId){
  const evs=state.events||[];
  for(let i=evs.length-1;i>=0;i--){
    const e=evs[i]; if((e.taskId||e.task_id)!==taskId) continue;
    const m=(e.text||'').match(PREVIEW_RE);
    if(m) return m[1];
  }
  return null;
}
// túnel criptografado → publica no cartão da nuvem → o app do celular mostra o botão
async function mobilePreview(taskId, url, silent){
  try{
    // tunnel_start já faz o health-check (DNS + conector) e só retorna URL viva
    let pub=await invoke('tunnel_start',{ taskId, url });
    // o túnel é da ORIGEM — devolve o caminho/subpágina anunciados na URL pública
    try{ const u=new URL(url); pub=pub.replace(/\/$/,'')+u.pathname+u.search; }catch(_){ }
    const cid=tmap()[taskId];
    if(cid && SB.sess()){
      try{
        const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{};
        await sbFetch('/rest/v1/tasks?id=eq.'+cid, { method:'PATCH', body: JSON.stringify({ spec: { ...(cur.spec||{}), previewUrl: pub, tunnelWanted: null } }) });
        sbPost('task_feed',{ task_id:cid, agent:'Sistema', kind:'note', text:'preview no celular: '+pub }).catch(()=>{});
      }catch(_){ }
    }
    return pub;
  }catch(e){ if(!silent) showErr(e, 'Túnel falhou'); return null; }
}

// Barra de status "Agora": o que importa num relance — quantas tarefas estão rodando, quantas esperam
// você e quanto já custou. Antes: "N agentes" (= TODAS as tarefas já criadas), "reivindicações" e
// "1670683k tok". O detalhe técnico (arquivos reservados/cedidos entre agentes) foi pro tooltip.
function renderBus(){
  const el = $id("busSummary"); if(!el) return;
  // snapshot parcial (projeto trocando / resposta velha) chegava sem alguma lista → "reading 'filter'"
  const L=(x)=>Array.isArray(x)?x:[];
  const tasks=L(state.tasks);
  if(tasks.length===0){ setHtmlGuarded(el, '<span class="dim">nenhuma tarefa neste projeto ainda</span>'); el.title=''; return; }
  // MESMA contagem da Central/Kanban/chips (flowCounts sobre boardSource) — antes contava por conta própria
  // ("3 rodando · 4 esperando você" contra "5 em andamento · 5 aguardando você" no cabeçalho)
  const live=L(flowLiveTasks());
  const fc=flowCounts(live);
  const allProj=projFilter==='all' && projList().length>1;
  const costs=L(state.costs);
  const totUsd=costs.reduce((s,c)=>s+((c&&c.usd)||0),0);
  const totTok=costs.reduce((s,c)=>s+((c&&c.inTok)||0)+((c&&c.outTok)||0),0);
  // R7: cada contagem é um atalho — clicar leva pra Central já filtrada naquela etapa (mesmo chip da Central).
  // Cor = a da seção (FLOW_SEC_COLOR), igual aos chips; antes "prontas" e "PR aberto" ficavam cinza.
  const go=(k,html,title)=>`<button type="button" class="busln" data-busst="${k}" title="${escA(title)}">${html}</button>`;
  const parts=[];
  parts.push(fc.aguardando?go('aguardando',`<b style="color:var(--st-ask,var(--warn))">${fc.aguardando} aguardando você</b>`,'ver na Central o que espera uma decisão sua'):'<span>0 aguardando você</span>');
  parts.push(fc.andamento?go('andamento',`<b style="color:var(--st-run,var(--good))">${fc.andamento} em andamento</b>`,'ver na Central o que os agentes estão fazendo'):`<b style="color:var(--text-2)">0 em andamento</b>`);
  if(fc.prontas) parts.push(go('prontas',`<span style="color:${FLOW_SEC_COLOR.prontas}">${fc.prontas} pronta${fc.prontas===1?'':'s'} pra revisar</span>`,'ver na Central as entregas prontas pra você revisar'));
  if(fc.praberto) parts.push(go('praberto',`<span style="color:${FLOW_SEC_COLOR.praberto}">${nPl(fc.praberto,'PR aberto','PRs abertos')}</span>`,'ver na Central os PRs esperando revisão/merge'));
  if(totUsd||totTok) parts.push(`<span style="color:var(--accent);font-weight:600">${fmtCost(totUsd)} no total</span>`);
  // conflitos de arquivo entre agentes: resumo curto na barra, explicação no tooltip
  const claims=L(state.claims), yields=claims.filter(c=>c&&c.yieldedTo);
  const seen=new Set(); const uniq=[];
  for(const c of yields){ const k=c.agent+'|'+c.path+'|'+c.yieldedTo; if(!seen.has(k)){ seen.add(k); uniq.push(c); } }
  if(uniq.length) parts.push(`<span class="warn">${IC.warn} ${uniq.length} arquivo${uniq.length===1?'':'s'} disputado${uniq.length===1?'':'s'}</span>`);
  setHtmlGuarded(el, parts.join(' &nbsp;·&nbsp; '));
  const tip=[
    `${nPl(live.length,'tarefa viva','tarefas vivas')} ${allProj?'em todos os projetos':'neste projeto'} (mesma contagem da Central): ${fc.aguardando} aguardando você · ${fc.andamento} em andamento (${fc.rodando} executando agora) · ${fc.prontas} prontas pra revisar · ${fc.praberto} com PR aberto · ${fc.rascunho} rascunho${fc.rascunho===1?'':'s'}`,
    (totUsd||totTok)?`Custo somado das tarefas deste projeto: ${fmtCost(totUsd)} (${fmtTok(totTok)} tokens de IA)`:'',
    claims.length?`${claims.length} arquivo${claims.length===1?'':'s'} reservado${claims.length===1?'':'s'} por agentes agora (evita dois agentes editarem o mesmo arquivo ao mesmo tempo)`:'',
    ...uniq.slice(0,5).map(c=>`${c.agent} cedeu ${(c.path||'').split('/').pop()} para ${c.yieldedTo} — esperou o outro terminar em vez de sobrescrever`),
  ].filter(Boolean).join('\n');
  if(el.title!==tip) el.title=tip;
}

// clique numa contagem da barra de status → Central (Execução) filtrada naquela etapa
{ const bs=$id('busSummary'); if(bs) bs.addEventListener('click', e=>{
  const b=e.target.closest('[data-busst]'); if(!b) return;
  flowScope='exec'; lsSet('flowScope','exec'); flowStatus=b.dataset.busst; flowSetF('flowStatus', flowStatus);
  if(window.openTab) window.openTab('flow');
  if(curView()!=='flow') setView('flow'); else { lastSig=''; render(); }
}); }
$id("connectBtn").onclick = ()=>{
  const v = $id("repoInput").value.trim();
  if(v) connect(v);
};
$id("repoInput").addEventListener("keydown", e=>{ if(e.key==="Enter") $id("connectBtn").click(); });

$id("viewSeg").querySelectorAll("button").forEach(b=>b.onclick=()=>{
  const v=b.dataset.v;
  $id("viewSeg").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b));
  lsSet('mainView', v); // reabre na mesma visão (Fluxo/Kanban/Grafo/Atividade/Time) no próximo boot
  $id("chint").textContent = v==="flow"?"quem fez o quê · commits por tarefa":v==="kanban"?"arraste entre colunas · play no card":v==="graph"?"branches · agentes nas pontas":v==="team"?"backlog compartilhado do time · assumir & iniciar":"eventos ao vivo de todos os agentes";
  if(v==="flow") loadAllCommits();
  if(v==="graph"){ refresh(); return; }   // busca o grafo (git log) só ao abrir a aba
  render();
  lastSig = snapSig();   // marca o estado já renderizado (evita render duplicado no próximo tick)
});

// boot: volta pra visão principal que você usou por último (Grafo some em pasta sem git — gitUiSync cuida)
function restoreMainView(){
  const v=lsGet('mainView'); if(!v || v==='flow' || curView()===v) return;
  const b=document.querySelector('#viewSeg button[data-v="'+v+'"]');
  if(b && b.style.display!=='none') b.click();
}
let ntDel=[], ntReq=[], ntRefs=[], ntFixReq=[], ntDzRefs=[], ntFixRefs=[], ntInvRefs=[];
