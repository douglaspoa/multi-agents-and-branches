// Starfork — 56-piloto: PILOTO AUTOMÁTICO (spec-piloto-automatico) — "app do zero" sem ninguém conduzir.
// Aba "piloto" (um dos jeitos de montar a Nova demanda): ideia + plataforma + nome + IA → "Construir sozinho".
// O núcleo é o motor (`cardume autopilot`, src/autopilot.ts): o app só dispara o CLI desanexado (Rust
// autopilot_start, pasta NOVA em ~/Documents/Starfork) e mostra o progresso na aba "pilotorun", lendo o
// .cardume/autopilot/state.json (autopilot_status): fases, ondas, tarefas, tentativas, provas e custo.
// Parar = arquivo STOP (o piloto termina o passo atual); Continuar = roda o CLI de novo na mesma pasta.

// @piloto-puro-inicio
const PILOTO_PLATFORMS=[
  { k:'web', name:'Web', desc:'roda no navegador' },
  { k:'ios', name:'iOS', desc:'Simulador do Xcode' },
  { k:'android', name:'Android', desc:'emulador Android' },
  { k:'mobile', name:'iOS + Android', desc:'Expo (React Native)' },
];
const PILOTO_ENGINES=[['claude','Claude'],['codex','Codex'],['deepseek','DeepSeek (beta)'],['gateway','Gateway próprio']];
const PILOTO_PHASES=[['creating','Criar o projeto'],['planning','Planejar o épico'],['building','Construir'],['final','Verificação final'],['report','Relatório']];
const PILOTO_END={ done:'Concluído', stopped:'Parado', budget:'Parou por custo', failed:'Falhou' };
const PILOTO_STAGE={ pending:'na fila', running:'rodando', verify:'conferindo provas', merge:'mergeando', merged:'na main', blocked:'bloqueada' };
const PILOTO_FORM0={ idea:'', platform:'web', name:'', engine:'claude', model:'', parallel:2, attempts:2, budget:'' };
// limites — os MESMOS do motor (src/autopilot.ts AP_MAX_*) e do Rust (autopilot.rs AP_MAX_*)
const PILOTO_MAX_PAR=4, PILOTO_MAX_ATT=5;
const pilotoMoney=v=>{ const b=String(v==null?'':v).trim().replace(',','.'); if(!b) return null; const n=+b; return (n>=0 && isFinite(n))?n:NaN; };
// formulário → argumentos do autopilot_start (ou o erro em linguagem de gente)
function pilotoValidate(f){
  f=f||{};
  const idea=String(f.idea||'').trim();
  if(idea.length<8) return { ok:false, err:'Descreva a ideia do app em uma frase (ex.: "recriar o jogo Pou").' };
  const platform=PILOTO_PLATFORMS.some(p=>p.k===f.platform)?f.platform:'';
  if(!platform) return { ok:false, err:'Escolha a plataforma.' };
  const parallel=Math.round(+f.parallel), attempts=Math.round(+f.attempts);
  if(!(parallel>=1 && parallel<=PILOTO_MAX_PAR)) return { ok:false, err:`Tarefas ao mesmo tempo: de 1 a ${PILOTO_MAX_PAR}.` };
  if(!(attempts>=1 && attempts<=PILOTO_MAX_ATT)) return { ok:false, err:`Tentativas por tarefa: de 1 a ${PILOTO_MAX_ATT}.` };
  const budgetUsd=pilotoMoney(f.budget);
  if(Number.isNaN(budgetUsd)) return { ok:false, err:'Teto de custo: um valor em US$ (vazio = padrão de US$ 20).' };
  const engine=PILOTO_ENGINES.some(e=>e[0]===f.engine)?f.engine:'claude';
  return { ok:true, args:{ idea, platform, name:String(f.name||'').trim()||null, engine, model:String(f.model||'').trim()||null, parallel, attempts, budgetUsd } };
}
function pilotoFormHtml(f, busy, err){
  f=Object.assign({}, PILOTO_FORM0, f||{});
  const plats=PILOTO_PLATFORMS.map(p=>`<button type="button" class="pil-plat${p.k===f.platform?' on':''}" data-pil-plat="${p.k}" aria-pressed="${p.k===f.platform}"><b>${esc(p.name)}</b><span class="dim">${esc(p.desc)}</span></button>`).join('');
  const engs=PILOTO_ENGINES.map(([k,n])=>`<option value="${k}"${k===f.engine?' selected':''}>${esc(n)}</option>`).join('');
  return `<div class="pil-wrap">`
    +`<div class="pil-intro"><b>Piloto automático — app do zero.</b> Você dá a ideia; o Starfork cria um projeto novo (só no seu computador, sem GitHub), planeja um épico com tarefas, roda tudo sozinho — sem te perguntar nada —, confere as provas de cada tarefa, refaz o que falhar e junta tudo na main. No fim você recebe o app e um relatório (AUTOPILOT.md).</div>`
    +`<label class="pil-lbl" for="pilIdea">Ideia do app</label>`
    +`<textarea id="pilIdea" class="pil-idea" rows="4" placeholder="ex.: recriar o jogo Pou — um bichinho que você alimenta, dá banho e coloca pra dormir">${esc(f.idea)}</textarea>`
    +`<div class="pil-lbl" id="pilPlatL">Plataforma</div><div class="pil-plats" role="group" aria-labelledby="pilPlatL">${plats}</div>`
    +`<div class="pil-row">`
      +`<label>Nome do projeto <input id="pilName" type="text" value="${escA(f.name)}" placeholder="derivado da ideia"></label>`
      +`<label>IA <select id="pilEngine">${engs}</select></label>`
      +`<label>Modelo <input id="pilModel" type="text" value="${escA(f.model)}" placeholder="padrão"></label>`
    +`</div>`
    +`<div class="pil-row">`
      +`<label>Tarefas ao mesmo tempo <input id="pilPar" type="number" min="1" max="${PILOTO_MAX_PAR}" value="${escA(f.parallel)}"></label>`
      +`<label>Tentativas por tarefa <input id="pilAtt" type="number" min="1" max="${PILOTO_MAX_ATT}" value="${escA(f.attempts)}"></label>`
      +`<label>Teto de custo (US$) <input id="pilBudget" type="text" inputmode="decimal" value="${escA(f.budget)}" placeholder="padrão US$ 20"></label>`
    +`</div>`
    +`<div class="pil-note dim">A pasta nasce em Documentos › Starfork. Teto de custo: deixe vazio ou ponha 0 pra não ter teto. Ao bater o teto, o piloto para entre passos e escreve o relatório. Dá pra parar e continuar quando quiser.</div>`
    +(err?`<div class="pil-err" role="alert">${esc(err)}</div>`:'')
    +`<div class="pil-foot"><button type="button" class="btn primary" id="pilGo"${busy?' disabled':''}>${busy?'Criando o projeto…':'Construir sozinho'}</button></div>`
    +`</div>`;
}
function pilotoPhaseIdx(phase){ const i=PILOTO_PHASES.findIndex(p=>p[0]===phase); return i<0?(phase in PILOTO_END?PILOTO_PHASES.length:0):i; }
const pilotoUsd=v=>'US$ '+(+v||0).toFixed(2).replace('.',',');
function pilotoEnded(st){ return !!st && (st.phase in PILOTO_END) && !st.alive; }
// "Continuar": parado no TETO precisa de um teto novo (maior que o gasto, ou 0 = sem teto) → argumentos do autopilot_resume
function pilotoResumeArgs(st, budgetInput){
  if(!st || st.phase!=='budget') return { ok:true, args:{} };
  const b=pilotoMoney(budgetInput);
  if(b===null || Number.isNaN(b)) return { ok:false, err:'Informe o novo teto em US$ (ou 0 pra seguir sem teto).' };
  if(b>0 && b<=(+st.costUsd||0)) return { ok:false, err:`O novo teto precisa ser maior que o já gasto (${pilotoUsd(st.costUsd)}) — ou 0 pra seguir sem teto.` };
  return { ok:true, args:{ budgetUsd:b } };
}
// progresso: fases, ondas, tarefas (tentativas, provas reprovadas), custo, eventos e as ações possíveis.
// ui = { waiting (retomando: botão desligado), budget (valor digitado do teto novo) }
function pilotoProgHtml(st, ui){
  ui=ui||{};
  if(!st) return '<div class="dim pil-none">Nenhum piloto automático aberto. Comece em Nova demanda › Piloto automático.</div>';
  const pi=pilotoPhaseIdx(st.phase), ended=st.phase in PILOTO_END, done=st.phase==='done';
  // fim sem sucesso: verde só ATÉ onde chegou; a etapa em que parou/falhou fica marcada
  const reached=!ended?pi:(done?PILOTO_PHASES.length:pilotoPhaseIdx(st.lastPhase&&!(st.lastPhase in PILOTO_END)?st.lastPhase:'building'));
  const endCls=st.phase==='failed'?' fail':' stop';
  const steps=PILOTO_PHASES.map(([k,l],i)=>{
    const ok=i<reached, cur=!ended&&i===pi, here=ended&&!done&&i===reached;
    return `<li class="pil-step${ok?' ok':''}${cur?' cur':''}${here?endCls:''}"${cur?' aria-current="step"':''}>${esc(l)}${here?` <span class="dim">· ${esc(PILOTO_END[st.phase].toLowerCase())} aqui</span>`:''}</li>`;
  }).join('');
  const status=ended?PILOTO_END[st.phase]:(st.alive?'rodando':'parado (o processo não está vivo)');
  const tasks=st.tasks||[];
  const waves={}; for(const t of tasks){ const w=t.final?'final':String(t.wave||0); (waves[w]=waves[w]||[]).push(t); }
  const order=Object.keys(waves).sort((a,b)=>(a==='final')-(b==='final')||(+a)-(+b));
  const merged=tasks.filter(t=>t.stage==='merged').length;
  const cards=order.map(w=>`<div class="pil-wave"><div class="pil-wl">${w==='final'?'Verificação final':(w==='0'?'Onda 0 · esqueleto':'Onda '+esc(w))}</div>`+waves[w].map(t=>{
      const fails=(t.history||[]).filter(h=>!h.ok).length;
      const why=(t.stage==='blocked'||t.stage==='running')&&(t.reasons||[]).length?`<div class="pil-why">${esc(t.reasons.slice(0,2).join(' · '))}</div>`:'';
      return `<div class="pil-task pil-s-${esc(t.stage)}"><div class="pil-tt"><button type="button" class="linklike" data-pil-task="${escA(t.id)}" title="abrir a tarefa">${esc(t.title)}</button><span class="pil-chip">${esc(PILOTO_STAGE[t.stage]||t.stage)}</span></div>`
        +`<div class="pil-meta dim">${t.stage==='pending'?'ainda não começou':`tentativa ${Math.max(1,t.attempts||0)}/${st.attempts}`}${fails?` · ${fails} reprovada${fails===1?'':'s'}`:''}</div>${why}</div>`;
    }).join('')+'</div>').join('');
  const evs=(st.events||[]).slice(-12).reverse().map(e=>`<li class="${e.ok===false?'bad':''}">${esc(e.text)}</li>`).join('');
  const budget=st.budgetUsd>0?` de ${pilotoUsd(st.budgetUsd)}`:'';
  const acts=[];
  if(st.alive && !st.stopRequested) acts.push('<button type="button" class="btn" data-pil-act="stop">Parar</button>');
  if(st.alive && st.stopRequested) acts.push('<span class="dim">parando depois do passo atual…</span>');
  if(!st.alive && st.phase!=='done'){
    if(st.phase==='budget') acts.push(`<label class="pil-budget">Novo teto (US$) <input id="pilNewBudget" type="text" inputmode="decimal" value="${escA(ui.budget==null?'':ui.budget)}" placeholder="ex.: ${escA(((+st.budgetUsd||0)*2||10).toFixed(2))}"></label><span class="dim pil-note">maior que o já gasto, ou 0 = sem teto</span>`);
    acts.push(`<button type="button" class="btn primary" data-pil-act="resume"${ui.waiting||st.starting?' disabled':''}>${ui.waiting||st.starting?'Retomando…':'Continuar'}</button>`);
  }
  if(st.hasReport) acts.push('<button type="button" class="btn" data-pil-act="report">Abrir relatório</button>');
  acts.push('<button type="button" class="btn" data-pil-act="project">Abrir o projeto</button>');
  return `<div class="pil-wrap">`
    +`<div class="pil-head"><div><div class="pil-title">${esc(st.epicTitle||st.name||'Piloto automático')}</div><div class="dim pil-sub">${esc(st.idea||'')}</div></div>`
    +`<div class="pil-kpis"><span><b>${esc(status)}</b></span><span>${merged}/${tasks.length} na main</span><span title="custo das tarefas (livro de uso)">${pilotoUsd(st.costUsd)}${budget}</span></div></div>`
    +`<ol class="pil-steps">${steps}</ol>`
    +(st.stopReason&&ended?`<div class="pil-err" role="status">${esc(st.stopReason)}</div>`:'')
    +`<div class="pil-acts">${acts.join('')}</div>`
    +(cards?`<div class="pil-waves">${cards}</div>`:'<div class="dim pil-none">planejando as tarefas…</div>')
    +(evs?`<div class="pil-lbl">Linha do tempo</div><ul class="pil-evs">${evs}</ul>`:'')
    +`<div class="dim pil-dir">${esc(st.dir||'')}</div>`
    +`</div>`;
}
// @piloto-puro-fim

let PIL_FORM=Object.assign({}, PILOTO_FORM0), PIL_BUSY=false, PIL_ERR='';
const PIL_RUN={ dir:'', st:null, err:'', timer:0, seq:0, wait:null, budget:'' };
const PIL_WAIT_MS=30000;
function pilCall(){ return typeof invokeQuiet==='function'?invokeQuiet:invoke; }
function pilErr(e, what){ return (typeof humanErr==='function')?humanErr(e, what).msg:(what+': '+String(e&&e.message||e)); }
function pilReadForm(){
  const v=id=>{ const el=document.getElementById(id); return el?el.value:undefined; };
  const set=(k,id)=>{ const x=v(id); if(x!==undefined) PIL_FORM[k]=x; };
  set('idea','pilIdea'); set('name','pilName'); set('engine','pilEngine'); set('model','pilModel'); set('parallel','pilPar'); set('attempts','pilAtt'); set('budget','pilBudget');
}
function pilRenderForm(){ const b=document.getElementById('pilBody'); if(b) b.innerHTML=pilotoFormHtml(PIL_FORM, PIL_BUSY, PIL_ERR); }
// estado da aba (instância múltipla, como as outras formas de montar a demanda)
window.TAB_STATE_piloto={ get:()=>{ pilReadForm(); return { form:Object.assign({}, PIL_FORM), _title:'' }; }, set:(st)=>{ PIL_FORM=Object.assign({}, PILOTO_FORM0, (st&&st.form)||{}); } };
function openPiloto(){
  const ov=document.getElementById('pilotoOverlay'); if(!ov) return;
  const seg=document.getElementById('pilSeg'); if(seg && window.ndMethodSeg) seg.innerHTML=window.ndMethodSeg('auto');
  // texto levado do Conversar/Formulário/Dividir vira a ideia
  if(window.ndTakeCarry){ const t=window.ndTakeCarry(); if(t) PIL_FORM.idea=t; }
  PIL_ERR=''; pilRenderForm();
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  pilWireForm();
  setTimeout(()=>{ const t=document.getElementById('pilIdea'); if(t && !t.value) t.focus(); }, 30);
}
window.openPiloto=openPiloto;
async function pilStart(){
  pilReadForm();
  const r=pilotoValidate(PIL_FORM);
  if(!r.ok){ PIL_ERR=r.err; pilRenderForm(); return; }
  PIL_BUSY=true; PIL_ERR=''; pilRenderForm();
  try{
    const res=await pilCall()('autopilot_start', r.args);
    const dir=typeof res==='string'?res:(res&&res.dir)||'';
    PIL_BUSY=false; PIL_FORM=Object.assign({}, PILOTO_FORM0); pilRenderForm();
    pilSetDir(dir); pilWaitStart();
    if(typeof toast==='function') toast(res&&res.warning?res.warning:'Piloto automático começou — acompanhe na aba de progresso.', res&&res.warning?'warn':'ok');
    if(window.switchProject){ try{ await window.switchProject(dir); }catch(_){ } }
    if(window.openTab) window.openTab('pilotorun');
  }catch(e){ PIL_BUSY=false; PIL_ERR=pilErr(e,'Não consegui começar o piloto'); pilRenderForm(); }
}
function pilWireForm(){
  const b=document.getElementById('pilBody'); if(!b || b.__pilWired) return; b.__pilWired=true;
  b.addEventListener('click', ev=>{
    const p=ev.target.closest&&ev.target.closest('[data-pil-plat]');
    if(p){ pilReadForm(); PIL_FORM.platform=p.dataset.pilPlat; pilRenderForm(); return; }
    if(ev.target.closest&&ev.target.closest('#pilGo')) pilStart();
  });
}

// ---------- aba de progresso ----------
function pilSetDir(dir){ PIL_RUN.dir=dir||''; PIL_RUN.st=null; try{ if(typeof lsSet==='function') lsSet('piloto:dir', PIL_RUN.dir); else localStorage.setItem('piloto:dir', PIL_RUN.dir); }catch(_){ } }
function pilSavedDir(){ try{ return (typeof lsGet==='function'?lsGet('piloto:dir'):localStorage.getItem('piloto:dir'))||''; }catch(_){ return ''; } }
function pilRenderRun(){
  const b=document.getElementById('pilRunBody'); if(!b) return;
  const nb=document.getElementById('pilNewBudget'); if(nb) PIL_RUN.budget=nb.value; // o valor digitado sobrevive à releitura
  b.innerHTML=(PIL_RUN.err?`<div class="pil-err" role="alert">${esc(PIL_RUN.err)}</div>`:'')+pilotoProgHtml(PIL_RUN.st, { waiting:!!PIL_RUN.wait, budget:PIL_RUN.budget });
}
// depois de começar/continuar: segue lendo até o estado MUDAR (rodada nova, vivo) — no máx. 30 s
function pilWaitStart(){ const st=PIL_RUN.st; PIL_RUN.wait={ t0:Date.now(), runs:st?st.runs:null, updatedAt:st?st.updatedAt:null }; }
function pilWaiting(st){
  const w=PIL_RUN.wait; if(!w) return false;
  if(Date.now()-w.t0>PIL_WAIT_MS || (st && (st.alive || st.runs!==w.runs || st.updatedAt!==w.updatedAt))){ PIL_RUN.wait=null; return false; }
  return true;
}
// fim de um piloto (concluído/parado/teto/falha) visto pela 1ª vez: aviso no app + notificação do sistema
function pilNoteEnd(dir, st){
  if(!dir || !pilotoEnded(st)) return;
  const key='piloto:fim:'+dir, sig=st.phase+':'+(st.runs||0);
  let seen=null; try{ seen=localStorage.getItem(key); }catch(_){ }
  if(seen===sig) return;
  try{ localStorage.setItem(key, sig); }catch(_){ }
  const name=st.epicTitle||st.name||'Piloto automático';
  const msg=st.phase==='done'?`Piloto automático concluído: ${name} — veja o relatório.`:`Piloto automático ${PILOTO_END[st.phase].toLowerCase()}: ${name}${st.stopReason?' — '+st.stopReason:''}`;
  if(typeof toast==='function') toast(msg, st.phase==='done'?'ok':'warn');
  if(typeof pushNotif==='function') try{ pushNotif('Starfork — piloto automático', msg); }catch(_){ }
}
function pilVisible(){ const ov=document.getElementById('pilotoRunOverlay'); return !!ov && ov.style.display!=='none'; }
async function pilPoll(){
  const seq=++PIL_RUN.seq; clearTimeout(PIL_RUN.timer);
  if(!PIL_RUN.dir){ pilRenderRun(); return; }
  let st=null;
  try{ st=await pilCall()('autopilot_status', { dir:PIL_RUN.dir }); if(seq!==PIL_RUN.seq) return; PIL_RUN.st=st; PIL_RUN.err=''; }
  catch(e){ if(seq!==PIL_RUN.seq) return; if(!PIL_RUN.wait) PIL_RUN.err=pilErr(e,'Não consegui ler o progresso'); }
  const waiting=pilWaiting(st);
  if(!waiting) pilNoteEnd(PIL_RUN.dir, PIL_RUN.st);
  pilRenderRun();
  // segue lendo enquanto a aba está à mostra e o piloto não acabou — ou acabou de ser retomado e o estado
  // ainda é o da rodada anterior (antes: lia 600 ms depois, via o "parado" velho e não lia mais)
  if(pilVisible() && (waiting || !(PIL_RUN.st && pilotoEnded(PIL_RUN.st)))) PIL_RUN.timer=setTimeout(pilPoll, waiting?1000:2500);
}
async function openPilotoRun(){
  const ov=document.getElementById('pilotoRunOverlay'); if(!ov) return;
  // o piloto do PROJETO ABERTO vem primeiro; sem piloto nele, o último lembrado
  let cur='';
  if(typeof state!=='undefined' && state && state.repo){ try{ await pilCall()('autopilot_status', { dir:state.repo }); cur=state.repo; }catch(_){ } }
  if(cur){ if(cur!==PIL_RUN.dir){ PIL_RUN.dir=cur; PIL_RUN.st=null; PIL_RUN.wait=null; } }
  else if(!PIL_RUN.dir) PIL_RUN.dir=pilSavedDir();
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  pilWireRun(); pilRenderRun(); pilPoll();
}
window.openPilotoRun=openPilotoRun;
async function pilAct(act){
  const call=pilCall(), dir=PIL_RUN.dir; if(!dir) return;
  try{
    if(act==='stop'){ await call('autopilot_stop', { dir }); if(typeof toast==='function') toast('O piloto termina o passo atual e para.','ok'); }
    else if(act==='resume'){
      const nb=document.getElementById('pilNewBudget'); if(nb) PIL_RUN.budget=nb.value;
      const r=pilotoResumeArgs(PIL_RUN.st, PIL_RUN.budget);
      if(!r.ok){ PIL_RUN.err=r.err; pilRenderRun(); return; }
      PIL_RUN.err=''; pilWaitStart(); pilRenderRun(); // botão desligado enquanto a rodada nova não aparece
      try{ await call('autopilot_resume', Object.assign({ dir }, r.args)); }
      catch(e){ PIL_RUN.wait=null; throw e; }
      PIL_RUN.budget='';
      if(typeof toast==='function') toast('Piloto retomado de onde parou.','ok');
      pilPoll(); return;
    }
    else if(act==='report'){ await call('autopilot_open_report', { dir }); return; }
    else if(act==='project'){ if(window.switchProject && (typeof state==='undefined' || state.repo!==dir)) await window.switchProject(dir); if(window.openTab) window.openTab('flow'); return; }
  }catch(e){ PIL_RUN.err=pilErr(e,'Não deu'); }
  setTimeout(pilPoll, 600);
}
async function pilOpenTask(id){
  const dir=PIL_RUN.dir;
  try{ if(window.switchProject && typeof state!=='undefined' && state.repo!==dir) await window.switchProject(dir); }catch(_){ }
  if(typeof openWorkspace==='function') openWorkspace(id);
}
function pilWireRun(){
  const b=document.getElementById('pilRunBody'); if(!b || b.__pilWired) return; b.__pilWired=true;
  b.addEventListener('click', ev=>{
    const a=ev.target.closest&&ev.target.closest('[data-pil-act],[data-pil-task]'); if(!a) return;
    if(a.dataset.pilAct) pilAct(a.dataset.pilAct); else if(a.dataset.pilTask) pilOpenTask(a.dataset.pilTask);
  });
}
// projeto aberto com piloto: o fim dele vira aviso mesmo com a aba de progresso fechada (troca de projeto ou
// piloto que estava rodando). Leve: só relê quando o projeto muda ou enquanto o piloto dele estava vivo.
const PIL_WATCH={ repo:'', alive:false };
async function pilWatch(){
  const repo=(typeof state!=='undefined' && state && state.repo)||'';
  if(!repo || (repo===PIL_WATCH.repo && !PIL_WATCH.alive)) return;
  PIL_WATCH.repo=repo;
  try{ const st=await pilCall()('autopilot_status', { dir:repo }); PIL_WATCH.alive=!!(st&&st.alive); pilNoteEnd(repo, st); }
  catch(_){ PIL_WATCH.alive=false; }
}
window.pilWatch=pilWatch;
if(typeof setInterval==='function') setInterval(()=>{ pilWatch().catch(()=>{}); }, 15000);
if(typeof bindClick==='function'){
  bindClick('pilotoClose', ()=>{ if(typeof ovHide==='function') ovHide('pilotoOverlay'); });
  bindClick('pilotoRunClose', ()=>{ if(typeof ovHide==='function') ovHide('pilotoRunOverlay'); });
}
