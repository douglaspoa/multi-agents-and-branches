// Starfork — 58-ambiente
// ===== "Subir ambiente" (spec-canvas-workspace F1) — o lugar da TELA BRANCA da prévia =====
// O painel "Meu app" sem site no ar vira um cartão com UM botão grande. Clicou → passos ticando em pt-BR (achando
// como ligar → instalando o que falta → ligando o site → esperando responder → abrindo). A página só aparece quando
// responde (o motor espera). Log técnico NUNCA na cara: só em "ver detalhes". Falhou → frase de gente + "pedir pro
// agente resolver" (manda o fim do log pro chat DA demanda). Parar/reiniciar na faixa do topo do painel.
// Motor: src/env-up.ts (`cardume env …`); Rust: ambiente.rs (grupo de processo, varredura no boot, evento
// `env-progress` — nada de polling aqui).

// @amb-puro-inicio (testado em app/tests/canvas-ui.test.mjs)
const ENV_STEPS=[
  ['detect','Achando como ligar o projeto'],
  ['install','Instalando o que falta'],
  ['start','Ligando o site'],
  ['wait','Esperando a página responder'],
  ['ready','Abrindo a página'],
];
// evento do supervisor → estado da tela (o mesmo que o Rust guarda; puro)
function envApply(view, ev){
  const v=Object.assign({ running:false, steps:[], ready:false, url:null, fail:null, exited:false, label:null }, view||{});
  v.steps=(v.steps||[]).slice();
  const e=ev&&ev.ev;
  if(e==='step'){ if(ev.step && !v.steps.includes(ev.step)) v.steps.push(ev.step); if(ev.label) v.label=String(ev.label).slice(0,200); if(ev.url) v.url=ev.url; v.running=true; v.fail=null; v.exited=false; }
  else if(e==='ready'){ v.ready=true; v.running=true; v.url=ev.url||v.url; v.fail=null; if(!v.steps.includes('ready')) v.steps.push('ready'); }
  else if(e==='fail'){ v.fail={ code:ev.code||'', msg:String(ev.msg||'Não consegui ligar o site.'), tail:String(ev.tail||'') }; v.ready=false; v.running=false; }
  else if(e==='exit'){ v.exited=true; v.ready=false; v.running=false; v.fail={ code:'exit', msg:String(ev.msg||'O site parou.'), tail:String(ev.tail||'') }; }
  else if(e==='end'){ v.running=false; if(!v.fail && !v.ready) v.steps=[]; v.ready=false; }
  return v;
}
// passo de cada linha: done | cur | wait (o "instalar" só aparece se aconteceu ou se vai acontecer)
function envStepRows(view, plan){
  const st=(view&&view.steps)||[]; const failing=!!(view&&view.fail);
  const rows=ENV_STEPS.filter(([k])=>k!=='install' || st.includes('install') || (plan&&plan.install));
  const lastIdx=rows.reduce((m,[k],i)=>st.includes(k)?i:m, -1);
  return rows.map(([k,label],i)=>({ k, label, st: i<lastIdx||(view&&view.ready&&i<=lastIdx) ? 'done' : i===lastIdx ? (failing?'fail':'cur') : 'wait' }));
}
// cartão do painel vazio. s: { plan (undefined = vendo; null = erro ao ver), view, details, log, busy }
function envCardHtml(s){
  s=s||{}; const plan=s.plan, v=s.view||{};
  if(plan===undefined) return `<div class="envcard"><div class="envh"><span class="spin"></span> vendo como ligar este projeto…</div></div>`;
  if(plan && plan.web===false) return `<div class="envcard envnone"><div class="envh">Este projeto não tem uma página pra mostrar</div><p class="envsub">Ele não tem site nem tela de navegador. Dá pra acompanhar pela <b>Entrega</b> (requisitos e provas), abrir um <b>Documento</b> ou um <b>site de referência</b> pelo <b>+</b> do painel.</p></div>`;
  const stat=!!(plan && plan.kind==='static');
  const title=stat?'Ver a página funcionando':'Subir ambiente';
  const det=s.details?`<div class="envdet"><div class="envdeth">como liga: <code>${esc((plan&&plan.label)||v.label||'—')}</code></div><pre class="mono envlog">${esc(s.log==null?'carregando…':(s.log||'(vazio)'))}</pre></div>`:'';
  const detBtn=`<button type="button" class="lnk envdetbtn" data-env="details" aria-expanded="${s.details?'true':'false'}">${s.details?'esconder detalhes':'ver detalhes'}</button>`;
  if(v.fail){
    return `<div class="envcard envfail" role="alert"><div class="envh">Não consegui ligar o site</div><p class="envsub">${esc(v.fail.msg)}</p>
      <div class="envacts"><button type="button" class="btn primary" data-env="agent">pedir pro agente resolver</button><button type="button" class="btn" data-env="up">tentar de novo</button>${detBtn}</div>${det}</div>`;
  }
  if(v.running || s.busy){
    const rows=envStepRows(v, plan);
    return `<div class="envcard envrun" aria-live="polite"><div class="envh">${stat?'Abrindo a página':'Ligando o site desta demanda'}</div>
      <ol class="envsteps">${rows.map(r=>`<li class="envst ${r.st}"><span class="envmk" aria-hidden="true">${r.st==='done'?'✓':r.st==='cur'?'<span class="spin"></span>':r.st==='fail'?'!':'·'}</span><span>${esc(r.label)}</span>${r.st==='done'?'<span class="sr-only"> (feito)</span>':''}</li>`).join('')}</ol>
      <div class="envacts"><button type="button" class="btn sm" data-env="down">parar</button>${detBtn}</div>${det}</div>`;
  }
  const sub=stat?'Mostra a página deste projeto aqui dentro — sem instalar nada.'
    : `Liga o site desta demanda aqui dentro, numa porta só dela${plan&&plan.install?' (antes instala o que falta)':''}. Você vê a página assim que ela responder.`;
  return `<div class="envcard envidle"><button type="button" class="envbig" data-env="up"><span class="envbigic" aria-hidden="true">▶</span><span><b>${title}</b><span class="envbigsub">${esc(sub)}</span></span></button>
    <div class="envalt">${detBtn}<span class="dim">ou peça pro agente subir — ele aparece aqui sozinho</span></div>${det}</div>`;
}
// faixa do topo do painel quando o ambiente é DO Starfork (no ar / subindo): onde está + reiniciar · parar · detalhes
function envStripHtml(view){
  const v=view||{}; if(!(v.running||v.ready)) return '';
  const host=v.url?String(v.url).replace(/^https?:\/\//,'').replace(/\/$/,''):'';
  return `<div class="envstrip${v.ready?' on':''}"><span class="envdot" aria-hidden="true"></span><span>${v.ready?'no ar':'subindo'}${host?` · <span class="mono">${esc(host)}</span>`:''}</span><span style="flex:1"></span><button type="button" class="lnk" data-env="restart">reiniciar</button><button type="button" class="lnk" data-env="down">parar</button><button type="button" class="lnk" data-env="details">detalhes</button></div>`;
}
// o que o AGENTE recebe no "pedir pro agente resolver" (o fim do log vai junto — é o que ele precisa)
function envAgentMsg(view, plan){
  const f=(view&&view.fail)||{}; const tail=String(f.tail||'').split('\n').slice(-40).join('\n');
  return `O "Subir ambiente" desta demanda falhou: ${f.msg||'o site não ligou'}\n`+
    `Como o Starfork tentou ligar: ${(plan&&plan.label)||(view&&view.label)||'?'} (porta própria da worktree no env PORT).\n\n`+
    'Fim do log:\n```\n'+tail+'\n```\n\n'+
    'Descubra a causa, corrija na worktree e rode de novo pra confirmar. Se o jeito certo de ligar o projeto for outro, grave '+
    '`.cardume/env.json` com {"cmd": "...", "install": "...", "port": N, "path": "/"} (use $PORT no cmd). Me avise quando estiver pronto.';
}
// @amb-puro-fim

const ENV={}; // taskId → { plan, view, details, log, busy }
function envSt(id){ return ENV[id]||(ENV[id]={ plan:undefined, view:null, details:false, log:null, busy:false, planAt:0 }); }
function envPlanEnsure(taskId){
  const s=envSt(taskId); if(s.plan!==undefined || s.planLoading) return;
  s.planLoading=true;
  invoke('env_detect',{ taskId }).then(p=>{ s.plan=p||null; }).catch(()=>{ s.plan=null; }).finally(()=>{ s.planLoading=false; s.planAt=Date.now(); envPaint(taskId); if(typeof cvOnEnvPlan==='function') cvOnEnvPlan(taskId); });
  // estado de um ambiente que já estava subindo (o painel remontou)
  invoke('env_status',{ taskId }).then(v=>{ if(v && (v.running||v.fail)){ s.view=Object.assign({}, v, { steps:v.steps||[] }); envPaint(taskId); if(v.ready&&v.url) envOpen(taskId, v.url); } }).catch(()=>{});
}
// o painel vazio (chamado pela Prévia quando não há site): nunca branco, nunca só um campo de endereço
function envEmptyFor(taskId){ return ()=>{ envPlanEnsure(taskId); return envCardHtml(envSt(taskId)); }; }
// pinta todos os painéis desta demanda (cartão + faixa) — guardado: só troca o que mudou
function envPaint(taskId){
  if(typeof nvPaint==='function') nvPaint(taskId);
  const s=envSt(taskId); const h=envStripHtml(s.view);
  document.querySelectorAll('.envstriphost[data-envtask="'+(window.CSS&&CSS.escape?CSS.escape(taskId):taskId)+'"]').forEach(el=>{ if(el.__html!==h){ el.__html=h; el.innerHTML=h; } });
}
function envOpen(taskId, url){ if(typeof nvGo==='function') nvGo(taskId, url, true); }
async function envUp(taskId){
  const s=envSt(taskId); if(s.busy) return;
  s.busy=true; s.view=envApply(null, { ev:'step', step:'detect' }); envPaint(taskId);
  try{ const v=await invoke('env_up',{ taskId }); if(v && v.ready && v.url){ s.view=Object.assign({}, s.view, v); envOpen(taskId, v.url); } }
  catch(e){ s.view=envApply(s.view, { ev:'fail', code:'start', msg:humanErr?humanErr(e,'Não consegui ligar o site').msg:'Não consegui ligar o site.', tail:String(e&&e.message||e) }); }
  finally{ s.busy=false; envPaint(taskId); }
}
async function envDown(taskId, quiet){
  const s=envSt(taskId);
  try{ await invoke('env_down',{ taskId }); }catch(e){ if(!quiet) showErr(e, 'Não consegui parar o site'); return; }
  s.view=null; s.busy=false;
  const st=(typeof nvState!=='undefined')?nvState[taskId]:null;
  if(st && typeof nvStop==='function'){ nvStop(taskId); st.addr=''; st.err=''; } // a prévia era do ambiente: volta pro cartão
  envPaint(taskId);
}
async function envDetails(taskId){
  const s=envSt(taskId); s.details=!s.details; s.log=null; envPaint(taskId);
  if(!s.details) return;
  try{ const v=await invoke('env_status',{ taskId, log:true }); s.log=(v&&v.log)||''; }catch(e){ s.log=String(e&&e.message||e); }
  envPaint(taskId);
}
async function envAskAgent(taskId){
  const s=envSt(taskId); if(typeof fwSendText!=='function') return;
  if(await fwSendText(taskId, envAgentMsg(s.view, s.plan))) toast('mandei o erro pro agente — veja na conversa','ok');
}
// cliques do cartão/faixa (delegados na raiz do painel — o HTML é refeito a cada passo)
function envWire(root, taskId){
  if(!root || root.__envWired===taskId) return; root.__envWired=taskId;
  root.addEventListener('click', (e)=>{
    const b=e.target.closest('[data-env]'); if(!b || !root.contains(b)) return;
    const tid=root.dataset.envtask||taskId; const k=b.dataset.env;
    if(k==='up') envUp(tid);
    else if(k==='down') envDown(tid);
    else if(k==='restart'){ envDown(tid, true).then(()=>envUp(tid)); }
    else if(k==='details') envDetails(tid);
    else if(k==='agent') envAskAgent(tid);
  });
}
// painel "Meu app" de UMA demanda: faixa do ambiente + a prévia (que, vazia, mostra o cartão)
function appRender(taskId, el){
  if(el.dataset.envtask!==taskId || !el.querySelector('.nvhost')){
    el.innerHTML=`<div class="apppane"><div class="envstriphost" data-envtask="${escA(taskId)}"></div><div class="nvhost"></div></div>`;
    el.dataset.envtask=taskId; el.__envWired=null;
  }
  envWire(el, taskId);
  const host=el.querySelector('.nvhost');
  if(typeof nvRender==='function') nvRender(taskId, host, { empty:envEmptyFor(taskId) });
  envPaint(taskId);
}
// progresso do supervisor (evento do Rust, sem polling)
try{ window.__TAURI__.event.listen('env-progress', (ev)=>{
  const p=ev&&ev.payload; if(!p||!p.taskId) return;
  const s=envSt(p.taskId);
  s.view=envApply(s.view, p);
  if(p.ev==='ready' && p.url) envOpen(p.taskId, p.url);
  if(p.ev==='exit' || (p.ev==='end' && !s.view.fail)){ const st=(typeof nvState!=='undefined')?nvState[p.taskId]:null; if(st && typeof nvStop==='function'){ nvStop(p.taskId); st.addr=''; } }
  if(s.details && (p.ev==='fail'||p.ev==='exit')){ s.details=false; } // reabre limpo
  envPaint(p.taskId);
}); }catch(_){ }
// fim da demanda (refresh que já existe) / aba fechada: o ambiente dela morre junto
function envSweep(snap){
  const tasks=(snap&&snap.tasks)||[];
  for(const id of Object.keys(ENV)){ const s=ENV[id]; if(!s.view || !(s.view.running||s.view.ready)) continue;
    const t=tasks.find(x=>x.id===id); if(!t || (typeof taskIsDone==='function' && taskIsDone(t)) || ['merged','cancelled','abandoned'].includes(t.status)) envDown(id, true); }
}
function envOnTaskTabClose(taskId){ const s=ENV[taskId]; if(s && s.view && (s.view.running||s.view.ready)) envDown(taskId, true); }
