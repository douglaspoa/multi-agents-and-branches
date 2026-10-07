// Starfork — 12-chat-prefs-daily
// ---------- chat do projeto ----------
let pcBusy=false, pcStopping=false, pcBusyRepo='', pcToTaskBusy=false, pcToTaskRepo=''; // pcBusyRepo/pcToTaskRepo: de QUAL projeto é a chamada em andamento
// @puro-inicio pcGate — pergunta e "virar tarefa" usam a MESMA sessão da IA do projeto: nunca rodam juntas nele.
// st={ busy, busyRepo, toTask, toTaskRepo, repo }. Devolve null (pode) ou o aviso em pt-BR.
function pcGate(act, st){
  const askHere=!!st.busy && st.busyRepo===st.repo, taskHere=!!st.toTask && st.toTaskRepo===st.repo;
  if(act==='send'){
    if(taskHere) return 'Montando a tarefa a partir desta conversa — espere terminar pra perguntar de novo.';
    if(askHere) return 'Ainda respondendo — espere ou toque em ■ parar.';
    if(st.busy) return 'Ainda respondendo uma pergunta sobre outro projeto — espere ela terminar.';
    return null;
  }
  if(act==='task'){
    if(st.toTask) return 'Já estou montando uma tarefa — espere terminar.';
    if(askHere) return 'Espere a resposta terminar (ou toque em ■ parar) pra virar tarefa.';
    return null;
  }
  return null;
}
// @puro-fim pcGate
function pcGateSt(){ return { busy:pcBusy, busyRepo:pcBusyRepo, toTask:pcToTaskBusy, toTaskRepo:pcToTaskRepo, repo:state.repo||'' }; }
// o que a IA está fazendo AGORA (evento project-chat-activity do Rust: "lendo X", "procurando Y") + há quanto tempo.
// Antes era só "lendo o projeto…" por minutos — parecia travado.
let pcActs=[], pcStartedAt=0, pcTick=null;
function pcActsHtml(){
  const s=pcStartedAt?Math.max(0,Math.round((Date.now()-pcStartedAt)/1000)):0;
  const tempo=s<60?s+'s':Math.floor(s/60)+'min '+String(s%60).padStart(2,'0')+'s';
  const acts=pcActs.slice(-6).map((l,i,a)=>`<div class="${i===a.length-1?'cur':''}">${esc(l)}</div>`).join('');
  return `<div class="dim" style="font-size:var(--fs-xs);margin-bottom:3px">lendo o projeto · ${tempo}${pcActs.length?' · '+nPl(pcActs.length,'ação','ações'):''}</div>`+(acts||'<div class="cur">abrindo a sessão da IA…</div>');
}
function pcActsPaint(){ const el=$id('pcActs'); if(el) el.innerHTML=pcActsHtml(); }
try{ window.__TAURI__.event.listen('project-chat-activity', ev=>{ if(!pcBusy) return; const l=String((ev&&ev.payload&&ev.payload.line)||'').trim(); if(!l) return; pcActs.push(l); if(pcActs.length>60) pcActs.shift(); pcActsPaint(); }); }catch(_){ }
function pcKey(){ return 'pchat:'+(state.repo||''); }
// role: user | assistant | sys (aviso: erro, parado, sessão recuperada — aparece na conversa mas NUNCA volta pro modelo)
// conversas antigas guardavam o erro como se fosse a resposta da IA ("Falhou: …" com o triângulo de aviso na frente) → vira aviso ao ler
function pcMsgs(k){ let ms=[]; try{ ms=JSON.parse(lsGet(k||pcKey())||'[]'); }catch(_){ } return (Array.isArray(ms)?ms:[]).map(m=>m&&m.role==='assistant'&&/^⚠ Falhou:/.test(m.text||'')?{ role:'sys', text:m.text }:m).filter(Boolean); }
function pcSave(ms,k){ lsSet(k||pcKey(), JSON.stringify(ms.slice(-60))); }
function pcRender(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const th=$id('pcThread'); if(!th) return;
  const ms=pcMsgs();
  const repo=esc(pathBase(state.repo)||'o projeto');
  const projOpts=(typeof projList==='function'?projList():[]).map(([path,name])=>`<option value="${escA(path)}"${path===state.repo?' selected':''}>${esc(name)}</option>`).join('');
  const here=pcBusy && pcBusyRepo===(state.repo||''); // "lendo o projeto…" só no chat do projeto que perguntou
  const otherBusy=pcBusy && !here;
  // F4 (G1, mesa tela 17): Projeto › Conversa — o seletor de projeto saiu (trocava o projeto do app em silêncio)
  const head=`<div class="pc-head"><div><h2 class="pc-h2">Conversa</h2><p class="as-sub">Lê o código de verdade antes de responder e não altera nada. Segue este projeto — nunca troca o projeto aberto no app.</p></div><div class="as-actions"><button class="as-btn primary" id="pcTask2" title="${here?'espere a resposta terminar':'a conversa vira a especificação de uma tarefa'}"${pcToTaskBusy||here||!ms.length?' disabled':''}>${ic('compass')}${pcToTaskBusy?'montando a tarefa…':'virar tarefa'}</button><button class="as-btn" id="pcClear2" title="começa uma conversa nova (a atual some)" style="border-color:transparent;color:var(--text-3)"${ms.length&&!here?'':' disabled'}>nova conversa</button></div></div>`
    +(otherBusy?`<div class="imhint" style="margin:10px 0 0">Ainda respondendo uma pergunta sobre <b>${esc(pathBase(pcBusyRepo))}</b> — a resposta fica salva na conversa daquele projeto.</div>`:'');
  let bodyHtml;
  if(ms.length){
    bodyHtml=`<div class="pc-thread">${ms.map(chatMsgHtml).join('')}${here?chatThinkHtml('<span class="pltyping"><i></i><i></i><i></i></span><div class="placts" id="pcActs">'+pcActsHtml()+'</div>'):''}</div>`;
  } else {
    const sugg=[['ARQUITETURA','como o autocomplete resolve o ranking hoje?'],['ONDE FICA','onde fica a lógica de autenticação?'],['POR QUÊ','por que o cache é invalidado desse jeito?'],['IDEIA','como eu adicionaria rate limiting aqui?']];
    bodyHtml=`<div class="pc-empty"><div class="pc-empty-t">Pergunte qualquer coisa sobre <span class="as-mono" style="color:var(--accent)">${repo}</span></div><div class="pc-empty-d">Arquitetura, "onde fica X", "por que Y é assim", ideias. Gostou de uma resposta? <b style="color:var(--text)">virar tarefa</b> transforma a conversa numa spec pronta.</div><div class="pc-sugg">${sugg.map(s=>`<button class="pc-sc" data-sg="${escA(s[1])}"><span class="pc-sc-t">${esc(s[0])}</span><span class="pc-sc-x">${esc(s[1])}</span></button>`).join('')}</div></div>`;
  }
  const keep=stickBottom(th);
  th.innerHTML=`<div class="appscreen">${head}${bodyHtml}</div>`;
  { const b=th.querySelector('#pcTask2'); if(b) b.onclick=()=>{ const o=$id('pcTask'); if(o) o.click(); }; }
  { const b=th.querySelector('#pcClear2'); if(b) b.onclick=()=>{ const o=$id('pcClear'); if(o) o.click(); }; }
  th.querySelectorAll('[data-sg]').forEach(b=>b.onclick=()=>{ const i=$id('pcInput'); if(i){ i.value=b.dataset.sg; i.focus(); } });
  attRenderPend('pcPend', pcPend, pcRender);
  chatComposer({ input:'pcInput', attach:'pcAttach', pend:()=>pcPend, taskId:()=>null, rerender:pcRender, onSend:pcSend, send:'pcSend', modelPill:aiChatModelPill('pcModel'),
    stop:{ btn:'pcStop', busy:()=>pcBusy && pcBusyRepo===(state.repo||''), fn:pcStop }, busyHint:'lendo o projeto… · ■ parar interrompe — dá pra ir escrevendo a próxima' });
  keep(th);
}
let pcPend=[]; // anexos importados, ainda não enviados
async function pcSend(){
  // respondendo: antes o Enter/enviar era engolido em silêncio — agora o botão fica desabilitado e o ■ parar aparece
  { const why=pcGate('send', pcGateSt()); if(why){ toast(why,'warn'); return; } }
  const inp=$id('pcInput'); let text=inp.value.trim();
  const atts=pcPend.splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e considere no contexto do projeto.';
  if(!text) return;
  const key=pcKey(), sidKey='pcsid:'+(state.repo||''); // presos ao projeto de ONDE saiu a pergunta
  const ms=pcMsgs(key); ms.push({role:'user',text,atts:attLite(atts)}); pcSave(ms,key); inp.value=''; pcBusy=true; pcBusyRepo=state.repo||''; pcStopping=false; pcActs=[]; pcStartedAt=Date.now(); clearInterval(pcTick); pcTick=setInterval(()=>{ if(!pcBusy){ clearInterval(pcTick); pcTick=null; return; } pcActsPaint(); }, 1000); chatPinBottom('pcThread'); pcRender();
  try{
    const hist=pcMsgs(key).slice(0,-1).filter(m=>m.role!=='sys'); // aviso/erro NUNCA volta pro modelo como se fosse fala
    const r=await aiCallResumeSafe((pr,sid)=>invoke('project_chat',{ prompt:pr, sessionId:sid||'', model:aiClaudeModel() }), lsGet(sidKey)||'', text+attPromptBlock(atts), hist);
    aiKeepSid(r, s=>lsSet(sidKey, s));
    const ms2=pcMsgs(key);
    if(r.recovered) ms2.push({role:'sys', text:'a sessão anterior foi perdida — continuei com o histórico da conversa.'});
    ms2.push({role:'assistant',text:r.text||'(sem resposta)'}); pcSave(ms2,key);
  }catch(e){
    const msg=String((e&&e.message)||e||''); const ms2=pcMsgs(key);
    if(pcStopping||/PROJECT_CHAT_STOPPED/.test(msg)){
      const last=ms2[ms2.length-1]; if(last&&last.role==='user'&&last.text===text) ms2.pop();
      ms2.push({role:'sys', text:'Parado. Sua mensagem voltou pra caixa — edite e envie de novo quando quiser.'});
      const i=$id('pcInput'); if(i&&!i.value) i.value=text; pcPend.push(...atts);
    } else { const h=humanErr(msg); // login do Claude expirado etc. → mensagem certa + botão (antes "expirou" virava "demorou demais")
      if(h.id!=='generic' && h.id!=='network'){ ms2.push({role:'sys', text:h.msg+' Sua pergunta ficou salva.'}); if(h.action) showErr(msg); }
      else ms2.push({role:'sys', text:'Não consegui responder: '+msg.slice(0,300)+(/timeout|timed out|demorou|tempo esgotado/i.test(msg)?' — a leitura do projeto demorou demais; tente uma pergunta mais específica.':' — sua pergunta ficou salva; é só enviar de novo.')}); }
    pcSave(ms2,key);
  }
  pcBusy=false; pcStopping=false; pcBusyRepo=''; pcRender();
}
async function pcStop(){ if(!pcBusy || pcBusyRepo!==(state.repo||'')) return; pcStopping=true; pcActs.push('parando…'); pcActsPaint(); try{ await invoke('project_chat_stop'); }catch(_){ } }
async function pcToTask(){
  // a mesma sessão da IA ainda está respondendo: duas chamadas nela ao mesmo tempo embaralham a conversa
  { const why=pcGate('task', pcGateSt()); if(why){ toast(why,'warn'); return; } }
  if(!pcMsgs().length){ toast('Converse primeiro — a tarefa nasce do papo.','warn'); return; }
  const repo=state.repo||'';
  pcToTaskBusy=true; pcToTaskRepo=repo; pcRender(); // o botão visível (pcTask2) mostra "montando a tarefa…" — antes só o botão escondido mudava
  try{
    // pela mesma porta das rodadas (aiCallResumeSafe): gateway e sessão perdida/de outra IA levam o histórico
    const hist=pcMsgs().filter(m=>m.role!=='sys');
    const r=await aiCallResumeSafe((pr,sid)=>invoke('project_chat',{ model:aiClaudeModel(), prompt:pr, sessionId:sid||'' }), lsGet('pcsid:'+repo)||'', 'Com base APENAS na nossa conversa até aqui, monte a especificação de UMA tarefa executável. Responda SOMENTE um bloco ```json com {"title":"verbo + objeto (máx 60 chars)","objective":"o que fazer, onde e por quê (3-6 frases)","requirements":["critérios de aceite objetivos"]} — nada fora do bloco.', hist);
    aiKeepSid(r, s=>lsSet('pcsid:'+repo, s));
    const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i) || (r.text||'').match(/\{[\s\S]*"objective"[\s\S]*\}/);
    const spec=JSON.parse(m?(m[1]||m[0]):r.text);
    if(!spec || typeof spec!=='object' || Array.isArray(spec)) throw new SyntaxError('spec não é objeto'); // null/"texto" passavam e quebravam no .title
    // trocou de projeto no meio: a spec (já paga) vale pro projeto ORIGINAL — volta pra ele e abre o formulário lá
    if((state.repo||'')!==repo){
      if(!window.switchProject){ toast('Você trocou de projeto enquanto a tarefa era montada — volte pro projeto '+pathBase(repo)+' e tente de novo.','warn'); return; }
      toast('A tarefa é do projeto '+pathBase(repo)+' — voltei pra ele pra abrir o formulário.','warn');
      await switchProject(repo);
      if((state.repo||'')!==repo){ toast('Não consegui voltar pro projeto '+pathBase(repo)+'.','warn'); return; }
    }
    $id('pcOverlay').style.display='none';
    await openNewTask();
    setNtMode('build');
    $id('ntTitle').value=(spec.title||'').slice(0,90);
    $id('ntObj').value=spec.objective||'';
    ntReq=[...new Set((spec.requirements||[]).map(x=>String(x).trim()).filter(Boolean))];
    renderNtList('ntRequirements',ntReq);
    $id('ntArtProof').checked=true;
  }catch(e){ showErr(e instanceof SyntaxError?'a IA não devolveu a tarefa no formato esperado — tente de novo':e, 'Não consegui montar a tarefa'); }
  finally{ pcToTaskBusy=false; pcToTaskRepo=''; pcRender(); }
}
function openPc(){ $id('pcOverlay').style.display='flex'; chatPinBottom('pcThread'); pcRender(); setTimeout(()=>$id('pcInput').focus(),80); }
$id('pcBtn').onclick=openPc;
// ---- Preferências do projeto: 1 doc por projeto, o time escreve, agentes seguem ----
async function prefsKey(){
  const orgId=cloudData&&cloudData.org&&cloudData.org.id; if(!orgId) return null;
  let ids=await repoRemoteIds();
  // sem projeto aberto não pergunta (virava erro 'repo não definido' no painel)
  if(!ids.remote && state.repo){ try{ const info=await invoke('repo_docs'); const n=info&&info.repo; if(n) ids={ remote:n, legacy:n }; }catch(_){ } }
  // repo = forma nova (grava sempre nela); ids = nova + antiga desta máquina (lê pelas duas)
  return ids.remote?{ orgId, repo:ids.remote, ids }:null;
}
async function prefsPull(){ // nuvem → .cardume/PREFS.md local (todo mundo pega a última do time)
  const k=await prefsKey(); if(!k) return;
  try{ const rows=await sbGet('project_prefs?select=repo,content,updated_at&org_id=eq.'+k.orgId+'&'+remoteInQ('repo', k.ids));
    const r=remotePick(rows, k.ids, 'repo');
    if(r) await invoke('repo_doc_write',{ doc:'PREFS.md', content:r.content||'' }); }catch(_){ }
}
// F4 (G1): Projeto › Regras. Os três blocos aparecem SEMPRE que há projeto: proteção (local), checagens (local,
// .cardume/checks.json — inventário 13: antes só com login + org + remote) e convenções (só essas pedem conta + remote).
// "Salvar pro time" mora na barra fixa, só aparece com mudança e NÃO fecha a aba.
let prefsK=null, prefsLoaded='';
// rascunho das convenções ainda não salvo (vale pro projeto em que foi CARREGADO — prefsK.path)
function prefsDirty(){ const ta=$id('prefsText'); return !!(prefsK && ta && ta.value!==prefsLoaded); }
function prefsBarSync(){ const bar=$id('prefsBar'); if(bar) bar.hidden=!prefsDirty(); }
async function openPrefs(){
  const ov=$id('prefsOverlay');
  const repoPath=(state&&state.repo)||'';
  // rascunho não salvo DESTE projeto: reabrir (voltar pra seção/aba) não joga fora o que foi digitado
  if(prefsDirty() && prefsK.path===repoPath){ ovShow(ov); prefsBarSync(); return; }
  ovShow(ov); // nunca aba em branco: sem projeto a página Projeto mostra o estado "Esta página é de um projeto"
  if(!repoPath) return;
  // Proteção dos agentes é LOCAL (vale nesta máquina, por pasta do projeto) — não depende de conta/nuvem
  { const h=$id('prefsProtHost'); if(h){ if(typeof protectPrefsHtml==='function'){ if(!protectLoaded) await protectLoad(); h.innerHTML=protectPrefsHtml(repoPath); protectPrefsWire(repoPath); } else h.innerHTML=''; } }
  if(typeof prefsChecksRender==='function') prefsChecksRender(); // checagens: sem conta e sem GitHub também
  $id('prefsRepo').textContent=pathBase(repoPath);
  const cloudOk=!!(SB.sess()&&cloudData&&cloudData.org);
  const k=cloudOk?await prefsKey():null; prefsK=k?Object.assign({ path:repoPath }, k):null; // a chave (org+repo) fica presa ao projeto carregado
  const ta=$id('prefsText'), off=$id('prefsConvOff'); const box=ta&&(ta.closest('.ceditor')||ta);
  if(box) box.style.display=k?'':'none';
  { const sc=$id('prefsConvScope'); if(sc){ const tm=cloudData&&cloudData.teams&&cloudData.teams.find(t=>t.id===(typeof cloudTeamId==='function'?cloudTeamId():'')); sc.textContent=tm?'Time '+tm.name:'Time'; } }
  if(!k){
    if(off){ off.hidden=false; off.textContent=cloudOk?'As convenções do time precisam de um repositório com git remote (publique o projeto no GitHub em Projetos).':'Entre na sua conta pra escrever as convenções do time — proteção e checagens já valem sem conta.'; }
    $id('prefsMeta').textContent=''; prefsBarSync(); return;
  }
  if(off) off.hidden=true;
  $id('prefsMeta').textContent='';
  mountEditor(ta, { markdown:true });
  if(!ta.__prefsWired){ ta.__prefsWired=true; ta.addEventListener('input', prefsBarSync); }
  try{
    const rows=await tabBusy('projeto', sbGet('project_prefs?select=repo,content,updated_by,updated_at&org_id=eq.'+k.orgId+'&'+remoteInQ('repo', k.ids)), { label:'buscando as convenções do time' });
    const r=remotePick(rows, k.ids, 'repo'); // salvar grava na forma nova — a antiga fica como estava
    prefsLoaded=(r&&r.content)||''; editorSet(ta, prefsLoaded);
    if(r){ const who=(cloudData.profileByUser&&cloudData.profileByUser[r.updated_by])||{}; $id('prefsMeta').textContent='última edição: '+((who.name||who.email||'alguém'))+' · '+new Date(r.updated_at).toLocaleString('pt-BR'); }
    else $id('prefsMeta').textContent='ainda em branco — escreva as convenções do projeto';
  }catch(e){ $id('prefsMeta').textContent=humanErr(e,'Não consegui carregar as convenções').msg; }
  prefsBarSync();
}
bindClick('prefsBtn', ()=>{ if(window.openTab) window.openTab('prefs'); else openPrefs(); });
$id('prefsClose').onclick=()=>{ ovHide('prefsOverlay'); };
bindClick('prefsGoMem', ()=>{ if(window.projGo) window.projGo('memoria'); else if(window.openTab) window.openTab('memoria'); });
$id('prefsCancel').onclick=()=>{ const ta=$id('prefsText'); if(ta){ editorSet(ta, prefsLoaded); } prefsBarSync(); };
$id('prefsSave').onclick=async()=>{
  const k=prefsK; if(!k) return; // grava no projeto que foi CARREGADO (nunca no que estiver aberto agora)
  const b=$id('prefsSave'); b.disabled=true; b.textContent='salvando…';
  const content=$id('prefsText').value;
  try{
    await sbFetch('/rest/v1/project_prefs?on_conflict=org_id,repo',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ org_id:k.orgId, repo:k.repo, content, updated_by:cloudUserId(), updated_at:new Date().toISOString() }) });
    if(k.path===((state&&state.repo)||'')) await invoke('repo_doc_write',{ doc:'PREFS.md', content }).catch(()=>{}); // desce pro repo já (só se ainda é o aberto; senão o prefsPull do outro projeto traz)
    prefsLoaded=content; $id('prefsMeta').textContent='✓ salvo pro time · aplica nas próximas tarefas';
  }catch(e){ $id('prefsMeta').textContent=humanErr(e,'Não consegui salvar as convenções').msg; }
  finally{ b.disabled=false; b.textContent='Salvar pro time'; prefsBarSync(); }
};
// ---- Preferências do projeto → "Checagens antes de aprovar" (FT-5a) ----
// Detectadas na cópia da tarefa/repo (package.json, Cargo, pytest, go.mod) com liga/desliga + comandos
// próprios. Salvo em <repo>/.cardume/checks.json (local, sem precisar de conta). O mesmo editor aparece
// dentro da Entrega ("checagens") — quem não usa a nuvem também configura.
const chkDraft={}; // chave → { detected, file, cfg } (rascunho sobrevive a re-render da tela)
async function chkCfgEditor(box, taskId, onSaved){
  if(!box) return;
  const key=(taskId||'repo')+'@'+(state.repo||'');
  let d=chkDraft[key];
  if(!d){
    box.innerHTML='<div class="dim" style="font-size:var(--fs-sm)">lendo as checagens do projeto…</div>';
    try{ const c=await invoke('checks_config',{ taskId:taskId||null });
      d=chkDraft[key]={ detected:(c&&c.detected)||[], file:(c&&c.file)||'', cfg:JSON.parse(JSON.stringify((c&&c.cfg)||{})) }; }
    catch(e){ box.innerHTML=`<div class="dim" style="font-size:var(--fs-sm)">${esc(humanErr(e,'Não consegui ler as checagens').msg)}</div>`; return; }
  }
  const cfg=d.cfg; cfg.enabled=cfg.enabled||{}; cfg.custom=Array.isArray(cfg.custom)?cfg.custom:[];
  const paint=()=>{
    const on=x=>cfg.enabled[x.id]!==undefined?!!cfg.enabled[x.id]:!!x.on;
    box.innerHTML=`<div class="ckcfg">
      <div class="ckh"><b>Checagens antes de aprovar</b><span class="dim">rodam na cópia de cada tarefa; com alguma falhando, "aprovar e abrir PR" fica bloqueado (dá pra liberar com um motivo)</span></div>
      ${d.detected.length?d.detected.map(x=>`<label class="ckrow"><input type="checkbox" data-ckon="${escA(x.id)}"${on(x)?' checked':''}><b>${esc(x.label)}</b><span class="mono ckcmd">${esc(x.cmd)}</span><span class="cksrc">detectado · ${esc(x.source)}</span></label>`).join('')
        :'<div class="dim ckempty">nada detectado automaticamente (sem package.json com lint/test, Cargo.toml, pytest ou go.mod) — adicione um comando abaixo</div>'}
      ${cfg.custom.map((x,i)=>`<div class="ckrow ckcustom"><input type="checkbox" data-ccon="${i}"${x.on===false?'':' checked'}><input class="in" data-cclabel="${i}" value="${escA(x.label||'')}" placeholder="nome (ex.: Testes E2E)"><input class="in mono" data-cccmd="${i}" value="${escA(x.cmd||'')}" placeholder="comando (ex.: npx playwright test)"><button class="btn sm ghost" data-ccdel="${i}" title="remover">✕</button></div>`).join('')}
      <div class="ckfoot"><button class="btn sm" data-ccadd="1">+ comando próprio</button>
        <span class="dim">tempo-limite</span><input class="in" type="number" min="1" max="120" data-cktime="1" value="${escA(String(cfg.timeoutMin||10))}"><span class="dim">min cada</span>
        <span style="flex:1"></span><span class="dim mono ckfile" title="${escA(d.file)}">.cardume/checks.json</span><button class="btn sm primary" data-cksave="1">salvar checagens</button></div>
    </div>`;
    box.querySelectorAll('[data-ckon]').forEach(el=>el.onchange=()=>{ cfg.enabled[el.dataset.ckon]=el.checked; });
    box.querySelectorAll('[data-ccon]').forEach(el=>el.onchange=()=>{ cfg.custom[+el.dataset.ccon].on=el.checked; });
    box.querySelectorAll('[data-cclabel]').forEach(el=>el.oninput=()=>{ cfg.custom[+el.dataset.cclabel].label=el.value; });
    box.querySelectorAll('[data-cccmd]').forEach(el=>el.oninput=()=>{ cfg.custom[+el.dataset.cccmd].cmd=el.value; });
    box.querySelectorAll('[data-ccdel]').forEach(el=>el.onclick=()=>{ cfg.custom.splice(+el.dataset.ccdel,1); paint(); });
    box.querySelectorAll('[data-ccadd]').forEach(el=>el.onclick=()=>{ cfg.custom.push({ id:'custom:'+Date.now().toString(36), label:'', cmd:'', on:true }); paint(); const i=box.querySelectorAll('[data-cclabel]'); if(i.length) i[i.length-1].focus(); });
    box.querySelectorAll('[data-cktime]').forEach(el=>el.oninput=()=>{ const n=Math.round(+el.value); if(n>=1&&n<=120) cfg.timeoutMin=n; });
    box.querySelectorAll('[data-cksave]').forEach(el=>el.onclick=async()=>{
      el.disabled=true; const o=el.textContent; el.textContent='salvando…';
      const clean={ ...cfg, custom:cfg.custom.filter(x=>String(x.cmd||'').trim()).map(x=>({ ...x, label:String(x.label||'').trim()||String(x.cmd).trim(), cmd:String(x.cmd).trim() })) };
      try{ await invoke('checks_save',{ cfg:clean }); Object.keys(chkDraft).forEach(k=>delete chkDraft[k]);
        if(typeof chkCfg!=='undefined') Object.keys(chkCfg).forEach(k=>delete chkCfg[k]);
        toast('checagens salvas — valem pras próximas aprovações','ok'); if(onSaved) onSaved(); else chkCfgEditor(box, taskId); }
      catch(e){ showErr(e, 'Não salvou'); el.disabled=false; el.textContent=o; }
    });
  };
  paint();
}
{ const mb=document.querySelector('#prefsOverlay .mbody');
  if(mb && !$id('prefsChecks')){ const sec=document.createElement('div'); sec.className='prefs-sec'; sec.id='prefsChecks'; mb.appendChild(sec); } }
function prefsChecksRender(){ const box=$id('prefsChecks'); if(!box || !state.repo) return; delete chkDraft['repo@'+state.repo]; chkCfgEditor(box, null); }
$id('pcClose').onclick=()=>{ ovHide('pcOverlay'); };
$id('pcSend').onclick=pcSend;
$id('pcTask').onclick=pcToTask;
$id('pcClear').onclick=async()=>{
  if(pcBusy && pcBusyRepo===(state.repo||'')){ toast('Ainda respondendo — pare (■) antes de começar uma conversa nova.','warn'); return; } // a resposta chegaria numa conversa apagada
  if(await askYes('Começar uma conversa nova? (a atual some)','Nova conversa')){ lsSet(pcKey(),''); lsSet('pcsid:'+(state.repo||''),''); pcRender(); } };
$id('pcOverlay').addEventListener('click',e=>{ if(e.target.id==='pcOverlay') ovHide('pcOverlay'); });

// ---------- daily do dev ----------
let dailyData=null, dailyCommits={}, dailyIso='', dailyGen=0, dailyLoading=false; // dailyIso: o dia DE dailyData (o seletor pode já estar em outra data); dailyGen: muda a cada leitura
function dayBounds(iso){ const [y,m,d]=iso.split('-').map(Number); const a=new Date(y,m-1,d).getTime(); return [a, a+86400e3]; }
// data local "AAAA-MM-DD" ± n dias (o input type=date usa o dia LOCAL, não o UTC)
function dailyIsoShift(iso, n){ const [y,m,d]=String(iso).split('-').map(Number); const t=new Date(y,m-1,d+(n||0)); return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); }
// carregamento único (skeleton com a forma dos cards + erro com "tentar de novo"). Trocar a data rápido não deixa
// a resposta velha pintar por cima da nova (loadInto descarta a leitura que ficou pra trás).
function loadDaily(){
  const iso=$id('dailyDate').value; if(!iso) return;
  const [a,b]=dayBounds(iso);
  const gen=++dailyGen; dailyData=null; dailyIso=''; dailyLoading=true; dailyBtnsPaint(); // nada de relatório com os dados do dia anterior enquanto este carrega (ou se falhar)
  const run=loadInto($id('dailyBody'), 'cards', async()=>{
    const data=(await invoke('daily_digest',{ fromMs:a, toMs:b }))||[];
    // commits do dia por tarefa (branch pode já ter ido embora — ok)
    const commits={};
    await Promise.all(data.map(async t=>{ try{ const cs=await invoke('task_commits',{ taskId:t.id }); commits[t.id]=(cs||[]).filter(c=>(c.date||'')===iso); }catch(_){ commits[t.id]=[]; } }));
    return { data, commits };
  }, r=>{ if(gen!==dailyGen) return; dailyData=r.data; dailyCommits=r.commits; dailyIso=iso; dailyLoading=false; lastDailyMd=null; renderDaily(); },
  { label:'montando o dia', ctx:'Não consegui montar o dia', isEmpty:()=>false, shape:{ head:true, n:4 }, retry:()=>loadDaily() });
  Promise.resolve(run).then(st=>{ if(st==='fail' && gen===dailyGen) dailyErrHead(iso); }).finally(()=>{ if(gen===dailyGen){ dailyLoading=false; dailyBtnsPaint(); } });
  return run;
}
// R8: a tela de erro do Daily mantém o seletor de data (antes o erro ocupava a aba e só dava pra "tentar de novo" o MESMO dia)
function dailyErrHead(iso){
  const body=$id('dailyBody'); const er=body&&body.querySelector(':scope>.ld-err'); if(!er || body.querySelector('#dlDate')) return;
  const h=document.createElement('div'); h.className='appscreen dl-errhead'; h.style.cssText='min-height:0;padding-bottom:0';
  h.innerHTML=`<div class="as-head"><div><p class="as-sub">Não deu pra montar este dia — tente de novo ou escolha outra data.</p></div>
    <div class="as-actions"><input type="date" id="dlDate" class="as-btn as-mono" value="${escA(iso)}" aria-label="dia do relatório" style="color:var(--text);padding:8px 12px"></div></div>`;
  body.insertBefore(h, er);
  const d=h.querySelector('#dlDate'); d.onchange=()=>{ if(!d.value){ d.value=iso; return; } // apagou a data (×): volta pro dia que falhou
    const old=$id('dailyDate'); if(old) old.value=d.value; loadDaily(); };
}
function renderDaily(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const body=$id('dailyBody'); if(!body||!dailyData) return;
  const iso=dailyIso||($id('dailyDate')||{}).value||'';
  // F4 (D20): o Daily virou Central › Concluídas › Resumo do período — sem H1 próprio (a Central já tem o cabeçalho)
  const head=`<div class="rs-bar"><label class="rs-l">Dia <input type="date" id="dlDate" aria-label="dia do resumo" class="in" value="${escA(iso)}"></label>
    <span class="dim rs-proj" title="o resumo lê o projeto aberto">${esc(pathBase(state.repo||''))}</span><span class="dim">o que os agentes fizeram, pronto pra colar na reunião</span><span class="grow"></span>
    <button class="btn sm" id="dlAI">Resumo curto</button><button class="btn primary sm" id="dlDoc" title="o relatório técnico do período (o quê · por quê · arquitetura · como validar) — salvar .md ou PDF">Gerar relatório do período</button></div>`;
  if(!dailyData.length){ body.innerHTML=`<div class="appscreen">${head}<div style="margin-top:22px">${emptyHtml({ icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><rect x="2.6" y="3.4" width="10.8" height="10" rx="1.6"/><path d="M2.6 6.6h10.8M5.4 2.2v2.4M10.6 2.2v2.4"/></svg>', title:'Dia sem atividade', help:'Nenhuma tarefa deste projeto teve movimento em '+(iso?iso.split('-').reverse().join('/'):'nesse dia')+'.', action:{ label:'ver o dia anterior', id:'dlPrev', primary:false } })}</div></div>`; wireDaily(); return; }
  const totUsd=dailyData.reduce((s,t)=>s+(t.usd||0),0);
  const totCommits=Object.values(dailyCommits).reduce((s,c)=>s+c.length,0);
  const merged=dailyData.filter(t=>['merged','done'].includes(t.status)).length, rev=dailyData.filter(t=>['review','delivered'].includes(t.status)).length;
  const kpis=[[dailyData.length,dailyData.length===1?'tarefa tocada':'tarefas tocadas',''],[totCommits,totCommits===1?'commit':'commits',''],[rev+merged,'prontas ou mergeadas','var(--accent)'],[fmtUsd(totUsd),'custo do dia · ≈ R$ '+fmtNumBR(totUsd*usdBrlRate(), true),'']];
  const kpiRow=`<div class="as-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:22px 0 24px">${kpis.map(k=>`<div class="as-card"><div style="font:600 var(--fs-xl)/1 var(--display);color:${k[2]||'var(--text)'}">${k[0]}</div><div style="margin-top:8px;font:500 var(--fs-xs) var(--code);letter-spacing:.12em;color:var(--text-3)">${esc(k[1])}</div></div>`).join('')}</div>`;
  const cards=dailyData.map(t=>{
    const cs=dailyCommits[t.id]||[];
    const commits=cs.length?cs.slice(0,6).map(c=>`<div style="display:flex;gap:10px;padding:5px 0;font:400 var(--fs-sm)/1.45 var(--code);min-width:0"><span style="color:var(--accent);flex:none">${esc((c.hash||'').slice(0,7))}</span><span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.subject||'')}</span></div>`).join('')+(cs.length>6?`<div style="margin-top:6px;font:500 var(--fs-sm) var(--display);color:var(--text-3)">+${cs.length-6} commits</div>`:''):'<div class="dim" style="font-size:var(--fs-sm)">sem commits</div>';
    const log=(t.notes||[]).slice(0,6).map(n=>`<div style="display:flex;gap:9px;padding:4px 0;font:400 var(--fs-sm)/1.45 var(--display);color:var(--muted)"><span aria-hidden="true" style="color:var(--text-3)">·</span>${esc(n)}</div>`).join('')||'<div class="dim" style="font-size:var(--fs-sm)">—</div>';
    return `<div class="as-card" style="padding:0;overflow:hidden">
      <div style="display:flex;align-items:flex-start;gap:14px;padding:16px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <div style="flex:1;min-width:260px"><div style="font:600 16px/1.3 var(--display)">${esc(t.title)}</div><div style="margin-top:7px;font:400 var(--fs-xs) var(--code);color:var(--text-3)">${esc(t.branch||'')}</div></div>
        <div style="display:flex;align-items:center;gap:14px">${stBadge(taskSt(t))}<span style="font:500 var(--fs-sm) var(--code);color:var(--muted)">${t.usd?fmtCost(t.usd):''}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)">
        <div style="padding:14px 18px;border-right:1px solid var(--border)"><div class="as-sect" style="margin:0 0 10px">COMMITS · ${cs.length}</div>${commits}</div>
        <div style="padding:14px 18px"><div class="as-sect" style="margin:0 0 10px">O QUE O AGENTE FEZ NO DIA</div>${log}</div>
      </div></div>`;
  }).join('');
  body.innerHTML=`<div class="appscreen">${head}${kpiRow}<div id="dailyAIOut"></div><div style="display:flex;flex-direction:column;gap:12px">${cards}</div></div>`;
  wireDaily();
}
function wireDaily(){
  const b=$id('dailyBody'); if(!b) return;
  { const d=b.querySelector('#dlDate'); if(d) d.onchange=()=>{ const old=$id('dailyDate'); if(old) old.value=d.value; loadDaily(); }; }
  { const a=b.querySelector('#dlAI'); if(a) a.onclick=dailyAISummary; }
  { const dd=b.querySelector('#dlDoc'); if(dd) dd.onclick=dailyGenDoc; }
  { const p=b.querySelector('#dlPrev'); if(p) p.onclick=()=>{ const old=$id('dailyDate'); if(!old||!old.value) return; old.value=dailyIsoShift(old.value,-1); loadDaily(); }; }
  dailyBtnsPaint();
}
// "resumo curto" e "DOC + PDF": o estado ocupado vive AQUI e vale pros dois pares de botões (os do cabeçalho da aba,
// dlAI/dlDoc, e os antigos do modal, dailyAI/dailyDoc). Antes só o botão ESCONDIDO mudava: o visível seguia
// clicável e um segundo clique disparava outra chamada à IA.
const dailyBusy={ ai:false, doc:false };
// @puro-inicio dailyBtnState — estado de um botão: escrevendo (busy) › carregando o dia › dia sem atividade › livre
function dailyBtnState(k, st){
  const on=k==='ai'?'escrevendo…':'escrevendo o relatório…', off=k==='ai'?'Resumo curto':'Gerar relatório do período';
  if(st.busy) return { disabled:true, label:on, title:'' };
  if(st.loading) return { disabled:true, label:off, title:'espere o dia carregar' };
  if(!st.has) return { disabled:true, label:off, title:'dia sem atividade — troque a data' };
  return { disabled:false, label:off, title:null }; // null = volta o título original do botão
}
// @puro-fim dailyBtnState
function dailyBtnsPaint(){
  [['dlAI','dailyAI','ai'],['dlDoc','dailyDoc','doc']].forEach(([v,h,k])=>{
    const x=dailyBtnState(k, { busy:dailyBusy[k], loading:dailyLoading, has:!!(dailyData&&dailyData.length) });
    [v,h].forEach(id=>{ const el=$id(id); if(!el) return;
      if(el.dataset.t0===undefined) el.dataset.t0=el.getAttribute('title')||''; // o título original (o do DOC + PDF explica o relatório) não some
      el.disabled=x.disabled; el.title=x.title==null?el.dataset.t0:x.title; if(el.id===v) el.textContent=x.label; });
  });
}
async function dailyAISummary(){
  if(!dailyData||!dailyData.length||dailyBusy.ai) return;
  dailyBusy.ai=true; dailyBtnsPaint();
  const gen=dailyGen;
  const facts=dailyData.map(t=>{
    const cs=(dailyCommits[t.id]||[]).map(c=>c.subject).join('; ');
    return `TAREFA: ${t.title} [status atual: ${t.status}]${t.asks?' [tem pergunta pendente pro dev]':''}\ncommits do dia: ${cs||'nenhum'}\nmarcos: ${(t.notes||[]).join(' | ')||'-'}`;
  }).join('\n\n');
  try{
    const md=await invoke('ai_daily',{ text: facts });
    if(gen!==dailyGen) return; // trocou a data no meio: o resumo é do dia anterior — descarta
    dailyOut(`<div class="prbox" style="margin:6px 0 12px"><div class="mdview" style="font-size:var(--fs-base)">${mdToHtml(md)}</div><div class="prrow" style="margin-top:8px"><span class="grow"></span><button class="btn sm" id="dailyCopy">copiar pra daily</button></div></div>`);
    $id('dailyCopy').onclick=function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; };
  }catch(e){ if(gen===dailyGen) showErr(e, 'Não consegui escrever o resumo'); }
  finally{ dailyBusy.ai=false; dailyBtnsPaint(); }
}
// ---- RELATÓRIO técnico do dia (DOC .md + PDF) ----
let lastDailyMd=null, lastDailyDate='';
function dailyReportFacts(){
  return (dailyData||[]).map(t=>{
    // só o assunto do commit (sem hash), pra descrever a mudança
    const cs=(dailyCommits[t.id]||[]).map(c=>c.subject||'').filter(Boolean);
    const st=(state.tasks||[]).find(x=>x.id===t.id);
    const obj=(st&&st.objective)||'';
    const d=diffOf(t.id);
    const nfiles=d?(Array.isArray(d.files)?d.files.length:(typeof d.files==='number'?d.files:0)):0;
    const scope=nfiles?`~${nfiles} arquivo(s)`:'';
    // marcos ÚTEIS: descarta o ruído de engine/processo (não vai pra diretoria)
    const marcos=(t.notes||[]).filter(n=>!/sess[aã]o iniciada|iniciando claude|claude finaliz|pipeline parado|worktree criada|bypasspermission|approval:|perguntou ao humano|humano respondeu|\btimeout\b|rework/i.test(n)).slice(0,6);
    return `ENTREGA: ${t.title}\ncontexto/objetivo: ${obj||'—'}\nmudanças: ${cs.join(' | ')||'—'}\nescopo: ${scope||'—'}\nnotas: ${marcos.join(' | ')||'—'}`;
  }).join('\n\n---\n\n');
}
// @cor-dado-inicio — Daily EXPORTADO: documento HTML próprio pra imprimir/PDF (papel branco), fora dos temas do app
function dailyPdfHtml(md, date){
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{margin:2cm}
    body{font:var(--fs-md)/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;color:#1b1f23}
    h1{font-size:23px;border-bottom:2px solid #16a34a;padding-bottom:8px;margin:0 0 6px}
    h2{font-size:16px;color:#0f172a;margin:22px 0 6px;border-left:3px solid #16a34a;padding-left:9px}
    h3{font-size:var(--fs-md);margin:14px 0 4px}
    code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font:var(--fs-sm) ui-monospace,Menlo,monospace}
    pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow:auto} pre code{background:none;padding:0}
    strong{color:#0f172a} ul{margin:6px 0;padding-left:22px} li{margin:3px 0} a{color:#16a34a}
    .foot{margin-top:34px;padding-top:10px;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:var(--fs-xs)}
  </style></head><body>${mdToHtml(md)}<div class="foot">Gerado pelo Starfork · ${esc(date||'')}</div></body></html>`;
}
// @cor-dado-fim
function dailyOut(html){ const el=$id('dailyAIOut'); if(el) el.innerHTML=html; }
async function dailyGenDoc(){
  const out=$id('dailyAIOut');
  if(!dailyData||!dailyData.length){ dailyOut('<div class="imhint" style="border-left:2px solid var(--warn)">Dia sem atividade — nenhuma tarefa teve eventos nesse dia. Troque a data no topo.</div>'); return; }
  if(dailyBusy.doc) return;
  dailyBusy.doc=true; dailyBtnsPaint();
  const iso=dailyIso, gen=dailyGen; // a data DOS DADOS (não a do seletor, que pode ter mudado sem carregar)
  dailyOut('<div class="prbox" style="margin:6px 0 14px;display:flex;align-items:center;gap:10px"><span class="pubspin"></span><span class="dim" style="font-size:var(--fs-sm)">a IA está redigindo o relatório técnico do dia (o quê · por quê · arquitetura · como validar)… pode levar até 1 min</span></div>');
  try{
    const md=await invoke('ai_daily_report',{ text: dailyReportFacts(), date: iso });
    if(gen!==dailyGen) return; // o dia mudou durante a escrita: não salva/mostra relatório com a data errada
    lastDailyMd=md; lastDailyDate=iso;
    dailyOut(`<div class="prbox" style="margin:6px 0 14px"><div class="mdview" style="font-size:var(--fs-base)">${mdToHtml(md)}</div><div class="prrow" style="margin-top:10px;gap:8px;display:flex"><button class="btn sm" id="dailyCopy2">copiar</button><button class="btn sm" id="dailySaveMd">${ic('save')}salvar .md</button><button class="btn primary sm" id="dailyPdf">${ic('doc')}gerar PDF</button><span class="grow" style="flex:1"></span></div><div class="dim" id="dailyDocMsg" style="font-size:var(--fs-xs);margin-top:6px"></div></div>`);
    $id('dailyCopy2').onclick=function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; };
    $id('dailySaveMd').onclick=async function(){ this.disabled=true; try{ const p=await invoke('save_doc',{ name:`relatorio-${iso}.md`, content:md }); this.textContent='salvo ✓'; const m=$id('dailyDocMsg'); if(m) m.textContent='DOC salvo em '+p; }catch(e){ const m=$id('dailyDocMsg'); if(m) m.textContent=humanErr(e,'Não consegui salvar o .md').msg; this.disabled=false; } };
    $id('dailyPdf').onclick=dailyGenPdf;
  }catch(e){ if(gen===dailyGen) dailyOut('<div class="imhint" style="border-left:2px solid var(--crit)">'+esc(humanErr(e,'Não consegui escrever o relatório').msg)+'</div>'); }
  finally{ dailyBusy.doc=false; dailyBtnsPaint(); }
}
async function dailyGenPdf(){
  if(!lastDailyMd) return;
  const b=$id('dailyPdf'); b.disabled=true; const o=b.textContent; b.textContent='gerando PDF…';
  const m=$id('dailyDocMsg');
  try{
    const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(lastDailyMd, lastDailyDate), name:`relatorio-${lastDailyDate}` });
    b.textContent='PDF aberto ✓'; if(m) m.textContent='PDF em '+p;
  }catch(e){ if(m) m.textContent=humanErr(e,'Não consegui gerar o PDF').msg; b.textContent=o; }
  b.disabled=false; setTimeout(()=>{ if(b) b.textContent=o; }, 2500);
}
function openDaily(){
  const d=new Date(); const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const inp=$id('dailyDate'); if(!inp.value) inp.value=iso;
  $id('dailyOverlay').style.display='flex';
  loadDaily();
}
$id('dailyBtn').onclick=openDaily;
// barra lateral colapsável (⌘B) — o overlay de tarefa lê --rail-w e reflui sozinho
function railIsCol(){ return document.querySelector('.app').classList.contains('railcol'); }
function railPaint(v){
  document.querySelector('.app').classList.toggle('railcol', !!v);
  // recolhida = fora do Tab e do leitor de tela (antes os 13 controles escondidos continuavam no Tab, com foco invisível)
  { const sb=$id('sidebar'); if(sb){ const tinha=v && sb.contains(document.activeElement); sb.inert=!!v; if(tinha){ const m=$id('railToggleMain'); if(m) try{ m.focus(); }catch(_){ } } } }
  // aberta: tira o valor inline e deixa o CSS decidir (83-responsivo estreita a barra em janela pequena)
  if(v) document.documentElement.style.setProperty('--rail-w','0px'); else document.documentElement.style.removeProperty('--rail-w');
  const b=$id('railToggle'); if(b) b.setAttribute('aria-pressed', v?'true':'false');
  requestAnimationFrame(syncChromeH); setTimeout(syncChromeH, 320); // o topo muda de altura ao recolher (com transição) — a view-aba desce junto
}
// JANELA ESTREITA (crítica Impeccable P2): abaixo de ~760 px — ou com menos de ~600 px pro conteúdo — a barra
// lateral recolhe SOZINHA (o mesmo modo recolhido do ⌘B), sem gravar a escolha: alargou, volta como você deixou.
// Recolhida automática, o botão de expandir abre só desta vez (não grava). ResizeObserver (sem laço, sem polling).
// @rail-auto-inicio (testado em app/tests/critica-impeccable.test.mjs)
const RAIL_AUTO_WIN=760, RAIL_AUTO_CONTENT=600;
function railAutoNarrow(winW){ const railW=winW<1100?220:250; return winW<RAIL_AUTO_WIN || (winW-railW)<RAIL_AUTO_CONTENT; }
// @rail-auto-fim
const RAIL_AUTO={ on:false, open:false };
function setRailCollapsed(v){
  if(RAIL_AUTO.on){ RAIL_AUTO.open=!v; railPaint(!!v); return; } // estreita: não mexe na preferência salva
  lsSet('railCollapsed', v?'1':'0'); railPaint(!!v);
}
function railAutoFit(){
  const narrow=railAutoNarrow(window.innerWidth);
  if(narrow===RAIL_AUTO.on) return;
  RAIL_AUTO.on=narrow; RAIL_AUTO.open=false;
  railPaint(narrow || lsGet('railCollapsed')==='1');
}
$id('railToggle').onclick=()=>setRailCollapsed(!railIsCol());
{ const m=$id('railToggleMain'); if(m) m.onclick=()=>setRailCollapsed(false); } // botão de expandir (aparece só recolhido)
railPaint(lsGet('railCollapsed')==='1');
if(!(typeof SF_PANE!=='undefined' && SF_PANE)){
  railAutoFit();
  if(typeof ResizeObserver==='function') new ResizeObserver(()=>requestAnimationFrame(railAutoFit)).observe(document.documentElement);
}
