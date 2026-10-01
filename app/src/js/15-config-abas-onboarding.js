// Starfork — 15-config-abas-onboarding
// ---------- configurações (⌘,) ----------
// fecha Configurações: como ABA fecha a aba (esconder o overlay deixava a aba ativa EM BRANCO); como modal, esconde
function cfgHide(){ const o=$id('cfgOverlay'); if(o&&o.classList.contains('astab')) closeTabOfKind('cfg'); else if(o) o.style.display='none'; }
// @puro-inicio cfgValidate — valores do formulário (texto dos inputs) → null (ok) ou { field, msg } do 1º problema
function cfgValidate(v){
  const num=x=>String(x==null?'':x).trim()===''?NaN:Number(String(x).replace(',','.'));
  const n={ cap:num(v.cap), cost:num(v.cost), brl:num(v.brl), slots:num(v.slots), retry:num(v.retry) };
  if(!(n.cap>=0)) return { field:'cfgCap', msg:'O teto por tarefa precisa ser um número maior ou igual a 0 (0 = sem teto).' };
  if(!(n.cost>=0)) return { field:'cfgCost', msg:'O aviso de custo precisa ser um número maior ou igual a 0 (0 desliga).' };
  if(!(n.brl>0)) return { field:'cfgBrl', msg:'A cotação do dólar precisa ser maior que zero.' };
  if(!(Number.isInteger(n.slots) && n.slots>=1 && n.slots<=12)) return { field:'cfgSlots', msg:'Tarefas ao mesmo tempo: um número inteiro de 1 a 12.' };
  if(!(Number.isInteger(n.retry) && n.retry>=0 && n.retry<=240)) return { field:'cfgLimitRetry', msg:'Retomar depois do limite: de 0 a 240 minutos (0 desliga).' };
  return null;
}
// @puro-fim cfgValidate
// modelos da retro (aprendizado contínuo) — uma lista só; valor do settings.json fora dela vira opção (não é trocado no salvar)
const RETRO_MODELS=[['claude-sonnet-5','Sonnet 5 (padrão)'],['claude-haiku-4-5-20251001','Haiku 4.5 (mais barato)']];
function retroModelSelect(sel, v){
  v=String(v==null?'':v).trim(); if(!v) return;
  if(![...sel.options].some(x=>x.value===v)){ const o=document.createElement('option'); o.value=v; o.textContent=v+' (personalizado)'; sel.appendChild(o); }
  sel.value=v;
}
function openCfg(){
  const body=$id('cfgBody');
  body.innerHTML=`
    <div class="seclbl2">Custo <span class="dim cfgsecd">· quanto cada tarefa pode gastar e como o valor aparece</span></div>
    <div class="cfggrid">
      <div class="cfgf"><label for="cfgCap">Teto por tarefa</label>
        <div class="cfgin"><span class="dim">US$</span><input class="in" id="cfgCap" type="number" min="0" step="1" value="${escA(String(costCapDefault()))}"><span class="dim" id="cfgCapBrl"></span></div>
        <p class="cfghint">Ao chegar nele a tarefa pausa e pergunta se continua. 0 = sem teto. Dá pra mudar por tarefa ao criar.</p></div>
      <div class="cfgf"><label for="cfgCost">Aviso de custo</label>
        <div class="cfgin"><span class="dim">US$</span><input class="in" id="cfgCost" type="number" min="0" step="5" value="${escA(lsGet('costWarn')||'25')}"></div>
        <p class="cfghint">Só avisa quando uma tarefa passa desse valor — não pausa. 0 desliga.</p></div>
      <div class="cfgf"><label for="cfgBrl">Cotação do dólar</label>
        <div class="cfgin"><span class="dim">R$</span><input class="in" id="cfgBrl" type="number" min="0.5" step="0.05" value="${escA(String(usdBrlRate()))}"><span class="dim">por US$ 1</span></div>
        <p class="cfghint">Só pra mostrar o "≈ R$" ao lado do custo em dólar.</p></div>
    </div>
    <div class="seclbl2" style="margin-top:22px">Execução <span class="dim cfgsecd">· quantas tarefas rodam juntas e o que fazer no limite da IA</span></div>
    <div class="cfggrid">
      <div class="cfgf"><label for="cfgSlots">Tarefas ao mesmo tempo</label>
        <div class="cfgin"><input class="in" id="cfgSlots" type="number" min="1" max="12" value="${escA(String(slotMax))}"><span class="dim">de 1 a 12</span></div>
        <p class="cfghint">Mais tarefas em paralelo terminam antes, mas pesam na máquina e no limite de uso da IA.</p></div>
      <div class="cfgf"><label for="cfgLimitRetry">Retomar depois do limite da IA</label>
        <div class="cfgin"><span class="dim">a cada</span><input class="in" id="cfgLimitRetry" type="number" min="0" max="240" step="5" value="60"><span class="dim">min</span></div>
        <p class="cfghint">Quando a conta bate o limite de uso, a tarefa espera e tenta de novo sozinha. 0 desliga.</p></div>
    </div>
    <div class="seclbl2" style="margin-top:22px">Issues <span class="dim cfgsecd">· links dos códigos de issue</span></div>
    <div class="cfgf"><label for="cfgIssueBase">Endereço base das issues</label>
      <input class="in" id="cfgIssueBase" placeholder="ex.: https://linear.app/sua-empresa/issue" value="${escA(lsGet('issueBase')||'')}" style="max-width:560px">
      <p class="cfghint">Com ele, um código como FND-853 na tarefa vira link pra base/FND-853.</p></div>
    <div class="seclbl2" style="margin-top:20px">Sua IA <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· qual IA roda as demandas novas — estado, configuração, teste e modelo de cada uma</span></div>
    <div id="suaIaCfg"></div>
    <div id="raHost"></div>
    <div class="seclbl2" style="margin-top:20px">GitHub <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· a conta ativa abre os PRs e faz o push — troque ao mudar de empresa/conta</span></div>
    <div id="ghHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Navegador dos agentes</div>
    <label class="cfgck" style="display:flex;gap:9px;align-items:flex-start;margin-top:8px;text-transform:none;letter-spacing:0;font-weight:400;cursor:pointer"><input type="checkbox" id="cfgBrowserVisible" style="margin-top:3px"><span>Mostrar a janela do navegador <span class="dim">— por padrão ele roda em segundo plano (tarefas em paralelo não disputam a tela). Ligue quando precisar fazer login ou assumir a navegação; vale pras próximas execuções.</span></span></label>
    <div class="seclbl2" style="margin-top:20px">Previsão</div>
    <label class="cfgck" style="display:flex;gap:9px;align-items:flex-start;margin-top:8px;text-transform:none;letter-spacing:0;font-weight:400;cursor:pointer"><input type="checkbox" id="cfgEstimate" checked style="margin-top:3px"><span>Previsão de tempo e tokens antes de rodar <span class="dim">— no "montar conversando", a IA dimensiona cada requisito e o histórico do repo converte em minutos, tokens e custo. Desligado: nenhuma chamada extra de IA.</span></span></label>
    <div class="seclbl2" style="margin-top:20px">Aprendizado contínuo <span class="dim cfgsecd">· no fim de cada tarefa uma retro relê o que aconteceu (suas correções, retrabalho) e propõe notas pro cérebro e skills do projeto</span></div>
    <div class="cfggrid">
      <div class="cfgf"><label for="cfgLearnMode">Modo</label>
        <select class="in" id="cfgLearnMode"><option value="sugerir">Sugerir (você revisa na Memória)</option><option value="auto">Automático (aplica sozinho)</option><option value="desligado">Desligado</option></select>
        <p class="cfghint">Sugerir: as propostas esperam seu aceite na aba Memória. Desligado: nenhuma chamada extra de IA no fim da tarefa.</p></div>
      <div class="cfgf"><label for="cfgRetroModel">Modelo da retro</label>
        <select class="in" id="cfgRetroModel">${RETRO_MODELS.map(([v,l])=>'<option value="'+escA(v)+'">'+l+'</option>').join('')}</select>
        <p class="cfghint">Roda uma vez por tarefa, quando ela chega em review.</p></div>
    </div>
    <div class="seclbl2" style="margin-top:20px">Notificações <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· avisos de tarefa pronta, plano pra aprovar, falha — clicar abre a tarefa</span></div>
    <div id="notifHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Versão <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· o app procura versão nova sozinho a cada 2 min (e quando você volta pra janela) — ou agora, aqui</span></div>
    <div id="updHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Espaço em disco <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· pasta de trabalho do Starfork deste projeto <span class="mono" style="font-size:10.5px">(.cardume/)</span> — aprendizados ficam, o resto pode ir</span></div>
    <div id="wsHost" style="margin-top:8px"></div>
    <div class="seclbl2" style="margin-top:20px">Sistema</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn sm" id="cfgEnv">${ic('pulse')}verificar ambiente</button>
      ${(canSeeDevTools()||lsGet('sb:url'))?'<button class="btn sm" id="cfgBackend" title="avançado: aponta o app pra outro servidor (dev/admin)">servidor da conta…</button>':''}
      <button class="btn sm" id="cfgTour">rever o tour</button>
    </div>
    <div class="cfgsavebar"><span class="dim" id="cfgDirty"></span><span style="flex:1"></span><button class="btn primary" id="cfgSave">salvar</button></div>`;
  // carrega o intervalo de retomada salvo (settings.json via Rust)
  invoke('read_settings').then(s=>{ try{ const o=JSON.parse(s||'{}'); const el=$id('cfgLimitRetry'); if(el && o.limitRetryMin!=null && o.limitRetryMin!=='') el.value=String(o.limitRetryMin); const bv=$id('cfgBrowserVisible'); if(bv) bv.checked=(o.browserVisible===true||o.browserVisible==='1'||o.browserVisible==='true'); const es=$id('cfgEstimate'); if(es) es.checked=!(o.estimateEnabled===false||o.estimateEnabled==='0'||o.estimateEnabled==='false'); const lm=$id('cfgLearnMode'); if(lm && ['sugerir','auto','desligado'].includes(o.learnMode)) lm.value=o.learnMode; const rm=$id('cfgRetroModel'); if(rm) retroModelSelect(rm, o.retroModel); }catch(_){} }).catch(()=>{});
  { const cap=$id('cfgCap'), brl=$id('cfgBrl'), out=$id('cfgCapBrl');
    const upd=()=>{ const v=Math.max(0, parseFloat(cap.value)||0), r=parseFloat(brl.value)||usdBrlRate(); out.textContent=v>0?'≈ R$ '+fmtNumBR(v*r,true):'sem teto'; };
    cap.oninput=upd; brl.oninput=upd; upd(); }
  // "alterações não salvas" só pros campos que dependem do botão salvar: IA padrão, gateway, GitHub, versão e
  // disco se salvam sozinhos — antes mexer neles acendia o aviso (e o salvar não fazia nada com eles)
  { const SELF='#suaIaCfg,#raHost,#ghHost,#updHost,#wsHost,#notifHost';
    const mark=e=>{ if(e && e.target && e.target.closest && e.target.closest(SELF)) return; const d=$id('cfgDirty'); if(d) d.textContent='alterações não salvas'; };
    body.oninput=mark; body.onchange=mark; }
  $id('cfgSave').onclick=async()=>{
    const btn=$id('cfgSave'); if(btn.disabled) return;
    const v={ cap:$id('cfgCap').value, cost:$id('cfgCost').value, brl:$id('cfgBrl').value, slots:$id('cfgSlots').value, retry:$id('cfgLimitRetry').value };
    // valor fora da faixa: avisa e foca o campo (antes era ajustado em silêncio — 0 tarefas virava 4, -3 virava 0)
    const bad=cfgValidate(v); if(bad){ toast(bad.msg,'warn'); const f=$id(bad.field); if(f) f.focus(); return; }
    const N=x=>Number(String(x).replace(',','.'));
    lsSet('costWarn', String(N(v.cost))); lsSet('costCap', String(N(v.cap))); lsSet('usdBrl', String(N(v.brl)));
    lsSet('issueBase', $id('cfgIssueBase').value.trim()); setSlotMax(N(v.slots));
    lastSig=''; // o que já foi gravado vale agora, mesmo se o resto falhar
    // settings.json (Rust): cada chave no seu try — a falha diz QUAL não gravou (antes: .catch(()=>{}) e "salvas")
    const bv=$id('cfgBrowserVisible'), fails=[];
    btn.disabled=true; btn.textContent='salvando…';
    const w=async(key, value, nome)=>{ try{ await invoke('write_setting',{ key, value }); }catch(e){ fails.push({ nome, e }); } };
    await w('limitRetryMin', String(N(v.retry)), 'retomar depois do limite da IA');
    if(bv) await w('browserVisible', bv.checked?'1':'0', 'mostrar a janela do navegador');
    { const es=$id('cfgEstimate'); if(es){ await w('estimateEnabled', es.checked?'1':'0', 'previsão de tempo e tokens'); if(typeof estSetEnabled==='function') estSetEnabled(es.checked); } }
    { const lm=$id('cfgLearnMode'), rm=$id('cfgRetroModel'); if(lm) await w('learnMode', lm.value, 'modo do aprendizado contínuo'); if(rm) await w('retroModel', rm.value, 'modelo da retro'); }
    btn.disabled=false; btn.textContent='salvar';
    if(fails.length){ const d=$id('cfgDirty'); if(d) d.textContent='não salvou: '+fails.map(f=>f.nome).join(' e ');
      showErr(fails[0].e,'Não consegui gravar "'+fails.map(f=>f.nome).join('" e "')+'" — o resto foi salvo'); return; }
    cfgHide(); toast('Configurações salvas','ok'); };
  $id('cfgEnv').onclick=()=>{ cfgHide(); if(window.openTab) openTab('env'); else openEnv(); };
  bindClick('cfgBackend', ()=>{ cfgHide(); cloudCfgOpen=true; if(window.openTab) openTab('conta'); else openCloud(); });
  $id('cfgTour').onclick=()=>{ cfgHide(); openOnboarding(); };
  // Route AI vive no bloco 1 (onde secretsCache/secretSet moram); monta via window
  if(window.routeAiMount) window.routeAiMount();
  if(typeof ghMount==='function') ghMount();
  if(typeof updRenderCfg==='function') updRenderCfg();
  wsMount();
  if(typeof notifCfgMount==='function') notifCfgMount();
  // painel "Sua IA" (30-sua-ia.js) — o MESMO componente do passo de IA do primeiro acesso
  if(typeof suaIaMount==='function') suaIaMount($id('suaIaCfg'), { ctx:'cfg', fresh:true });
  $id('cfgOverlay').style.display='flex';
}
$id('cfgBtn').onclick=openCfg;

// ---------- "Com qual IA?" sem jargão (o seletor é desenhado em 29-ia-picker; aqui só a camada de texto) ----------
// alias / id fixo → "sempre o mais novo" / "versão travada" (o termo técnico fica no tooltip);
// "Mock · sem IA" → "Simulação · sem IA, pra testar" e só aparece em instalação de desenvolvimento (ou se já estiver escolhido).
const AI_PLAIN_TXT=[
  ['Alias = sempre a versão mais nova do seu plano; id fixo trava a versão.', '"Sempre o mais novo" acompanha a versão nova do seu plano; "versão travada" fica sempre na mesma.'],
  ['outro id…','outro modelo…'], ['digite o id exato','digite o nome exato do modelo'],
];
function aiPlainify(root){
  if(!root) return;
  const dev=typeof devInstall!=='undefined' && !!devInstall; // só quem roda o app do código-fonte
  root.querySelectorAll('[data-aieng="mock"]').forEach(b=>{
    const show=dev||b.classList.contains('on'); if(b.style.display!==(show?'':'none')) b.style.display=show?'':'none';
    const n=b.querySelector('.ain'), v=b.querySelector('.aiv');
    if(n&&n.textContent!=='Simulação') n.textContent='Simulação';
    if(v&&v.textContent!=='sem IA, pra testar') v.textContent='sem IA, pra testar';
    if(!b.title) b.title='simula a execução sem chamar nenhum modelo — só pra testar o fluxo do app';
  });
  root.querySelectorAll('.aimodel span').forEach(sp=>{
    const t=sp.textContent; if(!/\balias\b|id fixo/.test(t)) return;
    sp.parentNode.title=/\balias\b/.test(t)?'alias: o Claude Code usa a versão mais nova deste modelo no seu plano':'id fixo: usa exatamente esta versão, mesmo quando sair uma nova';
    sp.textContent=t.replace(/\balias\b/,'sempre o mais novo').replace(/id fixo/,'versão travada');
  });
  const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let nd;
  while((nd=w.nextNode())){ let t=nd.nodeValue, t2=t; AI_PLAIN_TXT.forEach(([a,b])=>{ if(t2.includes(a)) t2=t2.split(a).join(b); }); if(t2!==t) nd.nodeValue=t2; }
}
// o seletor se redesenha sozinho a cada clique → reaplica no mesmo quadro (idempotente: só muda o que ainda está "cru")
function aiPlainWatch(el){
  if(!el||el.__aiPlain) return; el.__aiPlain=true;
  new MutationObserver(()=>aiPlainify(el)).observe(el,{ childList:true, subtree:true });
  aiPlainify(el);
}
window.aiPlainWatch=aiPlainWatch;
['aiPickHow','aiPickInv','aiPickDz'].forEach(id=>aiPlainWatch($id(id)));

// ---------- espaço em disco do .cardume (raio-x + limpeza) ----------
// Regra: aprendizados/estado (MEMORY, HISTORY, RUNBOOK, SPEC, PREFS, policy,
// skills, issue, orchestrations, state.sqlite) NUNCA saem daqui. Worktrees e
// entregáveis de tarefas finalizadas + temporários (logs/why/tmp) podem ir.
let wsUsage=null, wsMsg='';
function fmtBytes(n){ n=Number(n)||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(0)+' KB'; if(n<1073741824) return (n/1048576).toFixed(n<10485760?1:0)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
async function wsMount(){
  const h=$id('wsHost'); if(!h) return;
  if(!state.repo){ h.innerHTML='<div class="dim" style="font-size:12px">abra um projeto pra ver o espaço usado.</div>'; return; }
  h.innerHTML='<div class="dim" style="font-size:12px">medindo a pasta de trabalho do Starfork… (cópias grandes do código levam alguns segundos)</div>';
  // medir de novo com sucesso apaga o erro de uma medição anterior (antes ficava "Não consegui medir" ao lado dos números)
  try{ wsUsage=await invoke('workspace_usage'); if(/^Não consegui medir/.test(wsMsg)) wsMsg=''; }catch(e){ wsUsage=null; wsMsg=humanErr(e,'Não consegui medir o espaço').msg; }
  wsRender();
}
function wsRender(){
  const h=$id('wsHost'); if(!h) return;
  if(!wsUsage){ h.innerHTML=`<div style="font-size:12px;color:var(--warn)">${esc(wsMsg||'sem dados')}</div>`; return; }
  const u=wsUsage, wt=u.worktrees, ar=u.artifacts;
  const trash = (wt.staleBytes||0) + (u.temp||0);
  const row=(label, val, hint, keep)=>`<div style="display:flex;align-items:baseline;gap:10px;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)">
      <span style="font-size:12.5px;${keep?'':''}">${label}</span><span class="dim" style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${hint}</span><b class="mono" style="font-size:12px;${keep?'color:var(--accent)':''}">${fmtBytes(val)}</b></div>`;
  const stale=(wt.items||[]).filter(i=>i.stale).sort((a,b)=>b.bytes-a.bytes).slice(0,6);
  h.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">
      ${row('Aprendizados e estado', u.keep, 'MEMORY · HISTORY · RUNBOOK · SPEC · PREFS · política · skills · issue · planos · banco — <b>sempre mantidos</b>', true)}
      ${row('Entregáveis', ar.bytes, `${ar.count} tarefa${ar.count===1?'':'s'} · ${fmtBytes(ar.staleBytes)} em ${ar.staleCount} finalizada${ar.staleCount===1?'':'s'} (mergeadas/canceladas)`)}
      ${row('Worktrees', wt.bytes, `${wt.count} pasta${wt.count===1?'':'s'} · ${fmtBytes(wt.staleBytes)} em ${wt.staleCount} de tarefa finalizada ou órfã — só lixo`)}
      ${row('Temporários', u.temp, 'logs · cache de explicações (why) · scripts descartáveis (tmp)')}
      ${u.attachments?row('Anexos do chat', u.attachments, 'prints e documentos que você anexou nas conversas — ficam'):''}
      <div style="display:flex;align-items:center;gap:10px;padding:2px 12px 0"><span class="dim" style="font-size:11.5px">total ${fmtBytes(u.total)} · liberável agora: <b style="color:var(--text)">${fmtBytes(trash)}</b> sem perder nada${ar.staleBytes?' · +'+fmtBytes(ar.staleBytes)+' se limpar os entregáveis finalizados':''}</span></div>
      ${stale.length?`<div class="dim mono" style="font-size:10.5px;padding:0 12px;line-height:1.6">${stale.map(i=>esc((i.title||i.id||'').slice(0,48))+' · '+esc(i.status)+' · '+fmtBytes(i.bytes)).join('<br>')}${wt.staleCount>stale.length?'<br>… e mais '+(wt.staleCount-stale.length):''}</div>`:''}
      ${wsMsg?`<div style="font-size:12px;color:${/^✓/.test(wsMsg)?'var(--accent)':'var(--warn)'};padding:0 12px">${esc(wsMsg)}</div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        <button class="btn sm" id="wsCleanTrash"${trash?'':' disabled'}>${ic('folder')}liberar ${fmtBytes(trash)} — worktrees finalizadas + temporários</button>
        <button class="btn sm" id="wsCleanArts"${ar.staleBytes?'':' disabled'}>limpar entregáveis de tarefas finalizadas (${fmtBytes(ar.staleBytes)})</button>
        <button class="btn sm" id="wsRefresh" title="medir de novo">${ic('pulse')}</button>
      </div></div>`;
  bindClick('wsRefresh', wsMount);
  bindClick('wsCleanTrash', ()=>wsClean({ worktrees:true, temp:true, artifacts:false },
    `Liberar ${fmtBytes(trash)}?\n\nRemove ${wt.staleCount} worktree${wt.staleCount===1?'':'s'} de tarefas mergeadas/canceladas/abortadas (ou órfãs) e os temporários (logs parados, cache, tmp).\n\nAprendizados, planos, banco e entregáveis NÃO são tocados. Tarefas em andamento, em review ou com erro ficam intactas.`));
  bindClick('wsCleanArts', ()=>wsClean({ worktrees:false, temp:false, artifacts:true },
    `Apagar os entregáveis de ${ar.staleCount} tarefa${ar.staleCount===1?'':'s'} finalizada${ar.staleCount===1?'':'s'} (${fmtBytes(ar.staleBytes)})?\n\nSão os prints de prova, testes e documentos gerados na pasta de trabalho do Starfork — a tela de Entregas deixa de mostrá-los. O código mergeado e os aprendizados ficam.`));
}
async function wsClean(what, question){
  if(!await askYes(question)) return;
  const h=$id('wsHost'); if(h) h.innerHTML='<div class="dim" style="font-size:12px">limpando…</div>';
  wsMsg='';
  try{ const r=await invoke('workspace_clean', what); wsMsg=`✓ ${fmtBytes(r.freed)} liberados (${r.removed} ${r.removed===1?'item':'itens'})`+((r.errors||[]).length?` · não deu em ${r.errors.length}: ${r.errors.slice(0,2).join('; ')}`:''); }
  catch(e){ wsMsg=humanErr(e,'Não consegui limpar').msg; }
  await wsMount();
}

/* ===== MOTOR DE ABAS (Chrome-style): as views que eram janela viram aba ===== */
// a Nova demanda usa o símbolo da marca (IC.starfork, de 10-core) — typeof: os testes carregam este arquivo sem o 10-core
const SF_TAB_IC=(typeof IC!=='undefined'&&IC.starforkG)||'';
const VIEW_META={
  projetos:{title:'Projetos',icon:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>'},
  orq:{title:'Dividir',icon:'<circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M6 7.2l4.2-2.4M6 8.8l4.2 2.4"/>'},
  nova:{title:'Nova demanda',icon:SF_TAB_IC},
  planner:{title:'Nova demanda',icon:SF_TAB_IC},
  form:{title:'Formulário',icon:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M5.8 6.5h4.4M5.8 8.5h4.4M5.8 10.5h2.6"/>'},
  prefs:{title:'Preferências do projeto',icon:'<path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="11.5" r="1.3" fill="currentColor"/>'},
  task:{title:'Tarefa',icon:'<circle cx="8" cy="8" r="5.2"/><path d="M8 5.4v3l1.9 1"/>'},
  cttask:{title:'Entrega do time',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.2 8.2l1.6 1.6 2.4-2.8"/>'},
  skills:{title:'Skills',icon:'<rect x="2.4" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="9.1" y="2.4" width="4.5" height="4.5" rx="1"/><rect x="2.4" y="9.1" width="4.5" height="4.5" rx="1"/><path d="M11.35 9.3v4.1M9.3 11.35h4.1"/>'},
  issues:{title:'Issues',icon:'<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2v3.4M8 10.6v.05" stroke-linecap="round"/>'},
  issuesbulk:{title:'Nova issue',icon:'<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" stroke-linecap="round"/><path d="M2.6 4.5h.05M2.6 8h.05M2.6 11.5h.05" stroke-linecap="round" stroke-width="1.8"/>'},
  cfg:{title:'Configurações',icon:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8"/>'},
  daily:{title:'Daily',icon:'<rect x="2.5" y="3.5" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5"/>'},
  chat:{title:'Chat do projeto',icon:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>'},
  conta:{title:'Conta e time',icon:'<path d="M4.6 11.8a2.6 2.6 0 0 1 .3-5.18 3.4 3.4 0 0 1 6.6.7 2.3 2.3 0 0 1-.4 4.55z" stroke-linejoin="round"/>'},
  agents:{title:'Agentes & Equipes',icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/>'},
  epic:{title:'Épico',icon:'<path d="M8 2.6l5.2 5.4L8 13.4 2.8 8z" stroke-linejoin="round"/><path d="M5.6 8l1.7 1.7 3.1-3.4"/>'},
  memoria:{title:'Memória',icon:'<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.4A2 2 0 0 0 4.2 12 2 2 0 0 0 8 12.6V3.6A2 2 0 0 0 6 2.8zM10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.4 2 2 0 0 1-1.5 3.8A2 2 0 0 1 8 12.6" stroke-linejoin="round"/>'},
  mesa:{title:'Mesa',icon:'<rect x="2.5" y="7.4" width="11" height="2.6" rx=".8"/><circle cx="4.6" cy="4.4" r="1.3"/><circle cx="8" cy="3.8" r="1.3"/><circle cx="11.4" cy="4.4" r="1.3"/><path d="M4.4 10v3.2M11.6 10v3.2"/>'},
  uso:{title:'Uso',icon:'<path d="M2.5 13.5h11"/><rect x="3.5" y="8" width="2.2" height="4" rx=".5"/><rect x="6.9" y="5" width="2.2" height="7" rx=".5"/><rect x="10.3" y="2.5" width="2.2" height="9.5" rx=".5"/>'},
  env:{title:'Ambiente',icon:'<path d="M8 13.5c-2.5-1.6-5-3.9-5-6.7A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5 2.2c0 2.8-2.5 5.1-5 6.7z" stroke-linejoin="round"/>'},
};
const VIEW_OVERLAY={ memoria:'memOverlay', mesa:'mesaOverlay', orq:'orqOverlay', projetos:'projetosOverlay', nova:'ndOverlay', planner:'plannerOverlay', form:'ntOverlay', skills:'skOverlay', issues:'issuesOverlay', issuesbulk:'issuesBulkOverlay', prefs:'prefsOverlay', cfg:'cfgOverlay', daily:'dailyOverlay', chat:'pcOverlay', conta:'cloudOverlay', agents:'agOverlay', env:'envOverlay', task:'fwOverlay', cttask:'ctPageOverlay', epic:'epicOverlay', uso:'usoOverlay' };
let tabTaskId=null, tabTaskPath=null; // tarefa aberta na aba "task"
// Views de INSTÂNCIA MÚLTIPLA: cada aba guarda o próprio estado (nova, planner, form, orq)
// e o restaura ao voltar — dá pra ter duas "Montar conversando" abertas sem uma pisar na outra.
const MULTI_KINDS=new Set(['nova','planner','form','orq']);
// views únicas que guardam trabalho em andamento na própria tela: voltar pela ABA só mostra (não reabre —
// reabrir zerava a seleção de Issues e as edições não salvas de Agentes/Configurações); o menu/openTab recarrega
const KEEP_ON_SWITCH=new Set(['memoria','mesa','issues','issuesbulk','agents','cfg','skills','projetos','prefs','conta','env','daily','uso']);
let tabSeq=0;
function tabStateApi(kind){ return window['TAB_STATE_'+kind]||null; }
function saveTabState(tab){ if(!tab||!MULTI_KINDS.has(tab.kind)) return; const api=tabStateApi(tab.kind); if(!api||!api.get) return; try{ tab.state=api.get(); if(tab.state&&tab.state._title) tab.title=String(tab.state._title).slice(0,28); }catch(e){ console.error('saveTabState',e); } }
function loadTabState(tab){ if(!tab||!MULTI_KINDS.has(tab.kind)||!tab.state) return; const api=tabStateApi(tab.kind); if(!api||!api.set) return; try{ api.set(tab.state); }catch(e){ console.error('loadTabState',e); } }
// abridores que POPULAM+mostram cada view (os bloco-1 vêm via window)
function viewOpen(kind, tab){
  const fresh=!!(tab&&tab.fresh); if(tab) tab.fresh=false;
  const f={ orq:()=>{ if(fresh&&window.orqFresh) window.orqFresh(); window.openOrq&&window.openOrq(); },
            projetos:()=>openProjetos(), nova:()=>openNovaStart(),
            planner:()=>{ if(fresh||!window.plShow) openPlanner(); else window.plShow(); },
            form:()=>{ if(fresh||!window.ntShow) openNewTask(); else window.ntShow(); },
            skills:()=>openSkills(), issues:()=>openIssues(), issuesbulk:()=>openIssuesBulk(), prefs:()=>openPrefs(), memoria:()=>window.openMemoria&&window.openMemoria(), mesa:()=>window.openMesa&&window.openMesa(), uso:()=>window.openUso&&window.openUso(), cfg:()=>openCfg(), daily:()=>openDaily(), chat:()=>openPc(), env:()=>openEnv(),
            conta:()=>window.openCloud&&window.openCloud(), agents:()=>window.openAgents&&window.openAgents(),
            task:()=>{ if(tabTaskId==null) return; const path=(tab&&tab.path)||null;
              // aba de tarefa de OUTRO projeto (você trocou de projeto depois de abrir): volta pro projeto dela antes
              if(tab && tab.repo && state.repo && tab.repo!==state.repo && window.switchProject){
                const tr=tab.repo, id=tab.id, tid=tabTaskId;
                window.switchProject(tr).then(()=>{ if(activeTab===id && state.repo===tr) fwOpenInner(tid, path); });
                return; }
              fwOpenInner(tabTaskId, path); },
            cttask:()=>{ if(window.ctPageOpenInner) window.ctPageOpenInner(tab); },
            epic:()=>{ if(window.epicPageOpenInner) window.epicPageOpenInner(tab); } }[kind];
  if(f) f();
}
// cada aba tem um id único: 'flow', o próprio kind (views únicas), 'task:<id>' (uma por tarefa)
// ou '<kind>:<n>' (views de instância múltipla)
let TABS=[{id:'flow',kind:'flow',title:'Central',pin:true}];
let activeTab='flow';
function tabById(id){ return TABS.find(t=>t.id===id); }
// fecha uma tela: como ABA fecha a aba (esconder o overlay deixava a aba ativa EM BRANCO); como modal, esconde
function ovHide(o){
  if(typeof o==='string') o=$id(o); if(!o) return;
  const kind=Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===o.id);
  if(kind && o.classList.contains('astab')){ closeTabOfKind(kind); return; }
  o.style.display='none';
}
window.ovHide=ovHide;
// mostra um overlay DEPOIS de um await sem quebrar o modo aba: como aba fica 'block' (o 'flex' inline vencia o
// .astab e a tela virava modal); se o usuário já saiu da aba dela enquanto carregava, não aparece por cima de outra
function ovShow(o){
  if(typeof o==='string') o=$id(o); if(!o) return;
  if(o.classList.contains('astab')){ o.style.display='block'; return; }
  const kind=Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===o.id), cur=tabById(activeTab);
  if(kind && tabsOfKind(kind).length && cur && cur.kind!==kind) return;
  o.style.display='flex';
}
function tabsOfKind(kind){ return TABS.filter(t=>t.kind===kind); }
function tabIcon(kind){ if(kind==='flow') return '<rect x="2.5" y="3" width="11" height="10" rx="1.4"/><path d="M2.5 6h11"/>'; return (VIEW_META[kind]||{}).icon||''; }
function activateTab(id){ if(id!==activeTab) saveTabState(tabById(activeTab)); activeTab=id; renderTabs(); showActiveView(); }
// openTab(kind, opts): views únicas reaproveitam a aba; views múltiplas abrem uma NOVA aba,
// salvo opts.replace (a aba ativa de "Nova demanda" vira o método escolhido, mantendo o id)
// ou opts.reuse (função que escolhe uma aba já aberta do mesmo kind).
function openTab(kind, opts){
  opts=opts||{};
  // criar demanda/plano exige um projeto aberto: sem projeto, leva pra Projetos em vez de abrir um formulário sem destino
  if(['nova','form','planner','orq'].includes(kind) && typeof state!=='undefined' && !state.repo){
    // "Começar sem portões": a tela inicial já cria o projeto a partir do pedido — leva pra lá, não pra Projetos
    if($id('emWhat')){ toast('Diga aqui o que você quer fazer — o projeto é criado junto.','warn'); openTab('flow'); setTimeout(()=>{ const t=$id('emWhat'); if(t) t.focus(); },60); return; }
    toast('Abra ou crie um projeto primeiro — a demanda roda dentro dele.','warn');
    openTab('projetos'); return; }
  // criar demanda/plano exige branch: pasta sem git passa pelo "criar repositório" antes
  if(['nova','form','planner','orq'].includes(kind) && typeof repoHasGit==='function' && !repoHasGit()){ gitGate().then(ok=>{ if(ok) openTab(kind, opts); }); return; }
  // repaginada B: "Nova demanda" (botão, +, n, ghostNew, trocar tipo) abre DIRETO no planner vazio — uma tela só.
  // A tela antiga de 2 passos fica atrás de lsGet('nd:legacy')==='1' por uma versão.
  if(kind==='nova' && !(window.ndLegacy && window.ndLegacy())) kind='planner';
  if(kind==='flow'){ activateTab('flow'); return; }
  let tab=null;
  if(MULTI_KINDS.has(kind)){
    const cur=tabById(activeTab);
    if(opts.replace && cur && MULTI_KINDS.has(cur.kind) && cur.id===activeTab){ tab=cur; tab.kind=kind; tab.title=(VIEW_META[kind]||{}).title||kind; tab.state=null; tab.fresh=true; }
    else if(opts.reuse){ tab=tabsOfKind(kind).find(t=>{ try{ return opts.reuse(t); }catch(_){ return false; } })||null; }
    if(!tab){ tab={id:kind+':'+(++tabSeq), kind, title:(VIEW_META[kind]||{}).title||kind, fresh:true, state:null}; TABS.push(tab); }
  } else {
    tab=tabById(kind); if(!tab){ tab={id:kind, kind, title:(VIEW_META[kind]||{}).title||kind}; TABS.push(tab); }
    tab.loaded=false; // aberto pelo menu/atalho: recarrega a tela
  }
  activateTab(tab.id);
}
window.openTab=openTab;
// E6 (bug #9): edição de arquivo aberta na aba de uma tarefa — fechar ESSA aba, ou ir pra aba de OUTRA tarefa
// (fwOpenInner zera o editor), pergunta antes de descartar. Trocar pra quadro/config mantém a edição (volta intacta).
async function tabLeaveGuard(targetId, closing){
  if(typeof fwEditing==='undefined' || !fwEditing || typeof fwLeaveEditor!=='function' || typeof fwTask==='undefined' || !fwTask) return true;
  const tg=tabById(targetId); if(!tg) return true;
  const losing = closing ? (tg.kind==='task' && tg.taskId===fwTask) : (tg.kind==='task' && tg.taskId!==fwTask);
  return losing ? await fwLeaveEditor() : true;
}
function closeTab(id){
  const i=TABS.findIndex(t=>t.id===id); if(i<0||TABS[i].pin) return;
  const kind=TABS[i].kind;
  // Agentes & Equipes com edição não salva: o X da aba passa pelo mesmo "descartar?" do cancelar (33 cancelAgents)
  if(kind==='agents' && typeof agDirty==='function' && agDirty() && typeof cancelAgents==='function'){ cancelAgents(); return; }
  TABS.splice(i,1);
  // esconde o overlay do kind se nenhuma OUTRA aba do mesmo kind sobrou
  if(!TABS.some(t=>t.kind===kind)){ const o=$id(VIEW_OVERLAY[kind]); if(o){ o.classList.remove('astab'); o.style.display='none'; } }
  // fechou uma aba de FUNDO: a ativa continua como está (showActiveView restaurava nela o estado velho
  // guardado ao sair — ex.: o "Montar conversando" ativo perdia as mensagens mais recentes)
  if(activeTab!==id){ renderTabs(); return; }
  activeTab=(TABS[i-1]||TABS[0]).id;
  renderTabs(); showActiveView();
}
// R7: reordenar abas arrastando. A aba fixa (Central) fica sempre na frente; soltar sobre outra aba põe a
// arrastada no lugar dela. Devolve true quando mudou. Pura sobre TABS (testada em app/tests/central.test.mjs).
let tabDragId=null;
// entra DEPOIS do alvo? (arrastando pra direita, ou soltando sobre uma aba fixa) — o marcador e o tabMove usam a mesma regra
function tabDropAfter(fromId, toId){
  const from=TABS.findIndex(t=>t.id===fromId), to=TABS.findIndex(t=>t.id===toId);
  return from<to || !!(TABS[to]&&TABS[to].pin);
}
function tabMove(fromId, toId){
  const from=TABS.findIndex(t=>t.id===fromId), to=TABS.findIndex(t=>t.id===toId);
  if(from<0 || to<0 || from===to || TABS[from].pin) return false;
  const after=tabDropAfter(fromId, toId);
  const [t]=TABS.splice(from,1);
  let at=TABS.findIndex(x=>x.id===toId); if(after) at++;
  // nunca antes das fixas: sem outra aba livre (a arrastada era a única), o mínimo é depois de todas as fixas
  const firstFree=TABS.findIndex(x=>!x.pin), minAt=firstFree<0?TABS.length:firstFree;
  if(at<minAt) at=minAt;
  TABS.splice(at,0,t);
  return true;
}
// fecha uma aba passando pela guarda de edição não salva (X, botão do meio, Delete). Devolve true se fechou.
async function tabCloseGuarded(id){
  const t=tabById(id); if(!t || t.pin) return false;
  if(!await tabLeaveGuard(id, true)) return false;
  closeTab(id); return true;
}
// próxima/anterior aba (⌘⇧] / ⌘⇧[ e Ctrl+Tab / Ctrl+⇧Tab), em volta
function tabStepId(dir){ const i=TABS.findIndex(t=>t.id===activeTab); if(!TABS.length) return null; return TABS[((i<0?0:i)+dir+TABS.length)%TABS.length].id; }
// fecha a aba ATIVA desse kind (ou a última aberta) — usado pelos botões "fechar" das views
function closeTabOfKind(kind){ const cur=tabById(activeTab); const t=(cur&&cur.kind===kind)?cur:tabsOfKind(kind).slice(-1)[0]; if(t) closeTab(t.id); }
window.closeTabOfKind=closeTabOfKind;
function showActiveView(){
  const t=tabById(activeTab)||TABS[0];
  const target=t.kind==='flow'?null:VIEW_OVERLAY[t.kind];
  // esconde as OUTRAS telas; a do destino fica como está (esconder e mostrar a mesma = piscada)
  Object.keys(VIEW_OVERLAY).forEach(k=>{ const id=VIEW_OVERLAY[k]; if(id===target) return; const o=$id(id); if(o && o.dataset.lock!=='1'){ o.classList.remove('astab'); if(o.style.display!=='none') o.style.display='none'; } });
  if(t.kind==='flow') return; // o quadro (.body) já aparece
  if(t.kind==='task') tabTaskId=t.taskId; // qual tarefa esta aba mostra
  loadTabState(t);      // devolve o estado guardado desta aba (views múltiplas)
  const kindWas=t.kind;
  if(!(KEEP_ON_SWITCH.has(t.kind) && t.loaded)){ if(typeof perfTabOpen==='function') perfTabOpen(t.kind); viewOpen(t.kind, t); t.loaded=true; }
  // o abridor trocou a aba por dentro (aba 'nova' antiga → planner, via openTab replace): a chamada interna já mostrou a tela certa
  if(activeTab!==t.id || t.kind!==kindWas){ const o0=$id(VIEW_OVERLAY[kindWas]); if(o0 && VIEW_OVERLAY[kindWas]!==VIEW_OVERLAY[t.kind]){ o0.classList.remove('astab'); o0.style.display='none'; } return; }  // popula + mostra (os abridores setam display='flex' = layout de MODAL)
  const o=$id(target);
  // vira ABA no MESMO quadro: antes era num requestAnimationFrame e a tela pintava 1 quadro como
  // modal (flex, sem .astab) a cada troca de aba — a "piscada"
  if(o){ syncChromeH(); o.classList.add('astab'); o.style.display='block'; requestAnimationFrame(syncChromeH); }
}
let _updBtnNode=null; // o botão "atualizar" sobrevive aos re-renders da barra de abas (ver renderTabs)
function renderTabs(){
  const bar=$id('tabBar'); if(!bar) return;
  bar.style.display='flex'; bar.setAttribute('data-tauri-drag-region','');
  // título vivo das abas múltiplas (ex.: a demanda que está sendo montada)
  for(const t of TABS){ if(t.id===activeTab && MULTI_KINDS.has(t.kind)){ const api=tabStateApi(t.kind); try{ const st=api&&api.get&&api.get(); if(st&&st._title) t.title=String(st._title).slice(0,28); else if(st&&st._title===''){ t.title=(VIEW_META[t.kind]||{}).title||t.kind; } }catch(_){ } } }
  // numera só as abas que ainda têm o título genérico ("Montar conversando 1, 2…")
  const counts={}; TABS.forEach(t=>{ if(t.title===((VIEW_META[t.kind]||{}).title||t.kind)) counts[t.kind]=(counts[t.kind]||0)+1; });
  const seen={};
  // o botão "atualizar" mora DENTRO da barra: tira ele antes do innerHTML e devolve depois (guardado em
  // _updBtnNode — antes o 2º render destruía o botão e o aviso de versão nova nunca aparecia).
  { const u=$id('updBtn'); if(u) _updBtnNode=u; if(_updBtnNode && bar.contains(_updBtnNode)) _updBtnNode.remove(); }
  bar.innerHTML=`<button class="railtgl railtgl-main" id="railToggleMain" title="Expandir a barra lateral (⌘B)" aria-label="Expandir barra lateral"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M6.2 2.8v10.4" stroke-linecap="round"/></svg></button>`+'<span class="tablist" role="tablist" aria-label="abas abertas">'+TABS.map(t=>{
    const on=t.id===activeTab; const base=(VIEW_META[t.kind]||{}).title||t.kind; if(t.title===base) seen[t.kind]=(seen[t.kind]||0)+1;
    const title=(MULTI_KINDS.has(t.kind)&&counts[t.kind]>1&&t.title===base)?`${base} ${seen[t.kind]}`:t.title;
    // R7: aba pelo teclado (role=tab, Tab chega, Enter abre, ←/→ passa, Delete/Backspace fecha), título inteiro no
    // tooltip (o texto corta em 28) e arrastável pra reordenar (a Central fica fixa na frente). O X é só pro mouse
    // (aria-hidden: controle dentro de role=tab não é permitido) — pelo teclado fecha com Delete.
    return `<span class="tab ${on?'on':''} ${t.pin?'pin':''}" data-tk="${escA(t.id)}" role="tab" tabindex="${on?0:-1}" aria-selected="${on}" title="${escA(title)}"${t.pin?'':' draggable="true" aria-keyshortcuts="Delete"'}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${tabIcon(t.kind)}</svg><span class="tt">${esc(title)}</span>${t.pin?'':`<span class="x" data-xk="${escA(t.id)}" aria-hidden="true" title="fechar (⌘W)">${IC.x}</span>`}</span>`;
  }).join('')+'</span>'+`<span class="tabadd" id="tabAdd" role="button" tabindex="0" aria-label="nova demanda" aria-keyshortcuts="Meta+N Control+N" title="nova demanda — sempre abre uma aba nova (⌘N)&#10;? ou ⌘/ abre o painel de atalhos&#10;${escA(SHORTCUTS_HELP)}">+</span><span class="tabgrow" data-tauri-drag-region></span><span class="tabright" id="tabRight"></span>`;
  bar.querySelectorAll('[data-tk]').forEach(el=>{
    el.onclick=async e=>{ if(e.target.closest('[data-xk]')) return; const id=el.dataset.tk; if(!await tabLeaveGuard(id, false)) return; activateTab(id); };
    // botão do meio fecha a aba (como no navegador)
    // (mousedown do meio: sem isso o Windows/Linux liga o autoscroll ou cola a seleção)
    el.addEventListener('mousedown', e=>{ if(e.button===1) e.preventDefault(); });
    el.addEventListener('auxclick', e=>{ if(e.button!==1) return; e.preventDefault(); tabCloseGuarded(el.dataset.tk); });
    el.onkeydown=e=>{
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); el.click(); }
      else if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); tabCloseGuarded(el.dataset.tk).then(ok=>{ if(ok){ const n=bar.querySelector('.tab.on'); if(n) n.focus(); } }); }
      else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){ e.preventDefault(); const l=[...bar.querySelectorAll('[data-tk]')], i=l.indexOf(el); const n=l[(i+(e.key==='ArrowRight'?1:-1)+l.length)%l.length]; if(n) n.focus(); }
    };
    if(el.getAttribute('draggable')==='true'){
      el.addEventListener('dragstart', e=>{ tabDragId=el.dataset.tk; el.classList.add('dragging'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', tabDragId); }catch(_){ } });
      el.addEventListener('dragend', ()=>{ tabDragId=null; el.classList.remove('dragging'); bar.querySelectorAll('.tab.dropto,.tab.dropafter').forEach(x=>x.classList.remove('dropto','dropafter')); });
    }
    // marca o lado certo: arrastando pra direita (ou sobre a fixa) entra DEPOIS do alvo
    el.addEventListener('dragover', e=>{ if(!tabDragId || tabDragId===el.dataset.tk) return; e.preventDefault(); const after=tabDropAfter(tabDragId, el.dataset.tk); el.classList.toggle('dropafter', after); el.classList.toggle('dropto', !after); });
    el.addEventListener('dragleave', ()=>el.classList.remove('dropto','dropafter'));
    el.addEventListener('drop', e=>{ if(!tabDragId) return; e.preventDefault(); const from=tabDragId; tabDragId=null; if(tabMove(from, el.dataset.tk)) renderTabs(); });
  });
  // E6 (bug #9): o X da aba perguntava nada e jogava fora a edição não salva do arquivo (só ⌘W e o botão fechar perguntavam)
  bar.querySelectorAll('[data-xk]').forEach(el=>el.onclick=e=>{ e.stopPropagation(); tabCloseGuarded(el.dataset.xk); });
  const add=$id('tabAdd'); if(add){ add.onclick=()=>openTab('nova'); add.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openTab('nova'); } }; } // R8 a11y: o + era um span fora do Tab
  { const m=$id('railToggleMain'); if(m) m.onclick=()=>setRailCollapsed(false); }
  // o botão "atualizar" (versão nova) mora na barra de abas, à direita
  // sem #tabRight o nó continua guardado em _updBtnNode e volta no próximo render (nunca se perde)
  { const u=_updBtnNode||$id('updBtn'), slot=$id('tabRight'); if(u&&slot&&u.parentElement!==slot) slot.appendChild(u); }
  requestAnimationFrame(syncChromeH);
  tabsFit();
}
// R7: barra de abas lotada → modo compacto (menos respiro; o X das abas de fundo só no hover, como no navegador) e
// rola até a ativa. Recalcula no render e ao redimensionar a janela.
function tabsFit(){
  const bar=$id('tabBar'); if(!bar) return;
  // mede SEMPRE no tamanho normal e usa folga pra não ficar piscando no limite ao redimensionar:
  // entra no compacto quando transborda; só sai com 32px sobrando (o .tabgrow é o espaço livre)
  const was=bar.classList.contains('crowded'); bar.classList.remove('crowded');
  const over=bar.scrollWidth-bar.clientWidth, g=bar.querySelector('.tabgrow');
  const slack=over>1 ? -over : ((g?g.offsetWidth:0)-12);
  bar.classList.toggle('crowded', was ? slack<32 : slack<0);
  const on=bar.querySelector('.tab.on');
  if(on && bar.scrollWidth>bar.clientWidth+1) try{ on.scrollIntoView({ block:'nearest', inline:'nearest' }); }catch(_){ }
}
{ let tm=null; window.addEventListener('resize', ()=>{ clearTimeout(tm); tm=setTimeout(tabsFit, 150); }); }
$id('bdClose').onclick=()=>bdClosePlan();
$id('bdCancel').onclick=()=>bdClosePlan();
$id('bdOverlay').addEventListener('click',e=>{ if(e.target.id==='bdOverlay') bdClosePlan(); });
$id('cfgClose').onclick=cfgHide;
$id('cfgOverlay').addEventListener('click',e=>{ if(e.target.id==='cfgOverlay') cfgHide(); });

// @ob-envfix-inicio — correção do item no tour: UMA linha por opção (envFixLines, igual à aba Ambiente);
// só linha de COMANDO ganha "copiar" ("configure…"/"reinstale…" são instrução). Testado em app/tests/ia-auxiliar.test.mjs.
function obEnvFixHtml(fix, soft){
  return envFixLines(fix).map((f,i,all)=>`<div style="display:flex;gap:8px;align-items:center;margin-top:5px"><span class="dim" style="font-size:11px">${all.length>1&&i>0?'ou ':''}${f.cmd?'rode no Terminal:':'como resolver:'}</span>${f.cmd
    ?`<code class="mono" style="font-size:10.5px;color:${soft?'var(--text-2)':'var(--warn)'};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escA(f.text)}">${esc(f.text)}</code><button class="btn sm" data-envfix="${escA(f.text)}">copiar</button>`
    :`<span style="font-size:11.5px;color:var(--warn)">${esc(f.text)}</span>`}</div>`).join('');
}
// @ob-envfix-fim
// ---------- onboarding de 60 segundos (primeiro boot) ----------
// Ordem do 1º uso: login (gate obrigatório do 44-onboarding) → ESTE tour → abrir/criar projeto.
// Antes o tour abria em 900ms e o gate de login (3,2s) cobria ele no meio. Agora ele só começa com
// sessão aberta e a tela de entrada fechada: obMaybeStart() é chamado pelo auHide/loginGateSync.
// Texto pra quem NÃO programa (veto da Carla: sem branch/mock/gh por padrão). O técnico fica no Ambiente.
const OB_STEPS=[
  { t:'Bem-vindo ao Starfork', b:'Você conta o que precisa em português normal e <b>agentes de IA</b> fazem o trabalho — cada tarefa numa <b>cópia separada do seu projeto</b>, então uma não atrapalha a outra. No fim, cada entrega vem com <b>provas de verdade</b> (prints, testes, documentos) pra você revisar antes de aprovar.' },
  { t:'Seu time vê o essencial', b:'Com a conta num time (<b>Conta e time</b>, no rodapé da barra lateral), o time vê o <b>andamento de cada tarefa</b>: título, status e custo sincronizam sozinhos. A <b>conversa com o agente fica só no seu computador</b>, e as provas só sobem quando você publicar.' },
  { t:'Qual IA você vai usar?', b:'Os agentes trabalham com <b>uma IA</b> — escolha a sua: o <b>Claude Code</b>, o <b>Codex</b> (OpenAI), o <b>DeepSeek</b> (beta, open source) ou o gateway da sua empresa. Cada uma mostra se já está pronta e o que falta; dá pra <b>testar</b> e deixar como padrão aqui mesmo.', ia:true },
  { t:'O que o computador precisa', b:'Os agentes usam o <b>Git</b> (guarda o histórico) e <b>uma IA</b> — o <b>Claude Code</b>, o <b>Codex</b> (OpenAI), o <b>DeepSeek</b> (beta) ou o gateway da sua empresa; basta uma, com login feito. O <b>GitHub</b> é recomendado — só serve pra publicar. Outros extras são opcionais. Estamos conferindo agora; o que faltar vem com o comando pronto pra copiar.', env:true },
  { t:'Agora é com você', b:'Diga o que você quer fazer — um app, um site, um relatório, uma planilha — e o Starfork cria a pasta do projeto e a IA monta o plano com você. Se já tem uma pasta, é só abrir.', proj:true },
];
let obStep=0;
function openOnboarding(){ obStep=0; renderOb(); $id('obOverlay').style.display='flex'; setTimeout(()=>{ const b=$id('obNext'); if(b) b.focus(); },50); }
// teclado: Esc pula o tour, → avança (antes só dava com o mouse)
// outra janela do app por cima (askText, detalhes do erro…) → as teclas são dela, não do tour
function obOtherModalOpen(){ const tx=$id('txOverlay'); return !!((tx && tx.style.display==='flex') || $id('errOverlay')); }
document.addEventListener('keydown', e=>{
  const ob=$id('obOverlay'); if(!ob || ob.style.display!=='flex') return;
  if(obOtherModalOpen() || (e.target && e.target.closest && !e.target.closest('#obOverlay') && e.target!==document.body)) return;
  if(e.key==='Tab'){ // foco preso no tour (é um diálogo modal)
    const f=[...ob.querySelectorAll('button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
    if(!f.length) return; const i=f.indexOf(document.activeElement);
    if(e.shiftKey && (i<=0)){ e.preventDefault(); f[f.length-1].focus(); }
    else if(!e.shiftKey && (i===-1 || i===f.length-1)){ e.preventDefault(); f[0].focus(); }
    return; }
  if(e.key==='Escape'){ e.preventDefault(); finishOb(); }
  else if(e.key==='ArrowRight' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'')){ e.preventDefault(); const b=$id('obNext'); if(b) b.click(); }
});
// só no 1º uso, com sessão aberta e sem a tela de entrada/planos por cima
function obMaybeStart(){
  if(lsGet('onboarded')) return;
  const ob=$id('obOverlay'); if(ob && ob.style.display==='flex') return;
  if(typeof SB==='undefined' || !SB.sess()) return;
  if(typeof auOpen==='function' && auOpen()) return;
  openOnboarding();
}
window.obMaybeStart=obMaybeStart;
function renderOb(){
  const s=OB_STEPS[obStep];
  const last=obStep===OB_STEPS.length-1;
  const hasRepo=!!(state&&state.repo);
  $id('obBody').innerHTML=`
    <div style="display:flex;gap:6px;margin-bottom:18px;align-items:center" role="progressbar" aria-valuemin="1" aria-valuemax="${OB_STEPS.length}" aria-valuenow="${obStep+1}" aria-label="passo ${obStep+1} de ${OB_STEPS.length}">${OB_STEPS.map((_,i)=>`<span style="height:4px;flex:1;border-radius:99px;background:${i<=obStep?'var(--accent)':'var(--border)'}"></span>`).join('')}<span class="dim mono" style="font-size:10.5px;margin-left:6px">${obStep+1}/${OB_STEPS.length}</span></div>
    <h2 style="font-size:20px;margin:0 0 10px" id="obTitle">${s.t}</h2>
    <p style="color:var(--text-2);font-size:14px;line-height:1.65;margin:0">${s.b}</p>
    ${s.ia?'<div id="obSuaIa"></div>':''}
    ${s.env?'<div id="obEnv" style="margin-top:14px"><div class="dim" style="font-size:12px">verificando o ambiente…</div></div>':''}
    ${s.proj?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center">${hasRepo?`<span class="dim" style="font-size:12.5px">✓ projeto aberto: <b style="color:var(--text)">${esc(pathBase(state.repo))}</b></span><span style="flex:1"></span>`:''}<button class="btn sm" id="obOpenDir">${ic('folder')}${hasRepo?'Abrir outra pasta':'Já tenho uma pasta'}</button></div>`:''}
    <div style="display:flex;gap:8px;margin-top:24px;align-items:center">
      <button class="btn sm" id="obSkip" title="Esc">pular</button><span style="flex:1"></span>
      ${obStep>0?'<button class="btn sm" id="obBack">voltar</button>':''}
      ${s.ia?'<span class="dim" id="obIaWill" style="font-size:12px" aria-live="polite"></span><button class="btn sm" id="obIaLater" title="a IA padrão continua como está — troque quando quiser em Configurações → Sua IA">decido depois</button>':''}
      <button class="btn primary" id="obNext">${last?(hasRepo?'Começar':'Dizer o que eu quero fazer'):'continuar'}</button>
    </div>`;
  $id('obSkip').onclick=()=>{ finishOb(); };
  $id('obNext').onclick=()=>{
    // passo de IA: o "continuar" APLICA a IA pronta escolhida/sugerida quando o padrão atual não está pronto
    // (quem só tem Codex/gateway não fica com o Claude de padrão); "decido depois" (obIaLater) não aplica nada
    if(s.ia && typeof suaIaObApply==='function') suaIaObApply();
    if(!last){ obStep++; renderOb(); const b=$id('obNext'); if(b) b.focus(); return; }
    finishOb();
    // sem projeto: vai direto pra caixa "O que você quer fazer?" (Começar sem portões) — antes o botão dizia "depois"
    // as dicas de primeira vez ficam pra quando o projeto abrir (36-comecar/noProjSync chama o coachStart)
    if(!(state&&state.repo)){ lsSet('coachPending','1'); if(window.openTab) window.openTab('flow'); setTimeout(()=>{ const t=$id('emWhat'); if(t) t.focus(); },120); return; }
    coachStart(); };
  bindClick('obBack', ()=>{ if(obStep>0){ obStep--; renderOb(); } });
  // passo de IA: pulável ("decido depois" segue o tour sem mudar nada) e com o painel único (30-sua-ia.js)
  bindClick('obIaLater', ()=>{ obStep++; renderOb(); const b=$id('obNext'); if(b) b.focus(); });
  if(s.ia && typeof suaIaMount==='function') suaIaMount($id('obSuaIa'), { ctx:'onboarding', fresh:true,
    onPick:(id, nome)=>{ const w=$id('obIaWill'); if(w) w.textContent=id?'vai usar: '+nome:''; } });
  bindClick('obOpenDir', async()=>{ try{ if(window.pickFolder) await window.pickFolder(); }catch(_){ } if(state&&state.repo){ finishOb(); coachStart(); } else renderOb(); });
  // check de ambiente INTEGRADO no onboarding (redesign p16): fix inline com botão de copiar, sem bloquear a entrada
  if(s.env) runEnvCheck().then(()=>{
    const el=$id('obEnv'); if(!el) return;
    const S=envSummary(envChecks);
    el.innerHTML=(envChecks||[]).map(c=>{ const k=envKind(c), soft=!c.ok&&k!=='req', tag=ENV_KIND_TAG[k];
      // mesmo ícone da aba Ambiente: ✓ ok · ! obrigatório faltando · – recomendado/opcional faltando (neutro)
      const icon=c.ok?`<span style="color:var(--good)">${IC.ok}</span>`:soft?'<span style="color:var(--text-3);font:600 13px var(--code);width:14px;text-align:center">–</span>':`<span style="color:var(--warn)">${IC.warn}</span>`;
      return `<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
      ${icon}<div style="flex:1;min-width:0"><b>${esc(String(c.name||'').replace(/\s*\(opcional\)/i,''))}</b>${tag?` <span class="envtag">${tag}</span>`:''} <span class="dim">${esc(c.ok?(c.detail||'').slice(0,60):envWhat(c)||(c.detail||'').slice(0,80))}</span>${!c.ok&&c.fix?obEnvFixHtml(c.fix, soft):''}</div></div>`; }).join('')
      +(S.reqBad?'<div class="dim" style="font-size:11.5px;margin-top:8px">Dá pra seguir mesmo assim — o que faltar fica com um aviso em <b>Mais › Ambiente</b>, no rodapé da barra lateral.</div>'
        :'<div style="font-size:12px;margin-top:8px;color:var(--good)">Tudo certo pra começar.'+(S.optBad?' <span class="dim">Os opcionais dá pra instalar depois.</span>':'')+'</div>');
    el.querySelectorAll('[data-envfix]').forEach(b=>{ b.onclick=()=>envCopy(b); });
  }).catch(()=>{});
}
function finishOb(){ lsSet('onboarded','1'); $id('obOverlay').style.display='none'; }
// rede de segurança: sessão que já existia no boot (o gate nem abre) → começa depois do gate checar (3,2s)
setTimeout(obMaybeStart, 3800);

// ---------- coach marks de primeira vez (redesign p17) ----------
const COACH=[
  ['newTaskBtn','Tudo começa aqui','Descreva o que precisa em 1–2 frases — o assistente monta a spec e o time de agentes executa.'],
  ['ffSearch','Busca em tudo','Ache qualquer demanda pelo título — ou use ⌘K de qualquer lugar.'],
  ['rail','Execução ao vivo','Os agentes rodando agora ficam aqui. Amarelo = um deles está aguardando você.'],
];
function coachStart(){
  if(lsGet('coached')) return;
  let i=0;
  const tipEl=document.createElement('div'); tipEl.id='coachTip';
  tipEl.style.cssText='position:fixed;z-index:9999;max-width:260px;background:var(--surface);border:1px solid var(--accent);border-radius:10px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  document.body.appendChild(tipEl);
  const show=()=>{
    if(i>=COACH.length){ done(); return; }
    const [id,t,b]=COACH[i];
    const a=$id(id);
    const r=a?a.getBoundingClientRect():null;
    // alvo que não está na tela (ex.: busca da Central sem projeto aberto) → pula, em vez de pôr a dica no canto (0,0)
    if(!a || !r || (r.width===0 && r.height===0) || a.offsetParent===null){ i++; show(); return; }
    tipEl.innerHTML=`<b style="font-size:13px">${esc(t)}</b><div class="dim" style="font-size:12px;line-height:1.5;margin-top:4px">${esc(b)}</div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="btn sm" id="coachSkip">pular tudo</button><span style="flex:1"></span><span class="dim" style="font-size:10.5px">${i+1}/${COACH.length}</span><button class="btn primary sm" id="coachNext">${i<COACH.length-1?'próximo':'entendi'}</button></div>`;
    const top=Math.min(window.innerHeight-160, r.bottom+10);
    const left=Math.max(10, Math.min(window.innerWidth-280, r.left));
    tipEl.style.top=top+'px'; tipEl.style.left=left+'px';
    a.style.outline='2px solid var(--accent)'; a.style.outlineOffset='3px';
    const clear=()=>{ a.style.outline=''; a.style.outlineOffset=''; };
    $id('coachNext').onclick=()=>{ clear(); i++; show(); };
    $id('coachSkip').onclick=()=>{ clear(); done(); };
  };
  const onKey=e=>{ if(e.key==='Escape'){ const sk=$id('coachSkip'); if(sk) sk.click(); } };
  const done=()=>{ lsSet('coached','1'); tipEl.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  show();
}

// ---------- atalhos ----------
// ⌘J/⌘, abrem como ABA (igual à barra lateral — antes viravam modal flutuante), ⌘W fecha a aba ativa,
// ⌘1…⌘8 vão pra aba N e ⌘9 pra última (como no navegador). A lista fica no tooltip do "+" da barra de abas.
// R8 a11y: UMA lista (tecla, o que faz) — o tooltip do "+" e o painel de atalhos (tecla ? ou ⌘/) saem daqui.
// Faltavam: ⌘B dentro da tarefa, Esc, Enter/⇧Enter no chat, ⌘Enter nos campos de demanda, ←/→ nas abas e nos prints.
// @puro-atalhos-inicio (testado em app/tests/acessibilidade.test.mjs)
// tecla = lista de teclas; 'ou' entre elas é texto (não vira tecla desenhada)
const SHORTCUTS=[
  ['Abas e navegação', [
    [['⌘N'],'nova demanda (sempre abre uma aba nova)'],
    [['⌘K'],'buscar na Central de execuções'],
    [['⌘J'],'chat do projeto'],
    [['⌘,'],'configurações'],
    [['⌘O'],'abrir pasta de projeto'],
    [['⌘B'],'recolher/mostrar a barra lateral (numa tarefa: a lista de arquivos)'],
    [['⌘W'],'fechar a aba atual'],
    [['⌘1…⌘9'],'ir pra aba 1…8 (⌘9 = última)'],
    [['⌘⇧[','⌘⇧]'],'aba anterior / próxima'],
    [['Ctrl+Tab','Ctrl+⇧Tab'],'próxima / anterior aba'],
    [['←','→'],'com o foco na barra de abas: passar de aba'],
    [['Delete'],'fechar a aba em foco'],
  ]],
  ['Escrever e responder', [
    [['Enter'],'enviar a mensagem no chat'],
    [['⇧Enter'],'quebrar linha no chat'],
    [['⌘Enter'],'continuar/iniciar nos campos de nova demanda'],
    [['Esc'],'fechar a janela ou o detalhe aberto (não fecha com texto por enviar)'],
  ]],
  ['Provas e janelas', [
    [['←','→'],'print anterior / próximo na visualização de provas'],
    [['Tab','⇧Tab'],'andar pelos botões (numa janela, o foco fica dentro dela)'],
    [['?','ou','⌘/'],'mostrar estes atalhos'],
  ]],
];
const SHORTCUT_WORDS=new Set(['ou','e']);
function shortcutsFlat(list){ return (list||[]).flatMap(g=>g[1]); }
function shortcutKeysText(keys){ return (keys||[]).join(' '); }
function shortcutsHelpText(list){ return 'Atalhos: '+shortcutsFlat(list).map(([k,d])=>shortcutKeysText(k)+' '+d).join(' · ')+' · arraste uma aba pra reordenar'; }
// @puro-atalhos-fim
const SHORTCUTS_HELP=shortcutsHelpText(SHORTCUTS);
document.addEventListener('keydown', async e=>{
  if(!(e.metaKey||e.ctrlKey) || e.altKey) return;
  const k=(e.key||'').toLowerCase();
  if(k==='j' && !e.shiftKey){ e.preventDefault(); openTab('chat'); }
  else if(k===',' && !e.shiftKey){ e.preventDefault(); openTab('cfg'); }
  else if(k==='b' && !e.shiftKey){ e.preventDefault(); setRailCollapsed(!railIsCol()); }
  else if(k==='w' && !e.shiftKey){ e.preventDefault(); const t=tabById(activeTab); if(!t || t.pin) return;
    // aba de tarefa com o editor aberto: pergunta antes de descartar o que não foi salvo (igual ao "fechar")
    if(t.kind==='task' && typeof fwLeaveEditor==='function' && !await fwLeaveEditor()) return;
    if(tabById(t.id)) closeTab(t.id); }
  // R7: ⌘1…⌘9 passa pela MESMA guarda do clique na aba — antes ia direto e jogava fora a edição não salva do arquivo
  else if(/^[1-9]$/.test(k) && !e.shiftKey){ e.preventDefault(); const i=k==='9'?TABS.length-1:(+k-1); const t=TABS[i]; if(t && t.id!==activeTab && await tabLeaveGuard(t.id, false)) activateTab(t.id); }
  // pela TECLA produzida (e.key), não pela posição física (e.code): no ABNT2 os colchetes ficam em outro lugar
  else if((e.shiftKey && ['[',']','{','}'].includes(e.key)) || (e.ctrlKey && k==='tab')){
    e.preventDefault(); const dir=(e.key==='['||e.key==='{'||(k==='tab'&&e.shiftKey))?-1:1; const id=tabStepId(dir);
    if(id && id!==activeTab && await tabLeaveGuard(id, false)) activateTab(id); }
});

function eventsOf(taskId){ return state.events.filter(e=>e.taskId===taskId); }
function diffOf(taskId){ return state.diffs.find(d=>d.taskId===taskId); }
function reviewOf(taskId){ return (state.reviews||[]).find(r=>r.taskId===taskId); }
async function openRef(taskId, name){
  let c;
  try{ c=await invoke('read_ref',{ taskId, name }); }
  catch(e){ showErr(e, 'Falha ao abrir a referência'); return; }
  const body = c.kind==='image' ? `<img class="artimg" src="${c.dataUrl}" alt="${escA(name)}">`
    : c.kind==='pdf' ? `<iframe class="pdfview" src="${c.dataUrl}" title="${escA(name)}"></iframe>`
    : c.kind==='doc' ? `<div class="mdview">${mdToHtml(c.text||'')}</div>`
    : `<pre class="artpre">${esc(c.text||'')}</pre>`;
  $id('artIcon').innerHTML = c.kind==='image'?IC.image:IC.doc;
  $id('artTitle').textContent=name;
  $id('artBody').innerHTML=body;
  $id('artOverlay').style.display='flex';
}
function costsOf(taskId){ return (state.costs||[]).filter(c=>c.taskId===taskId); }
function taskCost(taskId){ const cs=costsOf(taskId); return { usd: cs.reduce((s,c)=>s+(c.usd||0),0), tok: cs.reduce((s,c)=>s+(c.inTok||0)+(c.outTok||0),0) }; }
// formato compacto (KPIs, listas): mesma régua do fmtCost ("US$ 1,25") — antes "$1.25" convivia com "US$ 1,25 (≈ R$ …)"
function fmtUsd(u){ return fmtCost(u,{usdOnly:true}); }
function fmtTok(n){ n=Number(n)||0; const u=(d,s)=>{ const v=n/d; return (v>=100?v.toFixed(0):v>=10?v.toFixed(1).replace(/\.0$/,''):v.toFixed(1).replace(/\.0$/,''))+s; };
  return n>=1e9?u(1e9,'B'):n>=1e6?u(1e6,'M'):n>=1000?u(1e3,'k'):String(n); }

