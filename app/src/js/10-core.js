// Constellation — 10-core
// DIAGNÓSTICO de travamento: comandos em voo, comando > 3s e thread da página bloqueada > 1,5s vão pro
// /tmp/constellation-web.log com o que estava rodando — a causa fica registrada em vez de suposta
const __inflight=new Map(); let __invSeq=0;
const __diagLog=(line)=>{ try{ window.__TAURI__.core.invoke('web_log',{ line }); }catch(_){ } };
const __inflightTx=()=>[...__inflight.values()].map(x=>x.cmd+'('+Math.round((Date.now()-x.t0)/100)/10+'s)').join(', ')||'nenhum';
const _invokeRaw = (cmd, args) => {
  if(cmd==='web_log') return window.__TAURI__.core.invoke(cmd, args);
  const id=++__invSeq, t0=Date.now(); __inflight.set(id,{cmd,t0});
  const done=()=>{ __inflight.delete(id); const ms=Date.now()-t0; if(ms>3000) __diagLog('[lento] '+cmd+' '+ms+'ms · em voo: '+__inflightTx()); };
  return window.__TAURI__.core.invoke(cmd, args).then(r=>{ done(); return r; }, e=>{ done(); throw e; });
};
{ let last=Date.now(); setInterval(()=>{ const now=Date.now(), lag=now-last-500; last=now;
    if(lag>1500) __diagLog('[lag] página bloqueada '+lag+'ms · em voo: '+__inflightTx()+' · aba: '+((typeof activeTab!=='undefined'&&activeTab)||'?')); }, 500); }
// Envelope de rastreabilidade: TODA falha de comando de backend (login, PR,
// planner, qualquer um) é registrada (52-erros → Supabase) SEM parar de propagar
// o erro pra quem chamou. web_log fica de fora (é o log local — evita ruído/recursão).
const invoke = (cmd, args) => _invokeRaw(cmd, args).catch((err) => {
  try { if (cmd !== "web_log" && window.logAppError) window.logAppError("invoke:" + cmd, err); } catch (_) {}
  throw err;
});
// Versão SEM registro na nuvem: pra tarefas em segundo plano que repetem sozinhas (observador de
// issues a cada 2 min etc.). Falha ali é esperada de vez em quando (rede, VPN) e vira ruído em app_errors.
const invokeQuiet = (cmd, args) => _invokeRaw(cmd, args);
// ícones SVG no estilo do app (linha, currentColor) — substituem emojis em botões/headers
const _ICONS={
  chat:'<path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.85-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" stroke-linejoin="round"/>',
  upload:'<path d="M8 10.6V3.2m0 0L5.3 5.9M8 3.2l2.7 2.7"/><path d="M3.4 12.6h9.2"/>',
  book:'<path d="M8 4.5C6.7 3.7 5 3.5 3.4 3.9v7.9c1.6-.4 3.3-.2 4.6.6m0-9c1.3-.8 3-1 4.6-.6v7.9c-1.6-.4-3.3-.2-4.6.6m0-8.9v8.9"/>',
  compass:'<circle cx="8" cy="8" r="5.7"/><path d="M10.7 5.3 8.7 8.7 5.3 10.7 7.3 7.3z" stroke-linejoin="round"/>',
  pulse:'<path d="M1.6 8h2.9l1.6-4.3 2.7 8.6L10.4 8h4"/>',
  folder:'<path d="M2 4.5c0-.4.3-.7.7-.7h3.1l1.3 1.5h6.2c.4 0 .7.3.7.7v5.8c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>',
  send:'<path d="M14 2 7.3 8.7M14 2l-4.4 12-2.3-5.3L2 6.4z" stroke-linejoin="round"/>',
  edit:'<path d="M11.3 2.6 13.4 4.7 6 12.1l-2.7.6.6-2.7z" stroke-linejoin="round"/>',
  eye:'<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.7"/>',
  spark:'<path d="M8 2.4l1 2.6 2.6 1-2.6 1L8 9.6 7 7l-2.6-1L7 5z" stroke-linejoin="round"/><path d="M12.4 9.4l.45 1.2 1.2.45-1.2.45-.45 1.2-.45-1.2-1.2-.45 1.2-.45z" stroke-linejoin="round"/>',
  doc:'<path d="M4.3 2.6h4.4L11.7 5.6v7.8H4.3z" stroke-linejoin="round"/><path d="M8.5 2.7v3.1h3.1"/>',
  save:'<path d="M3.2 2.6h7l2.6 2.6v7.2c0 .3-.2.4-.4.4H3.2c-.2 0-.4-.1-.4-.4V3c0-.3.2-.4.4-.4z" stroke-linejoin="round"/><path d="M5 2.6v3.2h4.6V2.6M5 12.8V9.2h6v3.6"/>',
  cloud:'<path d="M4.6 11.8a2.6 2.6 0 0 1 .3-5.18 3.4 3.4 0 0 1 6.6.7 2.3 2.3 0 0 1-.4 4.55z" stroke-linejoin="round"/>',
};
function ic(n,sz){ sz=sz||12; return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" style="width:${sz}px;height:${sz}px;vertical-align:-1.5px;margin-right:5px;flex:none">${_ICONS[n]||''}</svg>`; }
window.ic=ic; // pro bloco 1 (script separado) também usar
// Chamada de IA COM sessão retomada. Se o Claude não achar a sessão (projeto trocado no meio,
// sessão limpa, cwd diferente), refaz UMA vez sem sessão, com o histórico resumido dentro do
// prompt — a conversa continua e o usuário nunca vê "sessão expirou". `fn(prompt, sid)` faz o invoke.
// Devolve { ...resposta, recovered:true } quando teve que recomeçar (pra quem chama trocar o sid).
async function aiCallResumeSafe(fn, sid, prompt, history){
  try{ return await fn(prompt, sid||null); }
  catch(e){
    const msg=String(e&&e.message||e);
    if(!sid || !/No conversation found|sessão da conversa expirou|session.*not found/i.test(msg)) throw e;
    console.error('sessão perdida — recomeçando com histórico:', msg.slice(0,120));
    const hist=(history||[]).filter(m=>m&&(m.text||'')).slice(-14).map(m=>{ const who=(m.who||m.role||''); const tag=who==='you'||who==='user'?'USUÁRIO':who==='bot'||who==='assistant'?'VOCÊ':'SISTEMA'; return tag+': '+String(m.text).replace(/\n*\[ANEXOS\][\s\S]*?\[\/ANEXOS\]/g,'').slice(0,1500); }).join('\n\n');
    const p2=(hist?'[CONTEXTO — a sessão anterior desta conversa foi perdida; abaixo o histórico resumido pra você CONTINUAR de onde parou, sem recomeçar nem repetir o que já foi dito.]\n'+hist+'\n[/CONTEXTO]\n\n':'')+prompt;
    const r=await fn(p2, null);
    return Object.assign({}, r||{}, { recovered:true });
  }
}
// console.error e erros não tratados vão pro /tmp/constellation-web.log —
// bug silencioso em tick não existe mais.
setTimeout(()=>{ try{ invoke('web_log',{ line:'[boot] webview vivo · sess='+(!!localStorage.getItem('sb:sess'))+' · team='+(localStorage.getItem('sb:team')||'—') }); }catch(_){ } }, 3000);
{ const _err=console.error.bind(console);
  console.error=(...a)=>{ _err(...a); try{ invoke('web_log',{ line:'[err] '+a.map(x=>String(x&&x.message||x)).join(' ') }); }catch(_){ } };
  window.addEventListener('error', e=>{ try{ invoke('web_log',{ line:'[onerror] '+e.message+' @'+(e.filename||'')+':'+e.lineno }); }catch(_){ } });
  window.addEventListener('unhandledrejection', e=>{ try{ invoke('web_log',{ line:'[reject] '+String(e.reason&&e.reason.message||e.reason) }); }catch(_){ } });
}
const IC = {
  globe:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.7 1.5 2.6 3.4 2.6 5.6S9.7 12.1 8 13.6C6.3 12.1 5.4 10.2 5.4 8S6.3 3.9 8 2.4z" stroke-linejoin="round"/></svg>',
  brush:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M13.2 2.8c.6.6.6 1.5 0 2.1L8 10.1 5.9 8 11.1 2.8c.6-.6 1.5-.6 2.1 0z" stroke-linejoin="round"/><path d="M5.6 8.4c-1.2.3-2 1-2.3 2.3-.2 1-.1 1.9-1 2.5 1.3.6 3.4.5 4.4-.5.8-.8 1-1.7.9-2.5" stroke-linejoin="round"/></svg>',
  phone:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.4"/><path d="M7 12.4h2" stroke-linecap="round"/></svg>',
  q:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M2.6 7.4c0-2.4 2.15-4.2 4.9-4.2s4.9 1.8 4.9 4.2-2.15 4.2-4.9 4.2c-.5 0-1-.05-1.45-.16L3.4 12.7l.6-2.05C3.15 9.9 2.6 8.7 2.6 7.4z" stroke-linejoin="round"/><path d="M6.5 6.5c.05-.65.7-1.05 1.4-1.05.8 0 1.4.5 1.4 1.2 0 .95-1.25.9-1.35 1.95" stroke-linecap="round"/><circle cx="7.95" cy="10.1" r=".55" fill="currentColor" stroke="none"/></svg>',
  trash:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M3 4.4h10M6.4 4.4V3.2c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.2M4.3 4.4l.5 8.1c0 .5.4.9.9.9h4.6c.5 0 .9-.4.9-.9l.5-8.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cleft:'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7.5 2.5l-3.5 3.5 3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cright:'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  xs:'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" stroke-linecap="round"/></svg>',
  merge:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4.2" cy="4" r="1.5"/><circle cx="4.2" cy="12" r="1.5"/><circle cx="11.8" cy="8" r="1.5"/><path d="M4.2 5.5v5M5.7 5.4C6 8 8.2 8 10.3 8" stroke-linecap="round"/></svg>',
  check:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.4 8.4l3 3 6.2-6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ai:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M7 2.6l1 2.6 2.6 1-2.6 1L7 9.8 6 7.2 3.4 6.2 6 5.2z" stroke-linejoin="round"/><path d="M12 9.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" stroke-linejoin="round"/></svg>',
  doc:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M4 2.5h4.6L12 5.9v7.1c0 .3-.25.5-.5.5h-7c-.28 0-.5-.22-.5-.5v-10c0-.28.22-.5.5-.5z" stroke-linejoin="round"/><path d="M8.5 2.6V6h3.4M6 8.5h4M6 10.6h4" stroke-linecap="round"/></svg>',
  image:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2"/><circle cx="6" cy="6.6" r="1"/><path d="M3 11l3-2.6 2.4 2 2.3-1.8L13 11" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pencil:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10.5 3.2l2.3 2.3M3 11.4l7-7 2.3 2.3-7 7-2.8.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  extlink:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 3.5h3.5V7M12.2 3.8L7 9M7.5 3.5H4.2c-.4 0-.7.3-.7.7v7.6c0 .4.3.7.7.7h7.6c.4 0 .7-.3.7-.7V8.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  beaker:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.2 2.5h3.6M6.7 2.5v3.8L3.7 11.6a1 1 0 0 0 .9 1.5h6.8a1 1 0 0 0 .9-1.5L9.3 6.3V2.5" stroke-linejoin="round"/><path d="M5 9.5h6" stroke-linecap="round"/></svg>',
  camera:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="4.6" width="12" height="8.2" rx="1.4"/><path d="M5.6 4.6l1-1.6h2.8l1 1.6" stroke-linejoin="round"/><circle cx="8" cy="8.8" r="2.1"/></svg>',
  stack:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2.4l5.4 2.7L8 7.8 2.6 5.1z" stroke-linejoin="round"/><path d="M2.6 8l5.4 2.7L13.4 8M2.6 10.9l5.4 2.7 5.4-2.7" stroke-linejoin="round"/></svg>',
  pause:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4v8M10 4v8" stroke-linecap="round"/></svg>',
  checkc:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/><path d="M5.6 8.2l1.6 1.6 3.2-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3M12.7 2.4V5H10.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wrench:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10.8 2.6a3 3 0 0 0-3.9 3.7l-4.1 4.1a1.25 1.25 0 0 0 1.8 1.8l4.1-4.1a3 3 0 0 0 3.7-3.9l-1.9 1.9-1.5-.3-.3-1.5z" stroke-linejoin="round"/></svg>',
  search:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.2"/><path d="M10.4 10.4L14 14" stroke-linecap="round"/></svg>',
  bolt:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8.7 2L4 9h3l-.6 5L12 6.8H8.9z" stroke-linejoin="round"/></svg>',
  hand:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M5.2 8.2V4.6a1 1 0 0 1 2 0v3m0-.4V3.6a1 1 0 0 1 2 0V7.2m0-.2V4.7a1 1 0 0 1 2 0v4.5c0 2.1-1.6 3.9-4 3.9-1.6 0-2.6-.7-3.3-1.7L3 9.6a1 1 0 0 1 1.4-1.4z" stroke-linejoin="round"/></svg>',
  clip:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 3.5L5 8a2 2 0 0 0 2.8 2.8l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// helper: ícone + rótulo num botão (substitui os emojis por SVG da biblioteca)
async function openExternal(url){ try{ await invoke('open_url',{ url }); }catch(e){ alert('Não consegui abrir:\n'+url); } }
async function copyLink(url, btn){ try{ await navigator.clipboard.writeText(url); if(btn){ const o=btn.textContent; btn.textContent='copiado!'; setTimeout(()=>btn.textContent=o,1200);} }catch(e){ openExternal(url); } }

const STATUS_COLOR = { draft:"var(--muted)", "plan-review":"var(--warn)", running:"var(--good)", done:"var(--good)", thinking:"var(--info)", review:"var(--warn)", conflict:"var(--crit)", error:"var(--crit)", queued:"var(--muted)", paused:"var(--info)", aborted:"var(--muted)", cancelled:"var(--crit)" };
const GLYPH = { status:"◆", think:"…", read:"‹", edit:"±", write:"+", bash:"$", note:"»", claim:"⊞", collision:"⚠", error:"✖", done:"✔" };
const GCOLOR = { collision:"var(--crit)", error:"var(--crit)", claim:"var(--info)", done:"var(--good)", edit:"var(--good)", write:"var(--good)" };

let state = { repo:null, tasks:[], events:[], claims:[], diffs:[] };
let selected = null;
let connected = false;

function fmtTime(ms){ const d=new Date(ms); return d.toTimeString().slice(0,8); }
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;"); }

async function connect(repo){
  try{
    await invoke("set_repo", { repo });
    connected = true;
    await refresh();
  }catch(e){
    connected = false;
    $id("connTxt").textContent = String(e);
    $id("conn").classList.remove("live");
  }
}

// ---- pasta aberta SEM git: o app abre, mas branch/PR/worktree só depois de criar o repositório ----
function repoHasGit(){ return !state || !state.repo || state.git!==false; }
function gitUiSync(){
  const off=!repoHasGit();
  document.body.classList.toggle('nogit', off);
  const g=document.querySelector('#viewSeg button[data-v="graph"]'); if(g) g.style.display=off?'none':'';
  if(off && curView()==='graph'){ const f=document.querySelector('#viewSeg button[data-v="flow"]'); if(f) f.click(); }
}
// Antes de qualquer ação que precise de branch (nova demanda, orquestrador…): oferece criar o repo.
// Devolve true quando pode seguir.
async function gitGate(){
  if(repoHasGit()) return true;
  const name=(state.repo||'').split('/').filter(Boolean).slice(-1)[0]||'esta pasta';
  if(!await askYes(`"${name}" não tem repositório git.\n\nCada demanda roda numa branch própria, então o Constellation precisa de um repositório. Criar agora?\n\n(git init na branch main + .cardume/ no .gitignore + 1º commit com o conteúdo atual)`)) return false;
  try{ await invoke('git_init_repo'); lastSig=''; await refresh(); if(typeof loadProjects==='function') loadProjects(); return repoHasGit(); }
  catch(e){ alert('Não consegui criar o repositório:\n'+(e&&e.message||e)); return false; }
}
// etiqueta na barra lateral: "sem git · criar repositório"
function gitRailTag(){
  if(repoHasGit()) return '';
  return `<div class="nogitrow" title="esta pasta não tem repositório git — sem branch/PR até criar um"><span class="nogittag">sem git</span><button class="nogitbtn" onclick="gitGate()">criar repositório</button></div>`;
}
function curView(){ return (((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v || "flow"; }
// Assinatura barata do estado: se nada mudou, pulamos o render inteiro.
function snapSig(){
  const t=(state.tasks||[]).map(x=>x.id+":"+x.status+":"+x.stage+":"+(x.sortOrder??"")).join(",");
  const d=(state.diffs||[]).map(x=>x.taskId+":"+x.additions+":"+x.deletions).join(",");
  const lastEv = (state.events&&state.events.length) ? state.events[state.events.length-1].id : 0;
  const cost = (state.costs||[]).length+":"+(state.costs||[]).reduce((s,c)=>s+(c.usd||0),0).toFixed(4);
  return [state.repo||"", t, lastEv, (state.pending||[]).length,
          (state.reviews||[]).length, (state.claims||[]).length, d, cost,
          selected, (state.graph||[]).length, curView()].join("|");
}
let lastSig = "";
// ---------- notificações nativas (via plugin do Tauri → atribuídas ao app) ----------
let notifReady=false, notifOn=false, prevStatus={}, prevPr={}, prevPending=new Set();
function notifApi(){ return (window.__TAURI__ && (window.__TAURI__.notification)) || null; }
async function initNotifs(){
  const n=notifApi(); if(!n){ return; }
  try{ let ok = await n.isPermissionGranted(); if(!ok){ const p=await n.requestPermission(); ok = p==='granted'; } notifOn=!!ok; }
  catch(_){ notifOn=false; }
}
let lastNotif=null; // {id, ts} — última notificação disparada (pro roteamento do clique)
function pushNotif(title, body, taskId){
  if(!notifOn) return;
  if(taskId && !document.hasFocus()) lastNotif={ id:taskId, ts:Date.now() };
  // caminho nativo: atribuição correta (Constellation) — clicar abre o APP
  invoke('notify_native', { title, body: String(body||'').slice(0,180), taskId: taskId||null })
    .catch(()=>{ const n=notifApi(); if(n) try{ n.sendNotification({ title, body: String(body||'').slice(0,180) }); }catch(_){} });
}
function notifRoute(id){
  if(id==='view:team'){ const b=document.querySelector('#viewSeg button[data-v="team"]'); if(b) b.click(); return; }
  if(id && (state.tasks||[]).some(t=>t.id===id)){
    selected=id;
    const b=document.querySelector('#viewSeg button[data-v="flow"]'); if(b && !activeIs('flow')) b.click();
    render();
  }
}
// clique na notificação → o macOS ativa o app (atribuição) e nós roteamos:
// pelo evento nativo quando a lib entrega o clique, ou pelo GANHO DE FOCO logo
// após uma notificação (banner clicado ativa o app em segundos).
try{ window.__TAURI__.event.listen('notif-open', (ev)=>{ lastNotif=null; notifRoute(ev.payload||''); }); }catch(_){ }
window.addEventListener('focus', ()=>{
  if(lastNotif && Date.now()-lastNotif.ts<180000){ const id=lastNotif.id; lastNotif=null; notifRoute(id); }
});
// ⌘K — busca global (redesign): vai pra Central de execuções e foca a busca
window.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    const b=document.querySelector('#viewSeg button[data-v="flow"]'); if(b && !activeIs('flow')) b.click();
    setTimeout(()=>{ const s=$id('ffSearch'); if(s){ s.focus(); s.select(); } }, 60);
  }
});
function detectNotifs(snap){
  const tasks=snap.tasks||[]; const pend=snap.pending||[];
  if(notifReady){
    for(const t of tasks){
      const prev=prevStatus[t.id];
      if(prev!==undefined && prev!==t.status){
        // status mudou → commits/PR podem ter mudado (fim de turno commita)
        commitsStale[t.id]=true; prCache[t.id]=undefined;
        if(t.status==='review') pushNotif('Pronta para review ✓', t.title, t.id);
        else if(t.status==='plan-review') pushNotif('Plano pronto pra aprovar', t.title, t.id);
        else if(t.status==='error') pushNotif('Tarefa falhou — veja o log', t.title, t.id);
        else if(t.status==='merged') pushNotif('Mergeada na base ✓', t.title, t.id);
      } else if(prev===undefined && (t.status==='running'||t.status==='queued'||t.status==='thinking')){
        pushNotif('Nova tarefa iniciada', t.title, t.id);
      }
      if(t.prUrl && prevPr[t.id]===null){ pushNotif('PR aberto ✓', t.title, t.id); }
    }
    for(const p of pend){ if(!prevPending.has(p.id)){ pushNotif('Precisa de você — '+(p.agent||'agente'), p.prompt||'aguardando sua resposta', p.taskId); } }
  }
  prevStatus={}; tasks.forEach(t=>{ prevStatus[t.id]=t.status; prevPr[t.id]=t.prUrl||null; });
  prevPending=new Set(pend.map(p=>p.id));
  notifReady=true;
  // guarda-custos: avisa UMA vez quando a tarefa cruza o limite (padrão $25)
  try{
    const lim=parseFloat(lsGet('costWarn')||'25');
    const hardCap=lsGet('costHardCap')==='1';
    if(lim>0){ for(const t of tasks){ if(ACTIVE_ST.has(t.status)||t.status==='thinking'){ const c=taskCost(t.id); if(c.usd>=lim && !costWarned.has(t.id)){ costWarned.add(t.id);
      if(hardCap){ pushNotif('⛔ Teto de custo — '+fmtUsd(c.usd), t.title+' passou de '+fmtUsd(lim)+' — PAUSADA automaticamente (teto rígido)'); try{ stopTask(t.id); }catch(_){ } }
      else { pushNotif('⚠ Custo alto — '+fmtUsd(c.usd), t.title+' passou de '+fmtUsd(lim)+' — avalie pausar/encerrar'); }
    } } } }
  }catch(_){ }
  // eventos novos numa tarefa → a lista de commits pode estar defasada
  const top={};
  for(const e of (snap.events||[])){ const k=e.taskId||e.task_id; if(k && e.id>(top[k]||0)) top[k]=e.id; }
  for(const k in top){ if(prevEvTop[k]!==undefined && prevEvTop[k]!==top[k]) commitsStale[k]=true; prevEvTop[k]=top[k]; }
}
const prevEvTop={};
const costWarned=new Set();
async function refresh(){
  let snap;
  try{ snap = await Promise.race([ invoke("snapshot"), new Promise((_,rej)=>setTimeout(()=>rej(new Error('snapshot demorou >8s')), 8000)) ]); }
  catch(e){ if(/demorou/.test(String(e&&e.message))) console.error('refresh: snapshot', e); return; }
  detectNotifs(snap);
  const prevGraph = state.graph;
  state = snap;
  connected = !!snap.repo;
  gitUiSync(); // pasta sem git: esconde Grafo e o que depende de branch
  loadAllTasks(); // atualiza o cache multi-projeto (não bloqueia)
  if(typeof trkSyncTasks==='function') trkSyncTasks(); // painel de issues: status da issue acompanha a tarefa
  // git log é caro: só recomputa o grafo quando a aba Grafo está aberta.
  if(curView()==="graph"){ try{ state.graph = await invoke("graph"); }catch(e){ state.graph = prevGraph || []; } }
  else state.graph = prevGraph || [];
  const conn = $id("conn");
  conn.classList.toggle("live", connected && state.tasks.length>0);
  $id("connTxt").textContent = snap.repo ? snap.repo.split("/").slice(-2).join("/") : "sem repo";
  if(snap.repo && $id("repoInput").value==="") $id("repoInput").value = snap.repo;
  // header enxuto: com repo aberto, o caminho + "abrir" viram redundantes (o chip já mostra o repo)
  const hasRepo=!!snap.repo;
  $id("repoInput").style.display = hasRepo?"none":"";
  $id("connectBtn").style.display = hasRepo?"none":"";
  if(!selected && state.tasks.length){
    // reabre na ÚLTIMA tarefa em que você trabalhou (persistida por projeto);
    // se ela não existe mais, cai na mais recente (não na mais antiga).
    const saved=lsGet('sel:'+(snap.repo||''));
    selected = (saved && state.tasks.some(t=>t.id===saved)) ? saved : state.tasks[state.tasks.length-1].id;
  }
  $id("clock").textContent = connected ? "sincronizado · "+fmtTime(Date.now()) : "";
  if(!window.__buildShown){ window.__buildShown=1; invoke("build_info").then(ms=>{ const d=new Date(Number(ms)||0); if(+d){ const el=$id("clock"); el.textContent+=" · build "+String(d.getDate()).padStart(2,"0")+"/"+String(d.getMonth()+1).padStart(2,"0")+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); } }).catch(()=>{}); }
  renderProjName();
  // overlay grande aberto (workspace/planner/modais) cobre o app inteiro:
  // não re-renderiza o fundo a cada segundo — só o que está visível. Isso era
  // uma das causas da digitação travada.
  const bigOverlay=['fwOverlay','plannerOverlay','ntOverlay','agOverlay','artOverlay','askOverlay','cloudOverlay','ctOverlay','envOverlay','cfgOverlay','obOverlay','bdOverlay','dailyOverlay','pcOverlay','txOverlay','skOverlay']
    .some(id=>{ const el=$id(id); return el && el.style.display && el.style.display!=='none'; });
  if(bigOverlay){
    lastSig='';                                   // ao fechar, força um render completo
    const fw=$id('fwOverlay');
    if(fw && fw.style.display!=='none' && fwTask){ try{ fwLiveUpdate(); }catch(_){} }
    return;
  }
  const sig = snapSig();
  // só re-renderiza quando o estado MUDOU — re-render por segundo com tarefa
  // ativa destruía os botões entre mousedown e mouseup (clique "não pegava").
  if(sig===lastSig) return;
  // usuário com o mouse pressionado/interagindo → segura o render pro próximo
  // tick (lastSig não avança, nada se perde)
  if(Date.now()<uiHoldUntil) return;
  lastSig = sig;
  render();
}
// clique protegido: qualquer pointerdown segura re-renders por 600ms
let uiHoldUntil=0;
document.addEventListener('pointerdown', ()=>{ uiHoldUntil=Date.now()+600; }, true);
