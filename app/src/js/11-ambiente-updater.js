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
$id('envClose').onclick=()=>{ $id('envOverlay').style.display='none'; };
$id('envRecheck').onclick=async()=>{ envChecks=null; renderEnv(); await runEnvCheck(); renderEnv(); };
$id('envOverlay').addEventListener('click',e=>{ if(e.target.id==='envOverlay') $id('envOverlay').style.display='none'; });
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
let updInfo=null;
async function checkUpdate(){
  try{
    if(!SB.sess()) return;                       // canal é autenticado
    if(await invoke('is_dev_install')) return;   // instalação dev não se auto-atualiza
    const r=await fetch(SB.url()+'/storage/v1/object/releases/latest.json', { headers:{ apikey:SB.key(), Authorization:'Bearer '+SB.sess().access_token }, cache:'no-store' });
    if(!r.ok) return;
    const j=await r.json();
    const mine=Number(await invoke('build_info'))||0;
    if(j.buildMs && mine && j.buildMs > mine + 60000){
      updInfo=j;
      const b=$id('updBtn');
      b.style.display=''; b.innerHTML=ic('upload')+'atualizar'+(j.version?(' · '+esc(j.version)):'');
    }
  }catch(_){ }
}
$id('updBtn').onclick=async function(){
  if(!updInfo) return;
  if(!confirm('Atualizar o Constellation agora?\n\n'+(updInfo.notes||'Versão nova disponível.')+'\n\nO app baixa, troca e reabre sozinho (~10s). Tarefas rodando continuam — os agentes são processos separados.')) return;
  this.disabled=true; this.textContent='baixando…';
  try{
    const sig=await sbFetch('/storage/v1/object/sign/releases/'+(updInfo.file||'Constellation-portable.zip'), { method:'POST', body: JSON.stringify({ expiresIn: 600 }) });
    this.textContent='instalando…';
    await invoke('apply_update',{ url: SB.url()+'/storage/v1'+(sig.signedURL||sig.signedUrl) });
    this.textContent='reabrindo…';
  }catch(e){ alert('Atualização falhou:\n'+(e.message||e)+'\n\nBaixe o zip novo manualmente.'); this.disabled=false; this.innerHTML=ic('upload')+'atualizar'; }
};
setTimeout(checkUpdate, 5000);
setInterval(checkUpdate, 6*3600e3);
