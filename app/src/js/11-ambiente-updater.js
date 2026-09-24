// Constellation — 11-ambiente-updater
// ---------- preflight de ambiente ----------
let envChecks=null;
async function runEnvCheck(){
  try{ envChecks=await invoke('env_check'); }catch(e){ envChecks=[{name:'Verificação', ok:false, detail:String(e), fix:''}]; }
  const bad=envChecks.some(c=>!c.ok);
  const dot=$id('envDot'); if(dot) dot.style.display=bad?'block':'none';
  return bad;
}
function renderEnv(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const el=$id('envBody'); if(!el) return;
  if(!envChecks){ el.innerHTML='<div class="appscreen">'+cosmosHtml('verificando o ambiente…')+'</div>'; return; }
  const okN=envChecks.filter(c=>c.ok).length, tot=envChecks.length, bad=tot-okN;
  const banner = bad
    ? `<div class="as-banner warn"><span class="bd" style="background:var(--warn)"></span><span style="font:600 15px 'Instrument Sans',sans-serif">${bad} pendência${bad>1?'s':''} — resolva pra as tarefas rodarem</span><span class="as-mono" style="font-size:12px;color:rgba(255,255,255,.4)">${okN} de ${tot} ok</span></div>`
    : `<div class="as-banner ok"><span class="bd" style="background:var(--accent)"></span><span style="font:600 15px 'Instrument Sans',sans-serif">Tudo pronto — as tarefas rodam</span><span class="as-mono" style="font-size:12px;color:rgba(255,255,255,.4)">${okN} de ${tot} checagens ok</span></div>`;
  const cards=envChecks.map(c=>`<div class="as-card" style="display:flex;gap:13px;align-items:flex-start">
    <span class="as-chk" style="background:${c.ok?'var(--accent)':'var(--warn)'}">${c.ok?'✓':'!'}</span>
    <div style="min-width:0;flex:1">
      <div style="font:600 14.5px 'Instrument Sans',sans-serif">${esc(c.name)}</div>
      <div style="margin-top:6px;font:400 11.5px/1.5 'JetBrains Mono',monospace;color:rgba(255,255,255,.4);word-break:break-all">${esc(c.detail||'')}</div>
      ${c.fix?`<div style="display:flex;gap:8px;align-items:center;margin-top:9px"><code class="as-mono" style="font-size:11.5px;background:#141817;border:1px solid rgba(255,255,255,.1);padding:5px 9px;border-radius:6px;color:#eaf2ee">${esc(c.fix)}</code><button class="as-btn" style="padding:5px 10px;font-size:11.5px" data-envfix="${escA(c.fix)}">copiar</button></div>`:''}
    </div></div>`).join('');
  el.innerHTML=`<div class="appscreen">
    <div class="as-head"><div><h1 class="as-h1">Ambiente</h1><p class="as-sub">O que as tarefas precisam pra rodar nesta máquina.</p></div>
      <div class="as-actions"><span class="as-note">última checagem: agora</span><button class="as-btn" id="envRecheck2">verificar de novo</button></div></div>
    ${banner}
    <div class="as-grid" style="grid-template-columns:repeat(auto-fill,minmax(400px,1fr))">${cards}</div>
  </div>`;
  el.querySelectorAll('[data-envfix]').forEach(b=>{ b.onclick=()=>{ navigator.clipboard.writeText(b.dataset.envfix); b.textContent='copiado ✓'; }; });
  { const b=el.querySelector('#envRecheck2'); if(b) b.onclick=async()=>{ envChecks=null; renderEnv(); await runEnvCheck(); renderEnv(); }; }
}
async function openEnv(){ $id('envOverlay').style.display='flex'; renderEnv(); await runEnvCheck(); renderEnv(); }
$id('envBtn').onclick=openEnv;
$id('envClose').onclick=()=>{ ovHide('envOverlay'); };
$id('envRecheck').onclick=async()=>{ envChecks=null; renderEnv(); await runEnvCheck(); renderEnv(); };
$id('envOverlay').addEventListener('click',e=>{ if(e.target.id==='envOverlay') ovHide('envOverlay'); });
// boot: valida em background; problema → abre a tela sozinho (1x por sessão)
setTimeout(async()=>{ if(await runEnvCheck() && lsGet('onboarded')) openEnv(); }, 2500);

// prompt() do WebView do Tauri é mudo — modal próprio, promise-based
let txResolve=null;
function askText(title, placeholder, initial){
  return new Promise(res=>{
    txResolve=res;
    $id('txTitle').textContent=title;
    const i=$id('txInput'); i.placeholder=placeholder||''; i.value=initial||'';
    $id('txOverlay').style.display='flex';
    setTimeout(()=>i.focus(),50);
  });
}
function txDone(v){ $id('txOverlay').style.display='none'; if(txResolve){ txResolve(v); txResolve=null; } }
$id('txOk').onclick=()=>txDone($id('txInput').value.trim()||null);
$id('txCancel').onclick=()=>txDone(null);
$id('txClose').onclick=()=>txDone(null);
$id('txInput').addEventListener('keydown',e=>{ if(e.key==='Enter') txDone(e.target.value.trim()||null); if(e.key==='Escape') txDone(null); });

// ---------- updater "tipo Claude": checa o canal de releases, badge, aplica ----------
// Estado visível da última checagem — a tela de Configurações mostra e tem o
// botão "verificar agora" (antes a checagem era muda: falhou, só de novo em 6h).
let updInfo=null;
let updLast={ at:0, ok:false, msg:'', dev:false, mine:0 };
async function checkUpdate(manual){
  updLast.at=Date.now();
  try{
    if(!SB.sess()){ updLast.ok=false; updLast.msg='sem sessão — entre na conta pra receber atualizações'; return updLast; }
    if(await invoke('is_dev_install')){ updLast.ok=true; updLast.dev=true; updLast.msg='instalação de desenvolvimento — não se auto-atualiza (use scripts/deploy-local.sh)'; return updLast; }
    // sbFetch renova o token expirado sozinho (a checagem do boot caía no 401 e ficava muda por 6h)
    const j=await sbFetch('/storage/v1/object/releases/latest.json', { headers:{ 'Cache-Control':'no-store' } });
    const mine=Number(await invoke('build_info'))||0;
    updLast.mine=mine;
    if(j && j.buildMs && mine && j.buildMs > mine + 60000){
      updInfo=j;
      const b=$id('updBtn');
      b.style.display=''; b.innerHTML=ic('upload')+'atualizar'+(j.version?(' · '+esc(j.version)):'');
      updLast.ok=true; updLast.msg='versão nova disponível'+(j.version?' · '+j.version:'');
    }else{
      updInfo=null; $id('updBtn').style.display='none';
      updLast.ok=true; updLast.msg='você está na versão mais recente'+(j&&j.version?' (canal: '+j.version+')':'');
    }
  }catch(e){ updLast.ok=false; updLast.msg='não deu pra checar: '+(e&&e.message||e); }
  if(manual && typeof updRenderCfg==='function') updRenderCfg();
  return updLast;
}
async function applyUpdate(btn){
  if(!updInfo) return;
  if(!await askYes('Atualizar o Constellation agora?\n\n'+(updInfo.notes||'Versão nova disponível.')+'\n\nO app baixa, troca e reabre sozinho (~10s). Tarefas rodando continuam — os agentes são processos separados.')) return;
  btn.disabled=true; btn.textContent='baixando…';
  try{
    const sig=await sbFetch('/storage/v1/object/sign/releases/'+(updInfo.file||'Constellation-portable.zip'), { method:'POST', body: JSON.stringify({ expiresIn: 600 }) });
    btn.textContent='instalando…';
    await invoke('apply_update',{ url: SB.url()+'/storage/v1'+(sig.signedURL||sig.signedUrl) });
    btn.textContent='reabrindo…';
  }catch(e){ alert('Atualização falhou:\n'+(e.message||e)+'\n\nBaixe o zip novo manualmente.'); btn.disabled=false; btn.innerHTML=ic('upload')+'atualizar'; }
}
$id('updBtn').onclick=function(){ applyUpdate(this); };
// boot: tenta aos 5s e, enquanto não conseguir uma checagem válida (sessão ainda
// carregando, rede fora), insiste a cada 60s por até 15 min; depois, de 6 em 6h
// e sempre que a janela volta ao foco com a última checagem velha (>30 min).
setTimeout(async()=>{
  await checkUpdate();
  let tries=0;
  const t=setInterval(async()=>{ if(updLast.ok || ++tries>15){ clearInterval(t); return; } await checkUpdate(); }, 60e3);
}, 5000);
setInterval(checkUpdate, 6*3600e3);
window.addEventListener('focus', ()=>{ if(Date.now()-updLast.at > 30*60e3) checkUpdate(); });
// bloco "Versão" da tela de Configurações
function updRenderCfg(){
  const h=$id('updHost'); if(!h) return;
  const fmt=ms=>{ const d=new Date(ms); return isNaN(d)?'':d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); };
  const ago=updLast.at?Math.round((Date.now()-updLast.at)/60e3):null;
  const color= !updLast.at?'var(--text-dim)': updLast.ok?(updInfo?'var(--accent)':'var(--text)'):'var(--warn)';
  h.innerHTML=`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="mono dim" style="font-size:11.5px">build ${updLast.mine?esc(fmt(updLast.mine)):'—'}</span>
      <span style="font-size:12.5px;color:${color}">${updLast.at?esc(updLast.msg):'ainda não verificou'}</span>
      <span class="dim" style="font-size:11px">${ago!=null?(ago<1?'agora':'há '+ago+' min'):''}</span>
      <span style="flex:1"></span>
      ${updInfo?`<button class="btn sm primary" id="updApplyCfg">${ic('upload')}atualizar${updInfo.version?' · '+esc(updInfo.version):''}</button>`:''}
      <button class="btn sm" id="updCheckCfg"${updLast.dev?' disabled':''}>${ic('pulse')}verificar agora</button>
    </div>`;
  bindClick('updCheckCfg', async()=>{ const b=$id('updCheckCfg'); if(b){ b.disabled=true; b.textContent='verificando…'; } await checkUpdate(true); });
  bindClick('updApplyCfg', function(){ applyUpdate(this); });
}

// ---------- contas do GitHub (gh auth): listar, trocar, adicionar ----------
let ghAccs=null, ghLogin=null, ghLoginT=null, ghMsg='';
async function ghMount(){
  const h=$id('ghHost'); if(!h) return;
  h.innerHTML='<div class="dim" style="font-size:12px">lendo contas do gh…</div>';
  try{ ghAccs=await invoke('gh_accounts'); }catch(e){ ghAccs=[]; ghMsg=String(e&&e.message||e); }
  ghRender();
}
function ghRender(){
  const h=$id('ghHost'); if(!h) return;
  const rows=(ghAccs||[]).map(a=>`<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid ${a.active?'color-mix(in srgb,var(--accent) 45%,transparent)':'var(--border)'};border-radius:10px;background:${a.active?'color-mix(in srgb,var(--accent) 6%,transparent)':'var(--surface-2)'}">
      <span style="width:8px;height:8px;border-radius:50%;background:${a.active?'var(--accent)':'rgba(255,255,255,.2)'}"></span>
      <b style="font-size:13px">${esc(a.user)}</b><span class="dim mono" style="font-size:11px">${a.active?'ativa · PRs e push usam esta':'git via '+esc(a.protocol)}</span>
      <span style="flex:1"></span>${a.active?'':`<button class="btn sm" data-ghuse="${escA(a.user)}">usar esta conta</button>`}
    </div>`).join('');
  const login = ghLogin ? (ghLogin.done
      ? `<div style="font-size:12.5px;color:${ghLogin.ok?'var(--accent)':'var(--warn)'}">${ghLogin.ok?'✓ conta adicionada e ativa':'não concluiu: '+esc((ghLogin.log||'').trim().split('\n').slice(-2).join(' '))}</div>`
      : `<div class="as-card" style="padding:12px 14px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:12.5px">1) copie o código · 2) autorize no github.com (abre sozinho) · 3) volte aqui — o app reconhece na hora</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><code class="mono" style="font-size:18px;letter-spacing:.12em;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:#141817">${esc(ghLogin.code)}</code><button class="btn sm" id="ghCopy">copiar</button><button class="btn sm" id="ghOpen">abrir github.com/login/device</button><span class="dim" style="font-size:12px">esperando autorização…</span></div>
        </div>`) : '';
  h.innerHTML=`<div style="display:flex;flex-direction:column;gap:8px">${rows||'<div class="dim" style="font-size:12.5px">nenhuma conta logada no gh.</div>'}
    ${ghMsg?`<div style="font-size:12px;color:var(--warn)">${esc(ghMsg)}</div>`:''}${login}
    <div style="display:flex;gap:8px;margin-top:2px"><button class="btn sm" id="ghAdd"${ghLogin&&!ghLogin.done?' disabled':''}>+ entrar com outra conta</button><button class="btn sm" id="ghRefresh">atualizar</button></div>
    <div class="dim" style="font-size:11.5px">Cada conta fica guardada no gh; trocar a ativa muda quem abre PRs e faz push (git usa a credencial do gh). Repositórios de organização com SSO podem pedir <code>gh auth refresh -s repo</code> uma vez.</div></div>`;
  h.querySelectorAll('[data-ghuse]').forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent='trocando…'; ghMsg=''; try{ await invoke('gh_switch_account',{ user:b.dataset.ghuse }); envChecks=null; runEnvCheck(); }catch(e){ ghMsg='Falhou trocar: '+(e&&e.message||e); } await ghMount(); });
  bindClick('ghRefresh', ghMount);
  bindClick('ghAdd', async()=>{ ghMsg=''; try{ const r=await invoke('gh_login_start'); ghLogin={ code:r.code, url:r.url, done:false, ok:false, log:'' }; try{ await navigator.clipboard.writeText(r.code); }catch(_){ } try{ await invoke('open_url',{ url:r.url }); }catch(_){ } ghRender(); ghPoll(); }catch(e){ ghMsg='Falhou iniciar o login: '+(e&&e.message||e); ghRender(); } });
  bindClick('ghCopy', ()=>{ navigator.clipboard.writeText(ghLogin.code); const b=$id('ghCopy'); if(b) b.textContent='copiado ✓'; });
  bindClick('ghOpen', ()=>invoke('open_url',{ url:ghLogin.url }).catch(()=>{}));
}
function ghPoll(){
  if(ghLoginT) clearInterval(ghLoginT);
  ghLoginT=setInterval(async()=>{
    if(!ghLogin||ghLogin.done){ clearInterval(ghLoginT); ghLoginT=null; return; }
    try{ const st=await invoke('gh_login_status'); if(st.done){ ghLogin.done=true; ghLogin.ok=st.ok; ghLogin.log=st.log; clearInterval(ghLoginT); ghLoginT=null; envChecks=null; runEnvCheck(); await ghMount(); } }catch(_){ }
  }, 2000);
}
