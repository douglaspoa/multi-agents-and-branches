// Constellation — 12-chat-prefs-daily
// ---------- chat do projeto ----------
let pcBusy=false;
function pcKey(){ return 'pchat:'+(state.repo||''); }
function pcMsgs(){ try{ return JSON.parse(lsGet(pcKey())||'[]'); }catch(_){ return []; } }
function pcSave(ms){ lsSet(pcKey(), JSON.stringify(ms.slice(-60))); }
function pcRender(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const th=$id('pcThread'); if(!th) return;
  const ms=pcMsgs();
  const repo=esc((state.repo||'o projeto').split('/').pop());
  const projOpts=(typeof projList==='function'?projList():[]).map(([path,name])=>`<option value="${escA(path)}"${path===state.repo?' selected':''}>${esc(name)}</option>`).join('');
  const head=`<div class="pc-head"><div><h1 class="as-h1" style="font-size:24px">Chat do projeto</h1><p class="as-sub">Ele lê o código de verdade antes de responder — e não altera nada.</p></div><div class="as-actions"><select class="sel" id="pcProj" title="sobre qual projeto você quer conversar" style="max-width:220px">${projOpts}</select><button class="as-btn" id="pcTask2">virar tarefa</button><button class="as-btn" id="pcClear2" style="border-color:transparent;color:rgba(255,255,255,.42)">limpar</button></div></div>`;
  let bodyHtml;
  if(ms.length){
    bodyHtml=`<div class="pc-thread">${ms.map(m=>m.role==='user'?`<div class="pc-msg you"><div class="pc-bub">${esc(m.text)}${attRowHtml(m.atts)}</div></div>`:`<div class="pc-msg"><div class="pc-bub">${mdToHtml(m.text)}</div></div>`).join('')}${pcBusy?'<div class="pc-msg"><div class="pc-bub" style="padding:0;min-width:280px;overflow:hidden">'+cosmosHtml('lendo o projeto…','inline')+'</div></div>':''}</div>`;
  } else {
    const sugg=[['ARQUITETURA','como o autocomplete resolve o ranking hoje?'],['ONDE FICA','onde fica a lógica de autenticação?'],['POR QUÊ','por que o cache é invalidado desse jeito?'],['IDEIA','como eu adicionaria rate limiting aqui?']];
    bodyHtml=`<div class="pc-empty"><div class="pc-empty-t">Pergunte qualquer coisa sobre <span class="as-mono" style="color:var(--accent)">${repo}</span></div><div class="pc-empty-d">Arquitetura, "onde fica X", "por que Y é assim", ideias. Gostou de uma resposta? <b style="color:#eaf2ee">virar tarefa</b> transforma a conversa numa spec pronta.</div><div class="pc-sugg">${sugg.map(s=>`<button class="pc-sc" data-sg="${escA(s[1])}"><span class="pc-sc-t">${esc(s[0])}</span><span class="pc-sc-x">${esc(s[1])}</span></button>`).join('')}</div></div>`;
  }
  th.innerHTML=`<div class="appscreen" style="padding:24px 34px 16px">${head}${bodyHtml}</div>`;
  { const b=th.querySelector('#pcTask2'); if(b) b.onclick=()=>{ const o=$id('pcTask'); if(o) o.click(); }; }
  { const b=th.querySelector('#pcClear2'); if(b) b.onclick=()=>{ const o=$id('pcClear'); if(o) o.click(); }; }
  { const s=th.querySelector('#pcProj'); if(s) s.onchange=async()=>{ const p=s.value; if(p&&p!==state.repo&&window.switchProject){ await switchProject(p); } pcRender(); }; }
  th.querySelectorAll('[data-sg]').forEach(b=>b.onclick=()=>{ const i=$id('pcInput'); if(i){ i.value=b.dataset.sg; i.focus(); } });
  attRenderPend('pcPend', pcPend, pcRender);
  th.scrollTop=th.scrollHeight;
}
let pcPend=[]; // anexos importados, ainda não enviados
async function pcSend(){
  if(pcBusy) return;
  const inp=$id('pcInput'); let text=inp.value.trim();
  const atts=pcPend.splice(0);
  if(!text && atts.length) text='Anexei estes arquivos — leia e considere no contexto do projeto.';
  if(!text) return;
  const ms=pcMsgs(); ms.push({role:'user',text,atts:attLite(atts)}); pcSave(ms); inp.value=''; pcBusy=true; pcRender();
  try{
    const r=await aiCallResumeSafe((pr,sid)=>invoke('project_chat',{ prompt:pr, sessionId:sid||'' }), lsGet('pcsid:'+(state.repo||''))||'', text+attPromptBlock(atts), pcMsgs().slice(0,-1));
    if(r.sessionId) lsSet('pcsid:'+(state.repo||''), r.sessionId);
    const ms2=pcMsgs(); ms2.push({role:'assistant',text:r.text||'(sem resposta)'}); pcSave(ms2);
  }catch(e){ const ms2=pcMsgs(); ms2.push({role:'assistant',text:'⚠ Falhou: '+(e.message||e)}); pcSave(ms2); }
  pcBusy=false; pcRender();
}
async function pcToTask(){
  const btn=$id('pcTask');
  if(!pcMsgs().length){ alert('Converse primeiro — a spec nasce do papo.'); return; }
  btn.disabled=true; btn.textContent='montando spec…';
  try{
    const r=await invoke('project_chat',{ prompt:'Com base APENAS na nossa conversa até aqui, monte a especificação de UMA tarefa executável. Responda SOMENTE um bloco ```json com {"title":"verbo + objeto (máx 60 chars)","objective":"o que fazer, onde e por quê (3-6 frases)","requirements":["critérios de aceite objetivos"]} — nada fora do bloco.', sessionId: lsGet('pcsid:'+(state.repo||''))||'' });
    const m=(r.text||'').match(/```json\s*([\s\S]*?)```/i) || (r.text||'').match(/\{[\s\S]*"objective"[\s\S]*\}/);
    const spec=JSON.parse(m?(m[1]||m[0]):r.text);
    $id('pcOverlay').style.display='none';
    await openNewTask();
    setNtMode('build');
    $id('ntTitle').value=(spec.title||'').slice(0,90);
    $id('ntObj').value=spec.objective||'';
    ntReq=[...new Set((spec.requirements||[]).map(x=>String(x).trim()).filter(Boolean))];
    renderNtList('ntRequirements',ntReq);
    $id('ntArtProof').checked=true;
  }catch(e){ alert('Não consegui montar a spec:\n'+(e.message||e)); }
  finally{ btn.disabled=false; btn.innerHTML=ic('compass')+'virar tarefa'; }
}
function openPc(){ $id('pcOverlay').style.display='flex'; pcRender(); attWireComposer({ input:'pcInput', attach:'pcAttach', pend:()=>pcPend, taskId:()=>null, rerender:pcRender }); setTimeout(()=>$id('pcInput').focus(),80); }
$id('pcBtn').onclick=openPc;
// ---- Preferências do projeto: 1 doc por projeto, o time escreve, agentes seguem ----
async function prefsKey(){
  const orgId=cloudData&&cloudData.org&&cloudData.org.id; if(!orgId) return null;
  let remote=''; try{ remote=await invoke('repo_remote'); }catch(_){ }
  if(!remote){ try{ const info=await invoke('repo_docs'); remote=info&&info.repo; }catch(_){ } }
  return remote?{ orgId, repo:remote }:null;
}
async function prefsPull(){ // nuvem → .cardume/PREFS.md local (todo mundo pega a última do time)
  const k=await prefsKey(); if(!k) return;
  try{ const rows=await sbGet('project_prefs?select=content,updated_at&org_id=eq.'+k.orgId+'&repo=eq.'+encodeURIComponent(k.repo));
    if(rows[0]) await invoke('repo_doc_write',{ doc:'PREFS.md', content:rows[0].content||'' }); }catch(_){ }
}
async function openPrefs(){
  const ov=$id('prefsOverlay');
  if(!SB.sess()||!(cloudData&&cloudData.org)){ alert('Entre na sua conta e escolha uma organização pra usar as preferências do projeto.'); return; }
  const k=await prefsKey(); if(!k){ alert('Abra um projeto (repositório com git remote) primeiro.'); return; }
  $id('prefsRepo').textContent=k.repo.replace(/^https?:\/\/[^/]+\//,'').replace(/\.git$/,'');
  $id('prefsMeta').textContent='carregando…';
  ovShow(ov); // depois do await: respeita o modo aba
  mountEditor($id('prefsText'), { markdown:true });
  try{
    const rows=await sbGet('project_prefs?select=content,updated_by,updated_at&org_id=eq.'+k.orgId+'&repo=eq.'+encodeURIComponent(k.repo));
    const r=rows[0];
    editorSet($id('prefsText'), (r&&r.content)||'');
    if(r){ const who=(cloudData.profileByUser&&cloudData.profileByUser[r.updated_by])||{}; $id('prefsMeta').textContent='última edição: '+((who.name||who.email||'alguém'))+' · '+new Date(r.updated_at).toLocaleString('pt-BR'); }
    else $id('prefsMeta').textContent='ainda em branco — escreva as convenções do projeto';
  }catch(e){ $id('prefsMeta').textContent='falhou: '+(e.message||e); }
}
bindClick('prefsBtn', ()=>{ if(window.openTab) window.openTab('prefs'); else openPrefs(); });
$id('prefsClose').onclick=()=>{ ovHide('prefsOverlay'); };
$id('prefsCancel').onclick=()=>{ ovHide('prefsOverlay'); };
$id('prefsOverlay').addEventListener('click',e=>{ if(e.target.id==='prefsOverlay') ovHide('prefsOverlay'); });
$id('prefsSave').onclick=async()=>{
  const k=await prefsKey(); if(!k) return;
  const b=$id('prefsSave'); b.disabled=true; b.textContent='salvando…';
  const content=$id('prefsText').value;
  try{
    await sbFetch('/rest/v1/project_prefs?on_conflict=org_id,repo',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ org_id:k.orgId, repo:k.repo, content, updated_by:cloudUserId(), updated_at:new Date().toISOString() }) });
    await invoke('repo_doc_write',{ doc:'PREFS.md', content }).catch(()=>{}); // desce pro repo já
    $id('prefsMeta').textContent='✓ salvo pro time · aplica nas próximas tarefas';
  }catch(e){ $id('prefsMeta').textContent='falhou: '+(e.message||e); }
  finally{ b.disabled=false; b.textContent='salvar pro time'; }
};
$id('pcClose').onclick=()=>{ ovHide('pcOverlay'); };
$id('pcSend').onclick=pcSend;
$id('pcTask').onclick=pcToTask;
$id('pcClear').onclick=async()=>{ if(await askYes('Começar uma conversa nova? (a atual some)')){ lsSet(pcKey(),''); lsSet('pcsid:'+(state.repo||''),''); pcRender(); } };
$id('pcInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); pcSend(); } });
$id('pcOverlay').addEventListener('click',e=>{ if(e.target.id==='pcOverlay') ovHide('pcOverlay'); });

// ---------- daily do dev ----------
let dailyData=null, dailyCommits={};
function dayBounds(iso){ const [y,m,d]=iso.split('-').map(Number); const a=new Date(y,m-1,d).getTime(); return [a, a+86400e3]; }
async function loadDaily(){
  const iso=$id('dailyDate').value; if(!iso) return;
  const body=$id('dailyBody');
  body.innerHTML='<div class="dim" style="padding:8px 2px">montando o dia…</div>';
  const [a,b]=dayBounds(iso);
  try{ dailyData=await invoke('daily_digest',{ fromMs:a, toMs:b }); }catch(e){ body.innerHTML='<div class="imhint" style="border-left:2px solid var(--warn)">Falhou: '+esc(String(e))+'</div>'; return; }
  // commits do dia por tarefa (branch pode já ter ido embora — ok)
  dailyCommits={};
  await Promise.all(dailyData.map(async t=>{ try{ const cs=await invoke('task_commits',{ taskId:t.id }); dailyCommits[t.id]=(cs||[]).filter(c=>(c.date||'')===iso); }catch(_){ dailyCommits[t.id]=[]; } }));
  renderDaily();
}
function renderDaily(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const body=$id('dailyBody'); if(!body||!dailyData) return;
  const iso=($id('dailyDate')||{}).value||'';
  const head=`<div class="as-head"><div><h1 class="as-h1">Daily</h1><p class="as-sub">O que os agentes fizeram — pronto pra colar na reunião.</p></div>
    <div class="as-actions"><input type="date" id="dlDate" class="as-btn as-mono" value="${escA(iso)}" style="color:#eaf2ee;padding:8px 12px">
      <button class="as-btn" id="dlAI">resumo curto</button><button class="as-btn primary" id="dlDoc">DOC + PDF</button></div></div>`;
  if(!dailyData.length){ body.innerHTML=`<div class="appscreen">${head}<div class="as-card" style="margin-top:22px;text-align:center;padding:40px"><div style="font:600 16px 'Instrument Sans',sans-serif">Dia sem atividade</div><div class="dim" style="margin-top:6px">nenhuma tarefa teve eventos nesse dia neste projeto.</div></div></div>`; wireDaily(); return; }
  const totUsd=dailyData.reduce((s,t)=>s+(t.usd||0),0);
  const totCommits=Object.values(dailyCommits).reduce((s,c)=>s+c.length,0);
  const merged=dailyData.filter(t=>t.status==='merged').length, rev=dailyData.filter(t=>t.status==='review').length;
  const kpis=[[dailyData.length,'tarefas tocadas',''],[totCommits,'commits',''],[rev+merged,'prontas/merged','var(--accent)'],[fmtUsd(totUsd),'custo do dia','']];
  const kpiRow=`<div class="as-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:22px 0 24px">${kpis.map(k=>`<div class="as-card"><div style="font:600 28px/1 'Instrument Sans',sans-serif;color:${k[2]||'#eaf2ee'}">${k[0]}</div><div style="margin-top:8px;font:500 10px 'JetBrains Mono',monospace;letter-spacing:.12em;color:rgba(255,255,255,.34)">${esc(k[1])}</div></div>`).join('')}</div>`;
  const cards=dailyData.map(t=>{
    const cs=dailyCommits[t.id]||[];
    const commits=cs.length?cs.slice(0,6).map(c=>`<div style="display:flex;gap:10px;padding:5px 0;font:400 12.5px/1.45 'JetBrains Mono',monospace;min-width:0"><span style="color:var(--accent);flex:none">${esc((c.hash||'').slice(0,7))}</span><span style="color:rgba(234,242,238,.62);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.subject||'')}</span></div>`).join('')+(cs.length>6?`<div style="margin-top:6px;font:500 12px 'Instrument Sans',sans-serif;color:rgba(255,255,255,.34)">+${cs.length-6} commits</div>`:''):'<div class="dim" style="font-size:12px">sem commits</div>';
    const log=(t.notes||[]).slice(0,6).map(n=>`<div style="display:flex;gap:9px;padding:4px 0;font:400 12px/1.45 'Instrument Sans',sans-serif;color:rgba(234,242,238,.5)"><span style="color:rgba(255,255,255,.22)">·</span>${esc(n)}</div>`).join('')||'<div class="dim" style="font-size:12px">—</div>';
    return `<div class="as-card" style="padding:0;overflow:hidden">
      <div style="display:flex;align-items:flex-start;gap:14px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.06);flex-wrap:wrap">
        <div style="flex:1;min-width:260px"><div style="font:600 16px/1.3 'Instrument Sans',sans-serif">${esc(t.title)}</div><div style="margin-top:7px;font:400 11.5px 'JetBrains Mono',monospace;color:rgba(255,255,255,.36)">${esc(t.branch||'')}</div></div>
        <div style="display:flex;align-items:center;gap:14px"><span style="display:flex;align-items:center;gap:7px;font:500 12px 'Instrument Sans',sans-serif;color:${ctStColor(t.status)}"><span style="width:7px;height:7px;border-radius:50%;background:${ctStColor(t.status)}"></span>${esc(CT_ST_PT[t.status]||t.status)}</span><span style="font:500 12px 'JetBrains Mono',monospace;color:rgba(255,255,255,.5)">${t.usd?fmtUsd(t.usd):''}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)">
        <div style="padding:14px 18px;border-right:1px solid rgba(255,255,255,.06)"><div class="as-sect" style="margin:0 0 10px">COMMITS · ${cs.length}</div>${commits}</div>
        <div style="padding:14px 18px"><div class="as-sect" style="margin:0 0 10px">TURNO</div>${log}</div>
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
}
async function dailyAISummary(){
  if(!dailyData||!dailyData.length) return;
  const btn=$id('dailyAI'); btn.disabled=true; const o=btn.innerHTML; btn.textContent='escrevendo…';
  const facts=dailyData.map(t=>{
    const cs=(dailyCommits[t.id]||[]).map(c=>c.subject).join('; ');
    return `TAREFA: ${t.title} [status atual: ${t.status}]${t.asks?' [tem pergunta pendente pro dev]':''}\ncommits do dia: ${cs||'nenhum'}\nmarcos: ${t.notes.join(' | ')||'-'}`;
  }).join('\n\n');
  try{
    const md=await invoke('ai_daily',{ text: facts });
    $id('dailyAIOut').innerHTML=`<div class="prbox" style="margin:6px 0 12px"><div class="mdview" style="font-size:13px">${mdToHtml(md)}</div><div class="prrow" style="margin-top:8px"><span class="grow"></span><button class="btn sm" id="dailyCopy">copiar pra daily</button></div></div>`;
    $id('dailyCopy').onclick=function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; };
  }catch(e){ alert('Falhou: '+e); }
  btn.disabled=false; btn.innerHTML=o;
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
function dailyPdfHtml(md, date){
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{margin:2cm}
    body{font:14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;color:#1b1f23}
    h1{font-size:23px;border-bottom:2px solid #16a34a;padding-bottom:8px;margin:0 0 6px}
    h2{font-size:16px;color:#0f172a;margin:22px 0 6px;border-left:3px solid #16a34a;padding-left:9px}
    h3{font-size:14px;margin:14px 0 4px}
    code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,Menlo,monospace}
    pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow:auto} pre code{background:none;padding:0}
    strong{color:#0f172a} ul{margin:6px 0;padding-left:22px} li{margin:3px 0} a{color:#16a34a}
    .foot{margin-top:34px;padding-top:10px;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:11px}
  </style></head><body>${mdToHtml(md)}<div class="foot">Gerado pelo Constellation · ${esc(date||'')}</div></body></html>`;
}
function dailyOut(html){ const el=$id('dailyAIOut'); if(el) el.innerHTML=html; }
async function dailyGenDoc(){
  const out=$id('dailyAIOut');
  if(!dailyData||!dailyData.length){ dailyOut('<div class="imhint" style="border-left:2px solid var(--warn)">Dia sem atividade — nenhuma tarefa teve eventos nesse dia. Troque a data no topo.</div>'); return; }
  const btn=$id('dailyDoc'); if(!btn) return; btn.disabled=true; const o=btn.innerHTML; btn.textContent='escrevendo…';
  const iso=$id('dailyDate').value;
  dailyOut('<div class="prbox" style="margin:6px 0 14px;display:flex;align-items:center;gap:10px"><span class="pubspin"></span><span class="dim" style="font-size:12.5px">a IA está redigindo o relatório técnico do dia (o quê · por quê · arquitetura · como validar)… pode levar até 1 min</span></div>');
  try{
    const md=await invoke('ai_daily_report',{ text: dailyReportFacts(), date: iso });
    lastDailyMd=md; lastDailyDate=iso;
    dailyOut(`<div class="prbox" style="margin:6px 0 14px"><div class="mdview" style="font-size:13px">${mdToHtml(md)}</div><div class="prrow" style="margin-top:10px;gap:8px;display:flex"><button class="btn sm" id="dailyCopy2">copiar</button><button class="btn sm" id="dailySaveMd">${ic('save')}salvar .md</button><button class="btn primary sm" id="dailyPdf">${ic('doc')}gerar PDF</button><span class="grow" style="flex:1"></span></div><div class="dim" id="dailyDocMsg" style="font-size:11px;margin-top:6px"></div></div>`);
    $id('dailyCopy2').onclick=function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; };
    $id('dailySaveMd').onclick=async function(){ this.disabled=true; try{ const p=await invoke('save_doc',{ name:`relatorio-${iso}.md`, content:md }); this.textContent='salvo ✓'; const m=$id('dailyDocMsg'); if(m) m.textContent='DOC salvo em '+p; }catch(e){ const m=$id('dailyDocMsg'); if(m) m.textContent='Falhou salvar: '+(e&&e.message||e); this.disabled=false; } };
    $id('dailyPdf').onclick=dailyGenPdf;
  }catch(e){ dailyOut('<div class="imhint" style="border-left:2px solid var(--crit)">Falhou o relatório: '+esc(String(e&&e.message||e))+'</div>'); }
  btn.disabled=false; btn.innerHTML=o;
}
async function dailyGenPdf(){
  if(!lastDailyMd) return;
  const b=$id('dailyPdf'); b.disabled=true; const o=b.textContent; b.textContent='gerando PDF…';
  const m=$id('dailyDocMsg');
  try{
    const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(lastDailyMd, lastDailyDate), name:`relatorio-${lastDailyDate}` });
    b.textContent='PDF aberto ✓'; if(m) m.textContent='PDF em '+p;
  }catch(e){ if(m) m.textContent='Falhou o PDF: '+(e&&e.message||e); b.textContent=o; }
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
function setRailCollapsed(v){
  document.querySelector('.app').classList.toggle('railcol', !!v);
  document.documentElement.style.setProperty('--rail-w', v?'0px':'250px');
  lsSet('railCollapsed', v?'1':'0');
  const b=$id('railToggle'); if(b) b.setAttribute('aria-pressed', v?'true':'false');
  requestAnimationFrame(syncChromeH); setTimeout(syncChromeH, 320); // o topo muda de altura ao recolher (com transição) — a view-aba desce junto
}
$id('railToggle').onclick=()=>setRailCollapsed(!railIsCol());
{ const m=$id('railToggleMain'); if(m) m.onclick=()=>setRailCollapsed(false); } // botão de expandir (aparece só recolhido)
setRailCollapsed(lsGet('railCollapsed')==='1');
