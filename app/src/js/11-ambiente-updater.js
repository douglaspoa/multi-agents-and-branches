// Starfork — 11-ambiente-updater
// ---------- preflight de ambiente ----------
let envChecks=null, envCheckedAt=0, envChecking=false;
// @env-puro-inicio — classificação das checagens (testado em app/tests/onboarding-conta.test.mjs)
// O Rust manda nomes fixos (lib.rs env_check). Nem tudo é obrigatório: sem gh o app roda (só não publica no
// GitHub/abre PR) e o túnel do preview é "(opcional)" no próprio nome. Antes QUALQUER item faltando contava
// como "pendência — resolva pra as tarefas rodarem", acendia o ponto do Mais e abria a aba Ambiente a cada boot.
// o Rust manda `kind` (req/rec/opt); o regex pelo nome fica só pra versão velha do backend/mock
function envKind(c){ const k=c&&c.kind; if(k==='req'||k==='rec'||k==='opt') return k;
  const n=String((c&&c.name)||''); if(/opcional/i.test(n)) return 'opt'; if(/github cli|\bgh\b/i.test(n)) return 'rec'; return 'req'; }
// selo ÚNICO (aba Ambiente e tour de boas-vindas)
const ENV_KIND_TAG={ req:'', rec:'recomendado', opt:'opcional' };
// pra que serve cada peça, em linguagem de gente (quem não programa não sabe o que é "gh")
function envWhat(c){ const n=String((c&&c.name)||'');
  if(/node/i.test(n)) return 'Roda o motor que coordena os agentes.';
  if(/motor/i.test(n)) return 'Vem dentro do app — é quem liga os agentes às tarefas.';
  if(/^git\b/i.test(n)) return 'Guarda o histórico e dá a cada tarefa a sua cópia isolada do projeto.';
  if(/claude/i.test(n)) return 'A IA que faz o trabalho. Precisa estar instalada e com login feito.';
  if(/github cli|\bgh\b/i.test(n)) return 'Só pra publicar no GitHub e abrir PRs. Dá pra começar sem.';
  if(/t[úu]nel|preview/i.test(n)) return 'Abre a prévia do app no celular. O resto funciona sem.';
  return ''; }
function envSummary(list){
  const a=Array.isArray(list)?list:[]; const bad=a.filter(c=>!c.ok);
  return { tot:a.length, okN:a.length-bad.length, reqBad:bad.filter(c=>envKind(c)==='req').length, optBad:bad.filter(c=>envKind(c)!=='req').length };
}
// @env-puro-fim
// uma checagem por vez: quem chama durante uma em andamento recebe A MESMA promise (a tela "pronto" e o tour
// esperam por ela em vez de ficarem presos em "verificar")
let _envCheckP=null;
function runEnvCheck(){ if(!_envCheckP) _envCheckP=envCheckOnce().finally(()=>{ _envCheckP=null; }); return _envCheckP; }
async function envCheckOnce(){
  envChecking=true;
  // sempre LISTA: resposta fora do formato (versão velha/mock) virava "envChecks.some is not a function"
  try{ const r=await invoke('env_check'); envChecks=Array.isArray(r)?r:[{name:'Verificação', ok:false, detail:'resposta inesperada da verificação do ambiente', fix:''}]; }
  catch(e){ envChecks=[{name:'Verificação', ok:false, detail:String(e), fix:''}]; }
  finally{ envChecking=false; }
  envCheckedAt=Date.now();
  // só o que IMPEDE a tarefa de rodar acende o ponto e abre a tela sozinho (gh/túnel faltando, não)
  const bad=envSummary(envChecks).reqBad>0;
  const dot=$id('envDot'); if(dot) dot.style.display=bad?'block':'none';
  return bad;
}
function renderEnv(){
  if(typeof ndInjectFonts==='function') ndInjectFonts();
  const el=$id('envBody'); if(!el) return;
  if(!envChecks){ ldPaint(el, '<div class="appscreen">'+skeletonHtml('lista',{ head:true, n:6, label:'verificando o ambiente' })+'</div>'); return; }
  const S=envSummary(envChecks), okN=S.okN, tot=S.tot;
  const banner = S.reqBad
    ? `<div class="as-banner warn"><span class="bd" style="background:var(--warn)"></span><span style="font:600 15px var(--display)">${S.reqBad} pendência${S.reqBad>1?'s':''} — resolva pra as tarefas rodarem</span><span class="as-mono" style="font-size:12px;color:var(--text-3)">${okN} de ${tot} ok</span></div>`
    : `<div class="as-banner ok"><span class="bd" style="background:var(--accent)"></span><span style="font:600 15px var(--display)">Tudo pronto — as tarefas rodam</span><span class="as-mono" style="font-size:12px;color:var(--text-3)">${S.optBad?`${S.optBad} opciona${S.optBad>1?'is':'l'} faltando · `:''}${okN} de ${tot} ok</span></div>`;
  const cards=envChecks.map(c=>{ const k=envKind(c), soft=!c.ok&&k!=='req', what=envWhat(c);
    return `<div class="as-card envcard" style="display:flex;gap:13px;align-items:flex-start">
    <span class="as-chk" style="background:${c.ok?'var(--accent)':soft?'var(--text-3)':'var(--warn)'}">${c.ok?'✓':soft?'–':'!'}</span>
    <div style="min-width:0;flex:1">
      <div style="font:600 14.5px var(--display);display:flex;gap:8px;align-items:center;flex-wrap:wrap">${esc(String(c.name||'').replace(/\s*\(opcional\)/i,''))}${ENV_KIND_TAG[k]?`<span class="envtag">${ENV_KIND_TAG[k]}</span>`:''}</div>
      ${what?`<div style="margin-top:4px;font-size:12.5px;color:var(--text-2)">${esc(what)}</div>`:''}
      <div style="margin-top:6px;font:400 11.5px/1.5 var(--code);color:var(--text-3);word-break:break-all">${esc(c.detail||'')}</div>
      ${c.fix?`<div class="envfix"><span class="dim" style="font-size:11.5px">${/reinstale/i.test(c.fix)?'como resolver:':'rode no Terminal:'}</span><code class="as-mono">${esc(c.fix)}</code>${/reinstale/i.test(c.fix)?'':`<button class="as-btn" style="padding:5px 10px;font-size:11.5px" data-envfix="${escA(c.fix)}">copiar</button>`}</div>`:''}
    </div></div>`; }).join('');
  el.innerHTML=`<div class="appscreen">
    <div class="as-head"><div><h1 class="as-h1">Ambiente</h1><p class="as-sub">O que as tarefas precisam pra rodar nesta máquina.</p></div>
      <div class="as-actions"><span class="as-note" title="${envCheckedAt?escA(new Date(envCheckedAt).toLocaleString('pt-BR')):''}">${envChecking?'verificando de novo…':'última checagem: '+envAgo()}</span><button class="as-btn" id="envRecheck2">verificar de novo</button></div></div>
    ${banner}
    <div class="as-grid" style="grid-template-columns:repeat(auto-fill,minmax(min(400px,100%),1fr))">${cards}</div>
  </div>`;
  el.querySelectorAll('[data-envfix]').forEach(b=>{ b.onclick=()=>envCopy(b); });
  { const b=el.querySelector('#envRecheck2'); if(b) b.onclick=async()=>{ envChecks=null; renderEnv(); await tabBusy('env', runEnvCheck(), { label:'verificando o ambiente' }); renderEnv(); }; }
}
// copiar o comando: a área de transferência pode recusar (janela sem foco) — antes falhava calado e o botão dizia "copiado"
async function envCopy(b){ try{ await navigator.clipboard.writeText(b.dataset.envfix); b.textContent='copiado ✓'; }catch(_){ b.textContent='selecione e copie'; const c=b.parentElement&&b.parentElement.querySelector('code'); if(c){ try{ const r=document.createRange(); r.selectNodeContents(c); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); }catch(__){ } } } }
// quanto tempo faz a última checagem ("agora" só quando foi mesmo agora — antes mostrava "agora" com resultado velho)
function envAgo(){ if(!envCheckedAt) return '—'; const s=Math.round((Date.now()-envCheckedAt)/1000); if(s<60) return 'agora'; const m=Math.round(s/60); if(m<60) return 'há '+m+' min'; const h=Math.round(m/60); return h<24?'há '+h+' h':new Date(envCheckedAt).toLocaleDateString('pt-BR'); }
async function openEnv(){ $id('envOverlay').style.display='flex'; const p=tabBusy('env', runEnvCheck(), { label:'verificando o ambiente' }); renderEnv(); await p; renderEnv(); }
$id('envBtn').onclick=openEnv;
$id('envClose').onclick=()=>{ ovHide('envOverlay'); };
$id('envRecheck').onclick=async()=>{ envChecks=null; renderEnv(); await tabBusy('env', runEnvCheck(), { label:'verificando o ambiente' }); renderEnv(); };
$id('envOverlay').addEventListener('click',e=>{ if(e.target.id==='envOverlay') ovHide('envOverlay'); });
// boot: valida em background; problema → abre a tela sozinho (1x por sessão)
setTimeout(async()=>{ if(await runEnvCheck() && lsGet('onboarded')){ if(window.openTab) window.openTab('env'); else openEnv(); } }, 2500);

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
let updToastFor=0;
// A checagem em si; quem chama é o checkUpdate, que SEMPRE redesenha o bloco da tela ao final.
// (antes: sem sessão, instalação de dev e Windows/Linux saíam com return antes do redesenho →
// o "verificar agora" das Configurações ficava preso em "verificando…" e desabilitado)
async function checkUpdate(manual){
  try{ return await updCheckOnce(manual); }
  finally{ if(manual && typeof updRenderCfg==='function') updRenderCfg(); }
}
async function updCheckOnce(manual){
  updLast.at=Date.now(); updLast.dev=false;
  try{
    if(!SB.sess()){ updLast.ok=false; updLast.msg='sem sessão — entre na conta pra receber atualizações'; return updLast; }
    if(await invoke('is_dev_install')){ updLast.ok=true; updLast.dev=true; updLast.msg='instalação de desenvolvimento — não se auto-atualiza (use scripts/deploy-local.sh)'; return updLast; }
    // E8 (bug #16): o canal só publica o .app do Mac (zip + ditto) — no Windows/Linux o "atualizar" falhava
    // com "No such file or directory". Lá o botão não aparece e a tela diz onde baixar.
    if(osKind()!=='mac'){ updInfo=null; { const b=$id('updBtn'); if(b) b.style.display='none'; } updLast.ok=true; updLast.msg='atualização automática só no Mac por enquanto — baixe a versão nova em starfork.com.br'; return updLast; }
    // sbFetch renova o token expirado sozinho (a checagem do boot caía no 401 e ficava muda por 6h)
    const j=await sbFetch('/storage/v1/object/releases/latest.json', { headers:{ 'Cache-Control':'no-store' } });
    const mine=Number(await invoke('build_info'))||0;
    updLast.mine=mine;
    if(j && j.buildMs && mine && j.buildMs > mine + 60000){
      updInfo=j;
      const b=$id('updBtn');
      if(b){ b.style.display=''; b.innerHTML=ic('upload')+'atualizar'+(j.version?(' · '+esc(j.version)):''); }
      updLast.ok=true; updLast.msg='versão nova disponível'+(j.version?' · '+j.version:'');
      // aviso ativo UMA vez por versão (o botão do topo fica até atualizar)
      if(updToastFor!==j.buildMs){
        updToastFor=j.buildMs;
        toast('Versão nova do Starfork'+(j.version?' ('+j.version+')':'')+(j.notes?' — '+j.notes:'')+'. Atualiza em ~10s; tarefas rodando continuam.', 'info',
          { label:'atualizar agora', fn:()=>applyUpdate($id('updBtn')||$id('updApplyCfg'), true) }, { label:'depois', fn:()=>{} });
      }
    }else{
      updInfo=null; { const b=$id('updBtn'); if(b) b.style.display='none'; }
      updLast.ok=true; updLast.msg='você está na versão mais recente'+(j&&j.version?' (canal: '+j.version+')':'');
    }
  }catch(e){ updLast.ok=false; updLast.msg=updErrMsg(e); }
  return updLast;
}
// erro da checagem em pt-BR (antes: "não deu pra checar: Failed to fetch" / "erro 400")
function updErrMsg(e){
  const raw=String((e&&e.message)||e||'');
  if(/\b(400|404)\b|not.?found|object not found/i.test(raw)) return 'o canal de versões não respondeu agora — tente de novo mais tarde';
  const h=(typeof humanErr==='function')?humanErr(e,'não deu pra checar'):{ msg:'não deu pra checar: '+raw };
  return String(h.msg).replace(/^N/,'n');
}
async function applyUpdate(btn, confirmed){
  if(!updInfo || osKind()!=='mac') return;
  if(!confirmed && !await askYes('Atualizar o Starfork agora?\n\n'+(updInfo.notes||'Versão nova disponível.')+'\n\nO app baixa, troca e reabre sozinho (~10s). Tarefas rodando continuam — os agentes são processos separados.')) return;
  // progresso no botão quando ele está na tela; senão (veio do toast, botão fora da barra) num toast de status
  const onScreen=!!(btn && btn.isConnected);
  const say=t=>{ if(onScreen) btn.textContent=t; else toast('Atualização: '+t,'info'); };
  if(onScreen) btn.disabled=true; say('baixando…');
  try{
    const sig=await sbFetch('/storage/v1/object/sign/releases/'+(updInfo.file||'Starfork-portable.zip'), { method:'POST', body: JSON.stringify({ expiresIn: 600 }) });
    say('instalando…');
    await invoke('apply_update',{ url: SB.url()+'/storage/v1'+(sig.signedURL||sig.signedUrl) });
    say('reabrindo…');
  }catch(e){ showErr(e, 'Atualização falhou (dá pra baixar a versão nova manualmente em starfork.com.br)'); if(onScreen){ btn.disabled=false; btn.innerHTML=ic('upload')+'atualizar'; } }
}
{ const b=$id('updBtn'); if(b) b.onclick=function(){ applyUpdate(this); }; }
// boot: tenta aos 5s e, enquanto não conseguir uma checagem válida (sessão ainda
// carregando, rede fora), insiste a cada 60s por até 15 min; depois, de 2 em 2 min.
setTimeout(async()=>{
  await checkUpdate();
  let tries=0;
  const t=setInterval(async()=>{ if(updLast.ok || ++tries>15){ clearInterval(t); return; } await checkUpdate(); }, 60e3);
}, 5000);
// quase instantâneo: o latest.json tem ~300 bytes — checar a cada 2 min (e ao voltar o
// foco) faz a versão publicada chegar em todo mundo em minutos, não em até 6h.
const UPD_EVERY=2*60e3;
setInterval(()=>{ if(!document.hidden) checkUpdate(); }, UPD_EVERY);
window.addEventListener('focus', ()=>{ if(Date.now()-updLast.at > UPD_EVERY) checkUpdate(); });
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
