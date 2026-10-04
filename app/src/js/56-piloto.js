// Starfork — 56-piloto: CONSTRUIR SOZINHO (ex-Piloto automático) + PROGRESSO DO PILOTO (F4 · G2)
// O piloto deixou de ser porta própria: é a escolha "construir sozinho" no FIM de todo caminho de App novo da
// Fábrica (uma frase, ideia, opções). A aba "piloto" é esse fim de caminho (Fábrica › Nova sessão › construir):
// "Seguir à mão" (cria o projeto e abre a Nova demanda com o pedido) | "Construir sozinho" (autopilot_start).
// TETO OBRIGATÓRIO (dono 04/10): o botão fica desligado até haver um teto em US$ > 0 — o Rust (cap_check) e o motor
// (apCapCheck) recusam igual. A IA vem do SELETOR ÚNICO (iaPick) — acabou o texto livre de modelo.
// A aba "pilotorun" mostra o progresso lendo o .cardume/autopilot/state.json (autopilot_status): etapas, tarefas,
// tentativas, provas e custo. Parar = arquivo STOP; Continuar = roda o CLI de novo (com teto novo, se quiser).

// @piloto-puro-inicio
const PILOTO_PLATFORMS=[
  { k:'web', name:'Web', desc:'roda no navegador' },
  { k:'ios', name:'iOS', desc:'Simulador do Xcode' },
  { k:'android', name:'Android', desc:'emulador Android' },
  { k:'mobile', name:'iOS + Android', desc:'Expo (React Native)' },
];
const PILOTO_ENGINES=[['claude','Claude'],['codex','Codex'],['deepseek','DeepSeek (beta)'],['gateway','IA da sua empresa (gateway)']];
const PILOTO_PHASES=[['creating','Criar o projeto'],['planning','Planejar'],['building','Construir'],['final','Verificação final'],['report','Relatório']];
const PILOTO_END={ done:'Concluído', stopped:'Parado', budget:'Parou no teto', failed:'Falhou' };
// vocabulário (mesa-ia §6.9): "na main" → integrada; "mergeando" → integrando; "onda" → etapa
const PILOTO_STAGE={ pending:'na fila', running:'rodando', verify:'conferindo provas', merge:'integrando', merged:'integrada', blocked:'bloqueada' };
const PILOTO_FORM0={ idea:'', platform:'web', name:'', engine:'claude', model:'', parallel:2, attempts:3, budget:'', end:'auto', gh:false, ghTouched:false }; // GitHub só vem marcado com conta conectada (pilGhDefault)
// limites — os MESMOS do motor (src/autopilot.ts AP_MAX_*) e do Rust (autopilot.rs AP_MAX_*)
const PILOTO_MAX_PAR=4, PILOTO_MAX_ATT=5;
// "40", "40,5", "1.234,50", "7.5" → número; vazio → null; lixo → NaN
const pilotoMoney=v=>parseUsd(v); // o parser ÚNICO de dinheiro (00-util): "2,5" = "2.5"; "1.000" = 1000; já arredonda nos centavos
// TETO OBRIGATÓRIO — a MESMA regra do motor (apCapCheck) e do Rust (cap_check). spent>0 = retomada.
function pilotoCapCheck(input, spent){
  const v=pilotoMoney(input);
  if(v===null) return { ok:false, err:'Defina um teto: o piloto para sozinho quando chegar nele.' };
  if(!(v>0)) return { ok:false, err:'O teto precisa ser um valor em US$ maior que 0.' }; // v já vem arredondado (0,004 → 0 → recusa)
  if(+spent>0 && v<=+spent) return { ok:false, err:`O novo teto precisa ser maior que o já gasto (${pilotoUsd(spent)}).` };
  return { ok:true, cap:v };
}
// sugestão de teto pela previsão grosseira: ~US$ 6 por tarefa, arredondado pra cima de 10 em 10 (mín. US$ 20)
function pilotoCapSuggest(nTasks){ const n=Math.max(1, Math.round(+nTasks||6)); return Math.max(20, Math.ceil(n*6/10)*10); }
// formulário → argumentos do autopilot_start (ou o erro em linguagem de gente)
function pilotoValidate(f){
  f=f||{};
  const idea=String(f.idea||'').trim();
  if(idea.length<8) return { ok:false, err:'Descreva a ideia do app em uma frase (ex.: "recriar o jogo Pou").', field:'pilIdea' };
  const platform=PILOTO_PLATFORMS.some(p=>p.k===f.platform)?f.platform:'';
  if(!platform) return { ok:false, err:'Escolha a plataforma.' };
  const parallel=Math.round(+f.parallel), attempts=Math.round(+f.attempts);
  if(!(parallel>=1 && parallel<=PILOTO_MAX_PAR)) return { ok:false, err:`Tarefas ao mesmo tempo: de 1 a ${PILOTO_MAX_PAR}.` };
  if(!(attempts>=1 && attempts<=PILOTO_MAX_ATT)) return { ok:false, err:`Tentativas por tarefa: de 1 a ${PILOTO_MAX_ATT}.` };
  const cap=pilotoCapCheck(f.budget, 0);
  if(!cap.ok) return { ok:false, err:cap.err, field:'pilBudget' };
  const engine=PILOTO_ENGINES.some(e=>e[0]===f.engine)?f.engine:'claude';
  return { ok:true, args:{ idea, platform, name:String(f.name||'').trim()||null, engine, model:String(f.model||'').trim()||null, parallel, attempts, budgetUsd:cap.cap } };
}
const pilotoUsd=v=>'US$ '+(+v||0).toFixed(2).replace('.',',');
function pilotoBrl(v){ return typeof fmtUsdBr==='function'?fmtUsdBr(+v||0):pilotoUsd(v); }
const PIL_CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6"/></svg>';
// etapas (o mesmo visual dos passos da Ideia e da Tarefa): ok/atual/próxima/parou aqui
function pilotoStagesHtml(items){ // [{label, st:'done'|'now'|'next'|'stop'|'fail', small?}]
  return `<div class="g2stages" role="list">${items.map((it,i)=>`${i?`<span class="g2stl${items[i-1].st==='done'?' d':''}" aria-hidden="true"></span>`:''}<div class="g2stg ${it.st}" role="listitem"${it.st==='now'?' aria-current="step"':''}><span class="c">${it.st==='done'?PIL_CHECK:''}</span><b>${esc(it.label)}</b>${it.small?`<small>${esc(it.small)}</small>`:''}</div>`).join('')}</div>`;
}
// FIM DE CAMINHO (App novo): "Seguir à mão" | "Construir sozinho" + formulário com teto obrigatório.
// o = { f:form, busy, err, src:'frase'|'ideia', nTasks, summary, back:{label,id}?, ideaEditable }
// o.idp = prefixo dos ids (o MESMO formulário vive em duas abas: "pil" no Construir, "ipil" na Ideia › Projeto)
function pilotoEndHtml(o){
  o=o||{}; const f=Object.assign({}, PILOTO_FORM0, o.f||{}), auto=f.end!=='hand', n=+o.nTasks||0, I=o.idp||'pil';
  const cap=pilotoCapCheck(f.budget, 0), sug=pilotoCapSuggest(n||6);
  const plats=PILOTO_PLATFORMS.map(p=>`<button type="button" class="g2rad${p.k===f.platform?' on':''}" data-pil-plat="${p.k}" aria-pressed="${p.k===f.platform}" title="${escA(p.desc)}">${esc(p.name)}${o.votada===p.k?' <small>(votada)</small>':''}</button>`).join('');
  const opt=(k,t,d,extra)=>`<div class="g2eopt${(k==='auto')===auto?' on':''}" data-pil-eo="${k}"><label class="g2eol"><input type="radio" class="g2eor" name="${I}End" value="${k}" data-pil-eor="${k}"${(k==='auto')===auto?' checked':''}><h4><span class="ias-rd" aria-hidden="true"></span>${t}</h4><p>${d}</p></label>${extra||''}</div>`;
  const ghRow=`<label class="ias-chk g2ghrow"><input type="checkbox" id="${I}Gh"${f.gh?' checked':''}> guardar também no GitHub (privado)</label>`;
  const idea=o.ideaEditable===false?'':`<div class="g2fld"><label for="${I}Idea">O app numa frase</label><textarea id="${I}Idea" class="in g2ta" rows="3" placeholder="ex.: recriar o jogo Pou — um bichinho que você alimenta, dá banho e coloca pra dormir">${esc(f.idea)}</textarea></div>`;
  const ia=`<div class="g2fld"><span class="g2lb">IA</span><div class="g2row"><span id="${I}Ia"></span><span class="g2help">vale pra todas as tarefas do piloto</span></div></div>`;
  const form=`<div class="g2card g2autoform" id="${I}AutoForm"${auto?'':' hidden'}>`
    +`<div class="g2g2"><div class="g2fld"><label for="${I}Name">Nome do projeto</label><input id="${I}Name" class="in" type="text" value="${escA(f.name)}" placeholder="derivado da ideia"><span class="g2help">pasta nova em Documentos › Starfork, só no seu computador (sem GitHub)</span></div>`
    +`<div class="g2fld"><span class="g2lb" id="${I}PlatL">Plataforma</span><div class="g2radios" role="group" aria-labelledby="${I}PlatL">${plats}</div></div></div>`
    +`<div class="g2g2">${ia}<div class="g2g2"><div class="g2fld"><label for="${I}Par">Tarefas ao mesmo tempo</label><select id="${I}Par" class="in">${[1,2,3,4].map(x=>`<option${+f.parallel===x?' selected':''}>${x}</option>`).join('')}</select></div>`
    +`<div class="g2fld"><label for="${I}Att">Tentativas por tarefa</label><select id="${I}Att" class="in">${[1,2,3,4,5].map(x=>`<option${+f.attempts===x?' selected':''}>${x}</option>`).join('')}</select></div></div></div>`
    +`<div class="g2fld g2cap"><label for="${I}Budget">Teto de custo (US$) <small>— obrigatório</small></label><input id="${I}Budget" class="in${cap.ok?'':' err'}" type="text" inputmode="decimal" value="${escA(f.budget)}" placeholder="ex.: ${escA(String(sug))},00" aria-describedby="${I}CapErr" aria-invalid="${!cap.ok}">`
    +`<span class="g2errt" id="${I}CapErr"${cap.ok?' hidden':''}>${esc(cap.ok?'':cap.err)}</span>`
    +`<span class="g2help">${n?`previsão pra ${n} tarefa${n===1?'':'s'}: <b>${esc(typeof fmtCostRange==='function'?fmtCostRange(n*3, n*6):pilotoUsd(n*3)+'–'+pilotoUsd(n*6))}</b> (estimativa) · `:''}sugerido: <button type="button" class="lnk" id="${I}CapSug" data-cap="${sug}">usar US$ ${sug},00</button> · o piloto para entre passos quando chegar nele</span></div>`
    +`</div>`;
  const why=auto?(cap.ok?'pronto pra construir':'falta o teto'):'cria o projeto e abre a Nova demanda';
  return `<div class="g2end">${idea}<h3 class="g2h3">Como construir?</h3>`
    +`<div class="g2endopts">${opt('hand','Seguir à mão', o.src==='ideia'?`Cria o projeto e o épico${n?` com ${n} tarefas`:''} em rascunho. Você inicia cada uma quando quiser, como qualquer demanda.`:'Cria o projeto e abre a Nova demanda com o seu pedido — você conversa e aprova cada tarefa.', ghRow)}`
    +`${opt('auto','Construir sozinho','O Starfork cria o projeto, planeja e constrói sem perguntar. Cada tarefa precisa passar nas provas. Para no teto.')}</div>`
    +form
    +(o.summary?`<div class="g2warnline">${o.summary}</div>`:'')
    +(o.err?`<div class="g2err" role="alert">${esc(o.err)}</div>`:'')
    +`<div class="g2pfoot"><span class="g2msg" id="${I}CapMsg">${esc(why)}</span><span class="g2sp"></span>${o.back?`<button type="button" class="btn quiet" id="${escA(o.back.id)}">${esc(o.back.label)}</button>`:''}<button type="button" class="btn primary" id="${I}Go"${o.busy||(auto&&!cap.ok)?' disabled':''}>${o.busy?'Criando o projeto…':auto?'Construir sozinho':'Criar o projeto'}</button></div></div>`;
}
// compat: o formulário antigo virou o fim de caminho
function pilotoFormHtml(f, busy, err){ return pilotoEndHtml({ f, busy, err, src:'frase' }); }
function pilotoPhaseIdx(phase){ const i=PILOTO_PHASES.findIndex(p=>p[0]===phase); return i<0?(phase in PILOTO_END?PILOTO_PHASES.length:0):i; }
function pilotoEnded(st){ return !!st && (st.phase in PILOTO_END) && !st.alive; }
// "Continuar": parado no TETO precisa de um teto novo (> gasto); parado por você pode manter o teto ou subir
function pilotoResumeArgs(st, budgetInput){
  if(!st) return { ok:true, args:{} };
  const empty=pilotoMoney(budgetInput)===null, cap=+st.budgetUsd||0, spent=+st.costUsd||0;
  if(empty){
    if(st.phase==='budget') return { ok:false, err:'Informe o novo teto em US$ — maior que o já gasto.' };
    if(!(cap>0)) return { ok:false, err:'Defina um teto pra continuar — o piloto não roda sem teto.' };
    if(cap<=spent) return { ok:false, err:`O teto de ${pilotoUsd(cap)} já foi gasto (${pilotoUsd(spent)}) — defina um teto maior pra continuar.` };
    return { ok:true, args:{} };
  }
  const c=pilotoCapCheck(budgetInput, +st.costUsd||0);
  return c.ok?{ ok:true, args:{ budgetUsd:c.cap } }:{ ok:false, err:c.err };
}
function pilotoProgSteps(st){
  const pi=pilotoPhaseIdx(st.phase), ended=st.phase in PILOTO_END, done=st.phase==='done';
  const reached=!ended?pi:(done?PILOTO_PHASES.length:pilotoPhaseIdx(st.lastPhase&&!(st.lastPhase in PILOTO_END)?st.lastPhase:'building'));
  const tasks=st.tasks||[], merged=tasks.filter(t=>t.stage==='merged').length;
  return PILOTO_PHASES.map(([k,l],i)=>({ label:l, st:i<reached?'done':(!ended&&i===pi)?'now':(ended&&!done&&i===reached)?(st.phase==='failed'?'fail':'stop'):'next',
    small:(k==='building'&&tasks.length&&i===pi&&!ended)?`${merged} de ${tasks.length}`:(ended&&!done&&i===reached)?`${PILOTO_END[st.phase].toLowerCase()} aqui`:'' }));
}
// progresso: etapas, números, caixa do teto, tarefas por etapa, linha do tempo. ui = { waiting, budget }
function pilotoProgHtml(st, ui){
  ui=ui||{};
  if(!st) return `<div class="g2empty"><b>Nenhum piloto aberto.</b><p>O piloto nasce no fim de um caminho de App novo da Fábrica ("construir sozinho"). O de cada projeto também aparece na lateral, como "Piloto · nome".</p><button type="button" class="btn primary" data-pil-act="fabrica">Abrir a Fábrica</button></div>`;
  const ended=st.phase in PILOTO_END;
  const status=ended?PILOTO_END[st.phase]:(st.alive?'rodando':'parado (o processo não está vivo)');
  const tasks=st.tasks||[];
  const waves={}; for(const t of tasks){ const w=t.final?'final':String(t.wave||0); (waves[w]=waves[w]||[]).push(t); }
  const order=Object.keys(waves).sort((a,b)=>(a==='final')-(b==='final')||(+a)-(+b));
  const merged=tasks.filter(t=>t.stage==='merged').length;
  const fails=tasks.reduce((a,t)=>a+(t.history||[]).filter(h=>!h.ok).length,0);
  const cards=order.map((w,wi)=>`<div class="g2wave"><h4>${w==='final'?'Verificação final':(w==='0'?'Etapa 0 · esqueleto':'Etapa '+esc(w))}${w!=='final'&&w!=='0'&&wi>0&&waves[order[wi-1]].some(t=>t.stage!=='merged')?' <span>começa quando a anterior terminar</span>':''}</h4><div class="g2wlist">`+waves[w].map(t=>{
      const fl=(t.history||[]).filter(h=>!h.ok).length;
      const why=(t.stage==='blocked'||t.stage==='running')&&(t.reasons||[]).length?`<span class="g2rej">${esc(t.reasons.slice(0,2).join(' · '))}</span>`:'';
      return `<div class="g2ptask pil-s-${esc(t.stage)}"><div class="t1"><button type="button" class="lnk" data-pil-task="${escA(t.id)}" title="abrir a tarefa">${esc(t.title)}</button><span class="g2status s-${esc(t.stage)}">${esc(PILOTO_STAGE[t.stage]||t.stage)}</span></div>`
        +`<small>${t.stage==='pending'?'ainda não começou':`tentativa ${Math.max(1,t.attempts||0)}/${st.attempts}`}${fl?` · ${fl} reprovada${fl===1?'':'s'}`:''}</small>${why}</div>`;
    }).join('')+'</div></div>').join('');
  const evs=(st.events||[]).slice(-14).reverse().map(e=>`<li class="${e.ok===false?'bad':''}">${e.at?`<time>${esc(new Date(e.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}))}</time>`:''}<span>${esc(e.text)}</span></li>`).join('');
  const cap=+st.budgetUsd>0;
  // parado (por você ou pelo teto): caixa com o teto novo
  let capbox='';
  // processo NÃO vivo e trabalho não concluído (parado, teto, falha ou o app/CLI caiu no meio): sempre dá pra continuar
  if(!st.alive && st.phase!=='done' && !st.starting){
    const spentOk=cap && (+st.budgetUsd>(+st.costUsd||0));
    const val=ui.budget==null?(st.phase!=='budget'&&spentOk?String(st.budgetUsd).replace('.',','):''):ui.budget;
    const msg=st.phase==='budget'?`<b>Parou no teto (${esc(pilotoUsd(st.budgetUsd))}).</b> Pra continuar, defina um teto maior que o já gasto (${esc(pilotoUsd(st.costUsd))}).`
      :st.phase==='stopped'?`<b>Parado por você.</b> Pra continuar, mantenha o teto ou defina um novo, maior que o já gasto (${esc(pilotoUsd(st.costUsd))}).`
      :!cap?`<b>Este piloto não tem teto.</b> Defina um pra continuar.`
      :st.phase==='failed'?`<b>Falhou.</b> Dá pra continuar de onde parou${spentOk?'':` — o teto já foi gasto (${esc(pilotoUsd(st.costUsd))}): defina um maior`}.`
      :`<b>O processo do piloto parou no meio</b> (o app ou o computador fechou). Continue de onde parou${spentOk?'':` com um teto maior que o já gasto (${esc(pilotoUsd(st.costUsd))})`}.`;
    capbox=`<div class="g2capbox"><span>${msg}</span><div class="g2row"><label class="g2sr" for="pilNewBudget">Novo teto (US$)</label><input class="in" id="pilNewBudget" type="text" inputmode="decimal" value="${escA(val)}" placeholder="ex.: ${escA(((+st.budgetUsd||0)*1.5||20).toFixed(2).replace('.',','))}"><button type="button" class="btn sm primary" data-pil-act="resume"${ui.waiting||st.starting?' disabled':''}>${ui.waiting||st.starting?'Retomando…':'Continuar'}</button><span class="g2help">maior que o já gasto · obrigatório</span></div></div>`;
  }
  const acts=[];
  if(st.alive && !st.stopRequested) acts.push('<button type="button" class="btn" data-pil-act="stop">Parar depois do passo atual</button>');
  if(st.alive && st.stopRequested) acts.push('<span class="g2help">parando depois do passo atual…</span>');
  acts.push('<button type="button" class="btn icon quiet" data-pil-act="more" title="Mais: abrir relatório · abrir o projeto · abrir pasta" aria-label="Mais ações" aria-haspopup="menu">'+((typeof IC!=='undefined'&&IC.dots)||'⋯')+'</button>');
  const name=st.name||st.epicTitle||'Piloto';
  const head=(typeof pageHead==='function')?pageHead({ title:'Piloto · '+name, scope:'projeto', scopeLabel:name,
      sum:`<span class="g2status s-${ended?esc(st.phase):'running'}" id="pilSt">${esc(status)}</span>${st.idea?` <span>“${esc(String(st.idea).slice(0,90))}”</span>`:''}`, right:acts.join('') })
    :`<div class="g2ph"><h1>Piloto · ${esc(name)}</h1><span>${esc(status)}</span>${acts.join('')}</div>`;
  return `${head}<div class="g2pil"><div class="g2pil-main">`
    +pilotoStagesHtml(pilotoProgSteps(st))
    +`<div class="g2nums"><div class="g2num"><b>${merged} de ${tasks.length||'—'}</b><span>tarefas prontas e integradas</span></div>`
    +`<div class="g2num"><b>${esc(pilotoUsd(st.costUsd))}</b><span title="custo das tarefas (livro de uso)">${cap?`de ${esc(pilotoUsd(st.budgetUsd))} · ≈ R$ ${esc(((+st.costUsd||0)*(typeof usdBrlRate==='function'?usdBrlRate():5.5)).toFixed(2).replace('.',','))}`:'sem teto (piloto antigo)'}</span></div>`
    +`<div class="g2num"><b>${fails} reprovaç${fails===1?'ão':'ões'}</b><span>${fails?'refeitas com o motivo':'nenhuma até aqui'}</span></div>`
    +`<div class="g2num"><b>${st.parallel||'—'} ao mesmo tempo</b><span>até ${st.attempts||'—'} tentativas por tarefa</span></div></div>`
    +(st.stopReason&&ended?`<div class="g2err" role="status">${esc(st.stopReason)}</div>`:'')
    +capbox
    +(cards||'<div class="g2help">planejando as tarefas…</div>')
    +`<div class="g2help g2dir mono">${esc(String(st.dir||'').replace(/^\/Users\/[^/]+/,'~'))}</div>`
    +`</div><aside class="g2rpanel"><div class="g2rtabs"><b>Linha do tempo</b></div><ul class="g2tline">${evs||'<li class="dim"><span>nada ainda</span></li>'}</ul></aside></div>`;
}
// @piloto-puro-fim

// título da aba de fim de caminho (o 15-config é da casca; aqui só o rótulo)
if(typeof VIEW_META!=='undefined'){ if(VIEW_META.piloto) VIEW_META.piloto.title='Construir'; if(VIEW_META.pilotorun) VIEW_META.pilotorun.title='Piloto'; }
let PIL_FORM=Object.assign({}, PILOTO_FORM0), PIL_BUSY=false, PIL_ERR='', PIL_IA=null;
const PIL_RUN={ dir:'', st:null, err:'', timer:0, seq:0, wait:null, budget:null };
const PIL_WAIT_MS=30000;
function pilCall(){ return typeof invokeQuiet==='function'?invokeQuiet:invoke; }
function pilErr(e, what){ return (typeof humanErr==='function')?humanErr(e, what).msg:(what+': '+String(e&&e.message||e)); }
// GitHub marcado por padrão SÓ com uma conta conectada (gh_owners); quem desmarcou à mão fica desmarcado
function pilGhDefault(){ return typeof ghOwnersSt!=='undefined' && Array.isArray(ghOwnersSt.list) && ghOwnersSt.list.length>0; }
function pilGhLoad(form, rerender){ if(typeof ghOwnersSt==='undefined' || !ghOwnersSt.load) return; ghOwnersSt.load().then(()=>{ if(!form.ghTouched && form.gh!==pilGhDefault()){ form.gh=pilGhDefault(); rerender(); } }).catch(()=>{}); }
function pilReadForm(){
  const v=id=>{ const el=document.getElementById(id); return el?el.value:undefined; };
  const set=(k,id)=>{ const x=v(id); if(x!==undefined) PIL_FORM[k]=x; };
  set('idea','pilIdea'); set('name','pilName'); set('parallel','pilPar'); set('attempts','pilAtt'); set('budget','pilBudget');
  const g=document.getElementById('pilGh'); if(g && typeof g.checked==='boolean' && g.checked!==PIL_FORM.gh){ PIL_FORM.gh=g.checked; PIL_FORM.ghTouched=true; }
  if(PIL_IA && PIL_IA.get){ const x=PIL_IA.get(); PIL_FORM.engine=x.engine; PIL_FORM.model=x.model; }
  else set('engine','pilEngine');
}
function pilHead(){
  const crumb=`<nav class="g2crumb" aria-label="Você está em"><button type="button" data-pil-go="fabrica">Fábrica</button>›<button type="button" data-pil-go="nova">Nova sessão</button>› construir</nav>`;
  return (typeof pageHead==='function')?crumb+pageHead({ title:'Construir', scope:'computador', sum:'<span>fim do caminho de App novo: seguir à mão ou construir sozinho</span>' }):crumb+'<h1>Construir</h1>';
}
function pilRenderForm(){
  const b=document.getElementById('pilBody'); if(!b) return;
  const ae=document.activeElement, fid=ae&&b.contains(ae)&&ae.id?ae.id:null;
  b.innerHTML=`<div class="g2page">${pilHead()}<div class="g2scroll">`+pilotoEndHtml({ f:PIL_FORM, busy:PIL_BUSY, err:PIL_ERR, src:'frase' })+'</div></div>';
  const host=document.getElementById('pilIa');
  if(host && typeof iaPick==='function') PIL_IA=iaPick(host, { value:{ engine:PIL_FORM.engine, model:PIL_FORM.model }, scope:'piloto', onChange:v=>{ PIL_FORM.engine=v.engine; PIL_FORM.model=v.model; } });
  if(fid){ const el=document.getElementById(fid); if(el && el.focus){ el.focus(); try{ const n=String(el.value||'').length; el.setSelectionRange&&el.setSelectionRange(n,n); }catch(_){ } } }
}
// teto digitado: o botão/erro acompanham sem redesenhar a aba (o foco fica no campo)
function pilCapLive(){
  const i=document.getElementById('pilBudget'); if(!i) return;
  PIL_FORM.budget=i.value;
  const c=pilotoCapCheck(i.value, 0), auto=PIL_FORM.end!=='hand';
  i.classList.toggle('err', !c.ok); i.setAttribute('aria-invalid', String(!c.ok));
  const e=document.getElementById('pilCapErr'); if(e){ e.hidden=c.ok; e.textContent=c.ok?'':c.err; }
  const g=document.getElementById('pilGo'); if(g) g.disabled=PIL_BUSY||(auto&&!c.ok);
  const m=document.getElementById('pilCapMsg'); if(m) m.textContent=auto?(c.ok?'pronto pra construir':'falta o teto'):'cria o projeto e abre a Nova demanda';
}
// estado da aba (instância múltipla)
window.TAB_STATE_piloto={ get:()=>{ pilReadForm(); return { form:Object.assign({}, PIL_FORM), _title:PIL_FORM.name?('Construir: '+PIL_FORM.name):'' }; }, set:(st)=>{ PIL_FORM=Object.assign({}, PILOTO_FORM0, (st&&st.form)||{}); } };
function openPiloto(){
  const ov=document.getElementById('pilotoOverlay'); if(!ov) return;
  // texto levado (Fábrica "Já sei o que quero", Nova demanda antiga) vira a ideia
  if(window.ndTakeCarry){ const t=window.ndTakeCarry(); if(t) PIL_FORM.idea=t; }
  if(window.__pilPreset){ Object.assign(PIL_FORM, window.__pilPreset); window.__pilPreset=null; }
  if(!PIL_FORM.iaSet && typeof aiDefaults==='function'){ const d=aiDefaults(), e=typeof aiEngineOf==='function'?aiEngineOf(d.eng):'claude'; PIL_FORM.engine=e==='mock'?'claude':e; PIL_FORM.model=d.model||''; PIL_FORM.iaSet=true; } // começa na IA padrão (seletor único)
  PIL_ERR=''; pilRenderForm(); pilGhLoad(PIL_FORM, ()=>pilRenderForm());
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  pilWireForm();
  setTimeout(()=>{ const t=document.getElementById('pilIdea'); if(t && !t.value) t.focus(); }, 30);
}
window.openPiloto=openPiloto;
// Fábrica › App novo › "Já sei o que quero" → fim de caminho já com a frase e a plataforma
function pilotoOpenWith(preset){ window.__pilPreset=Object.assign({}, preset||{}); if(window.openTab) window.openTab('piloto'); }
window.pilotoOpenWith=pilotoOpenWith;
async function pilStart(){
  pilReadForm();
  if(PIL_FORM.end==='hand') return pilHand();
  const r=pilotoValidate(PIL_FORM);
  if(!r.ok){ PIL_ERR=r.err; pilRenderForm(); const f=r.field&&document.getElementById(r.field); if(f) try{ f.focus(); }catch(_){ } return; }
  PIL_BUSY=true; PIL_ERR=''; pilRenderForm();
  try{
    // F5 · P14: política da org (Empresa) — portão obrigatório recusa aqui, em palavra; o resto vai pro motor
    const op=typeof window.orgPolForPilot==='function'?await window.orgPolForPilot():null;
    const res=await pilCall()('autopilot_start', op?Object.assign({}, r.args, { orgPolicy:op }):r.args);
    const dir=typeof res==='string'?res:(res&&res.dir)||'';
    PIL_BUSY=false; PIL_FORM=Object.assign({}, PILOTO_FORM0); pilRenderForm();
    pilSetDir(dir); pilWaitStart();
    if(typeof toast==='function') toast(res&&res.warning?res.warning:'Projeto criado · o piloto começou — acompanhe em "Piloto" (também na lateral).', res&&res.warning?'warn':'ok');
    if(window.switchProject){ try{ await window.switchProject(dir); }catch(_){ } }
    if(window.openTab) window.openTab('pilotorun');
  }catch(e){ PIL_BUSY=false; PIL_ERR=pilErr(e,'Não consegui começar o piloto'); pilRenderForm(); }
}
// "Seguir à mão" a partir de uma frase: pasta nova (o mesmo do "O que você quer fazer?") + Nova demanda com o pedido
async function pilHand(){
  const idea=String(PIL_FORM.idea||'').trim();
  if(idea.length<8){ PIL_ERR='Descreva o app em uma frase antes de criar o projeto.'; pilRenderForm(); return; }
  const slug=(typeof emSlug==='function'?emSlug(PIL_FORM.name||idea):'')||'meu-projeto';
  PIL_BUSY=true; PIL_ERR=''; pilRenderForm();
  try{
    let path;
    if(PIL_FORM.gh){ const target=String(await invoke('quick_project_target',{ name:slug })||''); path=await invoke('create_project',{ parent:target.replace(/[\\/][^\\/]+$/,''), name:target.split(/[\\/]/).pop(), github:true, private:true, owner:'' }); }
    else path=await invoke('quick_create_project',{ name:slug });
    if(typeof selected!=='undefined') selected=null; if(typeof lastSig!=='undefined') lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches();
    try{ await refresh(); }catch(_){ } if(typeof loadProjects==='function') try{ await loadProjects(); }catch(_){ }
    PIL_BUSY=false; PIL_FORM=Object.assign({}, PILOTO_FORM0); pilRenderForm();
    if(typeof toast==='function') toast('Projeto criado em '+String(path||'').replace(/^\/Users\/[^/]+/,'~')+' — siga pela Nova demanda.','ok');
    if(window.plStartWith) window.plStartWith(idea, { replace:true });
  }catch(e){ PIL_BUSY=false; PIL_ERR=(typeof emErrMsg==='function')?emErrMsg(String(e&&e.message||e)).msg:pilErr(e,'Não consegui criar o projeto'); pilRenderForm(); }
}
function pilWireForm(){
  const b=document.getElementById('pilBody'); if(!b || b.__pilWired) return; b.__pilWired=true;
  b.addEventListener('click', ev=>{
    const t=ev.target; if(!t.closest) return;
    const p=t.closest('[data-pil-plat]'); if(p){ pilReadForm(); PIL_FORM.platform=p.dataset.pilPlat; pilRenderForm(); return; }
    const eo=t.closest('[data-pil-eor]'); if(eo){ pilReadForm(); PIL_FORM.end=eo.dataset.pilEor; pilRenderForm(); return; }
    if(t.closest('#pilCapSug')){ const i=document.getElementById('pilBudget'); if(i){ i.value=t.closest('#pilCapSug').dataset.cap+',00'; pilCapLive(); i.focus(); } return; }
    const go=t.closest('[data-pil-go]'); if(go){ if(window.fabOpen) window.fabOpen(go.dataset.pilGo==='nova'?'nova':'sessoes'); return; }
    if(t.closest('#pilGo')) pilStart();
  });
  b.addEventListener('input', ev=>{ if(ev.target && ev.target.id==='pilBudget') pilCapLive(); });
}

// ---------- aba de progresso ----------
function pilSetDir(dir){ PIL_RUN.dir=dir||''; PIL_RUN.st=null; try{ if(typeof lsSet==='function') lsSet('piloto:dir', PIL_RUN.dir); else localStorage.setItem('piloto:dir', PIL_RUN.dir); }catch(_){ } pilotoDirsAdd(PIL_RUN.dir); }
// todas as pastas de piloto deste computador (Fábrica › Sessões lista TODOS, não só o último)
function pilotoDirs(){ try{ const raw=(typeof lsGet==='function'?lsGet('piloto:dirs'):localStorage.getItem('piloto:dirs'))||'[]'; const l=JSON.parse(raw); const last=(typeof lsGet==='function'?lsGet('piloto:dir'):localStorage.getItem('piloto:dir'))||''; return [...new Set((Array.isArray(l)?l:[]).concat(last?[last]:[]))].filter(Boolean); }catch(_){ return []; } }
function pilotoDirsAdd(dir){ if(!dir) return; try{ const l=pilotoDirs().filter(x=>x!==dir); l.unshift(dir); const v=JSON.stringify(l.slice(0,30)); if(typeof lsSet==='function') lsSet('piloto:dirs', v); else localStorage.setItem('piloto:dirs', v); }catch(_){ } }
window.pilotoDirs=pilotoDirs;
function pilSavedDir(){ try{ return (typeof lsGet==='function'?lsGet('piloto:dir'):localStorage.getItem('piloto:dir'))||''; }catch(_){ return ''; } }
function pilRenderRun(){
  const b=document.getElementById('pilRunBody'); if(!b) return;
  const nb=document.getElementById('pilNewBudget'); if(nb) PIL_RUN.budget=nb.value; // o valor digitado sobrevive à releitura
  const fid=document.activeElement&&b.contains(document.activeElement)?document.activeElement.id:'';
  b.innerHTML=`<div class="g2page">`+(PIL_RUN.err?`<div class="g2err" role="alert">${esc(PIL_RUN.err)}</div>`:'')+pilotoProgHtml(PIL_RUN.st, { waiting:!!PIL_RUN.wait, budget:PIL_RUN.budget })+'</div>';
  if(fid){ const el=document.getElementById(fid); if(el&&el.focus) el.focus(); }
  // título da aba = "Piloto · nome" (a aba de progresso é única)
  try{ const st=PIL_RUN.st, t=(typeof TABS!=='undefined'?TABS:[]).find(x=>x.kind==='pilotorun'); if(t && st){ const nt=('Piloto · '+(st.name||st.epicTitle||'')).slice(0,28); if(t.title!==nt){ t.title=nt; if(typeof renderTabs==='function') renderTabs(); } } }catch(_){ }
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
  const name=st.epicTitle||st.name||'Piloto';
  const msg=st.phase==='done'?`Piloto concluído: ${name} — veja o relatório.`:`Piloto ${PILOTO_END[st.phase].toLowerCase()}: ${name}${st.stopReason?' — '+st.stopReason:''}`;
  if(typeof toast==='function') toast(msg, st.phase==='done'?'ok':'warn');
  if(typeof pushNotif==='function') try{ pushNotif('Starfork — piloto', msg); }catch(_){ }
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
  // só o visível roda: lê enquanto a aba está à mostra e o piloto não acabou (ou acabou de ser retomado)
  if(pilVisible() && (waiting || !(PIL_RUN.st && pilotoEnded(PIL_RUN.st)))) PIL_RUN.timer=setTimeout(pilPoll, waiting?1000:2500);
}
async function openPilotoRun(){
  const ov=document.getElementById('pilotoRunOverlay'); if(!ov) return;
  // quem abriu pela linha "Piloto · nome" da lateral escolhe a pasta
  if(window.__pilRunDir){ pilSetDir(window.__pilRunDir); window.__pilRunDir=''; PIL_RUN.wait=null; }
  else {
    // o piloto do PROJETO ABERTO vem primeiro; sem piloto nele, o último lembrado
    let cur='';
    if(typeof state!=='undefined' && state && state.repo){ try{ await pilCall()('autopilot_status', { dir:state.repo }); cur=state.repo; }catch(_){ } }
    if(cur){ if(cur!==PIL_RUN.dir){ PIL_RUN.dir=cur; PIL_RUN.st=null; PIL_RUN.wait=null; } }
    else if(!PIL_RUN.dir) PIL_RUN.dir=pilSavedDir();
  }
  if(typeof ovShow==='function') ovShow(ov); else ov.style.display='flex';
  pilWireRun(); pilRenderRun(); pilPoll();
}
window.openPilotoRun=openPilotoRun;
function pilotoRunOpen(dir){ window.__pilRunDir=dir||''; if(window.openTab) window.openTab('pilotorun'); }
window.pilotoRunOpen=pilotoRunOpen;
async function pilAct(act, anchor){
  const call=pilCall(), dir=PIL_RUN.dir;
  if(act==='fabrica'){ if(window.fabOpen) window.fabOpen('nova'); return; }
  if(!dir) return;
  try{
    if(act==='stop'){ await call('autopilot_stop', { dir }); if(typeof toast==='function') toast('O piloto termina o passo atual e para.','ok'); }
    else if(act==='resume'){
      const nb=document.getElementById('pilNewBudget'); if(nb) PIL_RUN.budget=nb.value;
      const r=pilotoResumeArgs(PIL_RUN.st, PIL_RUN.budget);
      if(!r.ok){ PIL_RUN.err=r.err; pilRenderRun(); return; }
      PIL_RUN.err=''; pilWaitStart(); pilRenderRun(); // botão desligado enquanto a rodada nova não aparece
      try{ await call('autopilot_resume', Object.assign({ dir }, r.args)); }
      catch(e){ PIL_RUN.wait=null; throw e; }
      PIL_RUN.budget=null;
      if(typeof toast==='function') toast('Piloto retomado de onde parou.','ok');
      pilPoll(); return;
    }
    else if(act==='more'){
      const st=PIL_RUN.st||{};
      if(typeof g2SheetMenu==='function') g2SheetMenu(anchor, [
        { label:'Abrir relatório', hint:st.hasReport?'AUTOPILOT.md':'ainda não foi escrito', disabled:!st.hasReport, fn:()=>pilAct('report') },
        { label:'Abrir o projeto', hint:'troca pro projeto e mostra a Central', fn:()=>pilAct('project') },
        { label:'Abrir pasta', hint:String(dir).replace(/^\/Users\/[^/]+/,'~'), fn:()=>invoke('open_folder',{ path:dir }).catch(e=>showErr(e,'Não consegui abrir a pasta')) },
      ]);
      return;
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
    if(a.dataset.pilAct) pilAct(a.dataset.pilAct, a); else if(a.dataset.pilTask) pilOpenTask(a.dataset.pilTask);
  });
  b.addEventListener('keydown', ev=>{ if(ev.key==='Enter' && ev.target && ev.target.id==='pilNewBudget'){ ev.preventDefault(); pilAct('resume'); } });
}
// projeto aberto com piloto: o fim dele vira aviso mesmo com a aba de progresso fechada (troca de projeto ou
// piloto que estava rodando). Leve: só relê quando o projeto muda ou enquanto o piloto dele estava vivo.
const PIL_WATCH={ repo:'', alive:false };
async function pilWatch(){
  const repo=(typeof state!=='undefined' && state && state.repo)||'';
  if(!repo || (repo===PIL_WATCH.repo && !PIL_WATCH.alive)) return;
  PIL_WATCH.repo=repo;
  try{ const st=await pilCall()('autopilot_status', { dir:repo }); PIL_WATCH.alive=!!(st&&st.alive); PIL_WATCH.st=st; pilNoteEnd(repo, st); }
  catch(_){ PIL_WATCH.alive=false; PIL_WATCH.st=null; }
}
window.pilWatch=pilWatch;
// linha "Piloto · nome 3/7" da lateral (26-sidebar é da casca: ela chama isto, guardada) — null = sem piloto no projeto
function pilotoSideRow(){ const st=PIL_WATCH.st; if(!st || PIL_WATCH.repo!==((typeof state!=='undefined'&&state&&state.repo)||'')) return null; const ts=st.tasks||[];
  return { dir:PIL_WATCH.repo, label:'Piloto · '+(st.name||st.epicTitle||''), count:`${ts.filter(t=>t.stage==='merged').length}/${ts.length}`, alive:!!st.alive, phase:st.phase }; }
window.pilotoSideRow=pilotoSideRow;
if(typeof setInterval==='function') setInterval(()=>{ pilWatch().catch(()=>{}); }, 15000);
