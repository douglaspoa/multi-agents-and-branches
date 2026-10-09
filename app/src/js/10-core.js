// Starfork — 10-core
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
{ let last=Date.now(), skip=false;
  // janela voltou (oculta/suspensa): o 1º tick mede o tempo parado, não bloqueio — zera a base e pula esse tick
  document.addEventListener('visibilitychange', ()=>{ last=Date.now(); skip=true; });
  setInterval(()=>{ const now=Date.now(), lag=now-last-500; last=now;
    if(lag>1500) __diagLog('[lag] página bloqueada '+lag+'ms · em voo: '+__inflightTx()+' · aba: '+((typeof activeTab!=='undefined'&&activeTab)||'?'));
    // sem PerformanceObserver('longtask') (WKWebView do macOS não tem): o atraso do próprio timer vira a estimativa;
    // > 5 s é o Mac dormindo/timer congelado, não tarefa longa
    if(skip){ skip=false; return; }
    if(lag<=1500 && !__perfLtNative && !document.hidden && lag>=50 && lag<=5000) perfLongtask(lag, true); }, 500); }
// MEDIÇÃO (regra da Júlia: medir antes e depois de mexer no carregamento). Vai pro mesmo log, com throttle de
// 1 linha por segundo: [aba] <kind> 1º paint Nms (abrir → 1º quadro pintado), [aba] <kind> dados Nms (tabBusy,
// 06-carregamento) e [longtask] Nms (tarefas longas do mesmo segundo viram UMA linha). ?debug=1 também joga no console.
const __perfQ=[]; let __perfT=0, __perfLt=null, __perfLtNative=false;
const __perfDbg=/[?&]debug=1\b/.test(location.search||'');
const __perfTab=()=>((typeof activeTab!=='undefined'&&activeTab)||'?');
function __perfPump(){
  if(__perfT) return;
  const next=()=>{
    let line=__perfQ.shift();
    if(!line && __perfLt){ const l=__perfLt; __perfLt=null; line='[longtask] '+l.max+'ms'+(l.est?' (estimado)':'')+(l.n>1?' · +'+(l.n-1)+' no mesmo segundo, '+l.sum+'ms no total':'')+' · aba: '+l.tab; }
    if(!line){ __perfT=0; return; }
    if(__perfDbg) console.info(line);
    __diagLog(line); __perfT=setTimeout(next, 1000);
  };
  next();
}
function perfLog(line){ __perfQ.push(String(line)); if(__perfQ.length>30) __perfQ.shift(); __perfPump(); }
function perfLongtask(ms, est){ ms=Math.round(ms); const l=__perfLt||(__perfLt={ n:0, sum:0, max:0, est:!!est, tab:__perfTab() }); l.n++; l.sum+=ms; if(ms>l.max){ l.max=ms; l.tab=__perfTab(); } __perfPump(); }
try{ if(window.PerformanceObserver && (PerformanceObserver.supportedEntryTypes||[]).includes('longtask')){
  new PerformanceObserver(list=>{ for(const e of list.getEntries()) perfLongtask(e.duration); }).observe({ type:'longtask', buffered:true }); __perfLtNative=true; } }catch(_){ }
// abrir uma aba: mark no início e mede até o 1º quadro pintado depois dele (rAF + tarefa seguinte)
function perfTabOpen(kind){
  const t0=performance.now(), k='aba:'+kind; try{ performance.mark(k+':abrir'); }catch(_){ }
  requestAnimationFrame(()=>setTimeout(()=>{ const ms=Math.round(performance.now()-t0);
    try{ performance.mark(k+':paint'); performance.measure(k, k+':abrir', k+':paint'); }catch(_){ }
    try{ performance.clearMarks(k+':abrir'); performance.clearMarks(k+':paint'); performance.clearMeasures(k); }catch(_){ } // não acumula a cada aba aberta
    perfLog('[aba] '+kind+' 1º paint '+ms+'ms'); }, 0));
}
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
// Vale pra QUALQUER motor (Rust ai_once::chat_turn): Codex/DeepSeek devolvem o erro padrão "session not found…" quando
// a sessão some ou é de outro motor (a IA padrão mudou no meio). O GATEWAY não guarda sessão (sid "gateway:…"): toda
// rodada já vai com o histórico, sem tentar retomar e sem o aviso de "sessão perdida".
// @resume-inicio
// SÓ as mensagens específicas: Claude ("No conversation found with session ID"/a amigável do Rust), o erro padrão
// do Rust (SESSION_LOST_MSG), Codex ("no rollout found for thread id") e dsh (`session "x" does not exist`/outra pasta).
// Nada de "session … not found" genérico ("MCP session config not found" não é sessão de conversa perdida).
const AI_SESSION_LOST_RE=/No conversation found with session|sessão da conversa expirou no Claude|\bsession not found — a conversa anterior|no rollout found for thread|thread\/resume failed|session "[^"\n]{0,200}" (?:does not exist|was recorded in|recorded no working directory)/i;
// A IA padrão agora é o gateway (sem sessão)? — mesma chave que o seletor espelha em settings.json.
function aiEngineIsGateway(){ try{ return typeof aiDefaults==='function' && /^(gateway|logcomex)/i.test(String(aiDefaults().eng||'')); }catch(_){ return false; } }
// `extra` (opcional): estado que o histórico resumido não carrega (ex.: o RASCUNHO do planner com os campos já
// fechados — o gateway não tem sessão e as falas truncadas não bastam). Vai dentro do mesmo bloco CONTEXTO.
function aiHistoryPrompt(prompt, history, lost, extra){
  const hist=(history||[]).filter(m=>m&&(m.text||'')).slice(-14).map(m=>{ const who=(m.who||m.role||''); const tag=who==='you'||who==='user'?'USUÁRIO':who==='bot'||who==='assistant'?'VOCÊ':'SISTEMA'; return tag+': '+String(m.text).replace(/\n*\[ANEXOS\][\s\S]*?\[\/ANEXOS\]/g,'').slice(0,1500); }).join('\n\n');
  const ex=String(extra||'').trim();
  if(!hist && !ex) return prompt;
  return (lost?'[CONTEXTO — a sessão anterior desta conversa foi perdida; abaixo o histórico resumido pra você CONTINUAR de onde parou, sem recomeçar nem repetir o que já foi dito.]\n'
    :'[CONTEXTO — histórico desta conversa até aqui; CONTINUE de onde parou, sem recomeçar nem repetir o que já foi dito.]\n')+hist+(ex?(hist?'\n\n':'')+ex:'')+'\n[/CONTEXTO]\n\n'+prompt;
}
async function aiCallResumeSafe(fn, sid, prompt, history, extra){
  // sem sessão pra retomar (gateway, sid apagado, sid vazio devolvido) e já houve conversa → o histórico vai junto
  const talked=(history||[]).some(m=>m&&(m.text||'')&&/^(you|user)$/.test(m.who||m.role||''));
  if((sid && /^gateway:/.test(String(sid))) || (talked && (!sid || aiEngineIsGateway()))) return await fn(aiHistoryPrompt(prompt, history, false, extra), null);
  try{ return await fn(prompt, sid||null); }
  catch(e){
    const msg=String(e&&e.message||e);
    if(!sid || !AI_SESSION_LOST_RE.test(msg)) throw e;
    console.error('sessão perdida — recomeçando com histórico:', msg.slice(0,120));
    const r=await fn(aiHistoryPrompt(prompt, history, true, extra), null);
    return Object.assign({}, r||{}, { recovered:true });
  }
}
// @resume-fim
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
// ícones em 1em (herdam o font-size do botão/selo): fechar/remover e check de status —
// substituem os glifos soltos ✕ × ✖ ✓ ✔ ☑, que cada fonte desenha de um jeito
const icEm = s => s.replace('<svg ', '<svg width="1em" height="1em" style="vertical-align:-.125em;flex:none" aria-hidden="true" ');
IC.x = icEm(IC.xs); IC.ok = icEm(IC.check);
// @starfork-inicio
// A marca Starfork: a estrela de 4 pontas que se bifurca — o tronco desce da estrela e um ramo (branch) sai dele. FONTE ÚNICA do símbolo —
// o logo da sidebar, o ícone da aba Nova demanda, o avatar da IA no planner e o loader da marca (06-carregamento,
// em traço) reusam este SVG; não desenhe o símbolo de novo em outro lugar. Legível a 16 px. pathLength=1 nos
// traços é pro loader desenhar com stroke-dashoffset (sem efeito no estático). starforkG = só o <g> (a aba já põe o <svg>).
IC.starforkG = '<g class="sf-g" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
  + '<path class="sf-star" pathLength="1" fill="currentColor" stroke-width=".5" d="M6.2 1 7.4 4 10.4 5.2 7.4 6.4 6.2 9.4 5 6.4 2 5.2 5 4Z"/>'
  + '<path class="sf-b1" pathLength="1" d="M6.2 8.3v5.4"/><path class="sf-b2" pathLength="1" d="M6.2 11.9c0-2.6 2.2-3.5 5.2-4.3"/>'
  + '<circle class="sf-n1" cx="6.2" cy="13.8" r="1.35" fill="currentColor" stroke="none"/><circle class="sf-n2" cx="12.4" cy="7.3" r="1.5" fill="currentColor" stroke="none"/></g>';
IC.starfork = '<svg class="sf-mark" viewBox="0 0 16 16" aria-hidden="true">' + IC.starforkG + '</svg>';
// @starfork-fim
IC.starforkEm = icEm(IC.starfork); // em 1em, no meio do texto/botão (substitui o glifo de estrela que era usado como marca)
// logo da sidebar: o index.html traz uma cópia estática (fallback sem JS, conferida pelo identidade.test); aqui ela é trocada pela fonte
{ const lg = document.querySelector('.brand .logo'); if (lg) lg.innerHTML = IC.starfork; }
// R7: ícones que substituem os emoji que eram usados como ícone (mão, escudo, ampulheta, aviso, cadeado, seta de push…) — em 1em, pra ir no meio do texto
Object.assign(IC, {
  shield: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.9l4.7 1.8v3.6c0 3-2 5.3-4.7 6.7-2.7-1.4-4.7-3.7-4.7-6.7V3.7z" stroke-linejoin="round"/></svg>'),
  clock: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.7"/><path d="M8 4.9v3.3l2.2 1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  warn: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.3l6.1 10.9H1.9z" stroke-linejoin="round"/><path d="M8 6.5v3.1" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".45" fill="currentColor" stroke="none"/></svg>'),
  lock: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.3"/><path d="M5.4 7V5.1a2.6 2.6 0 0 1 5.2 0V7" stroke-linecap="round"/></svg>'),
  push: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3.6M4.3 7.2L8 3.5l3.7 3.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  retry: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3M12.7 2.4V5H10.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  route: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5h3.2l4.6 7h3.2M2.5 11.5h3.2l1.3-2M9.7 6.5l.6-2h3.2M11.6 2.8l1.9 1.7-1.9 1.7M11.6 9.8l1.9 1.7-1.9 1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  handEm: icEm(IC.hand), boltEm: icEm(IC.bolt), globeEm: icEm(IC.globe), phoneEm: icEm(IC.phone), chat: icEm(IC.q), clipEm: icEm(IC.clip), aiEm: icEm(IC.ai),
});
// @r8-icones-inicio
// R8 (F12, tela por tela): os glifos de texto que faziam papel de ícone de STATUS (· ● ? ❚❚ ◆ ⌥ ✓ ! ⊘ ×), de épico (◆),
// de plano do orquestrador (◉), de seção recolhível (▾ ▸) e de alerta (⚑ ⚠) viram SVG de linha 16 px, em 1em.
// STATUS_META.ic (00-util) guarda o NOME da chave daqui; stIcon/stBadge resolvem na hora de desenhar.
Object.assign(IC, {
  stQueue:  icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3.6" stroke-dasharray="2.2 1.6"/></svg>'),
  stRun:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/></svg>'),
  stAsk:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.4c.1-.95.8-1.5 1.75-1.5 1 0 1.7.6 1.7 1.45 0 1.2-1.6 1.2-1.7 2.5" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".75" fill="currentColor" stroke="none"/></svg>'),
  stPause:  icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M6.6 5.8v4.4M9.4 5.8v4.4" stroke-linecap="round"/></svg>'),
  stReview: icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.4 13.6 8 8 13.6 2.4 8z" stroke-linejoin="round"/><path d="M5.9 8.1l1.5 1.5 2.8-3" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  stPr:     icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4.4" cy="3.9" r="1.5"/><circle cx="4.4" cy="12.1" r="1.5"/><circle cx="11.6" cy="12.1" r="1.5"/><path d="M4.4 5.4v5.2M11.6 10.6V6.8c0-1-.7-1.7-1.7-1.7H7.4m1.4-1.5L7.3 5.1l1.5 1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  stDone:   icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  stErr:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.9v3.6" stroke-linecap="round"/><circle cx="8" cy="11" r=".8" fill="currentColor" stroke="none"/></svg>'),
  stBlock:  icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M4 12 12 4" stroke-linecap="round"/></svg>'),
  stX:      icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M6 6l4 4M10 6l-4 4" stroke-linecap="round"/></svg>'),
  epic:     icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.2 13.8 8 8 13.8 2.2 8z" stroke-linejoin="round"/><path d="M8 5.4 10.6 8 8 10.6 5.4 8z" fill="currentColor" stroke="none"/></svg>'),
  orq:      icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="3.6" cy="8" r="1.6"/><circle cx="12.4" cy="3.8" r="1.6"/><circle cx="12.4" cy="12.2" r="1.6"/><path d="M5.1 7.3l5.8-2.8M5.1 8.7l5.8 2.8" stroke-linecap="round"/></svg>'),
  chevD:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 6.3 8 9.8l3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  chevR:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.3 4.5 9.8 8l-3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  flag:     icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.6 14V2.6m0 .6h7.6l-1.6 2.7 1.6 2.7H3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  stop:     icEm('<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.4"/></svg>'),
  play:     icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5.2 3.6v8.8L12.2 8z" stroke-linejoin="round"/></svg>'),
  unlock:   icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.3"/><path d="M5.4 7V5.1a2.6 2.6 0 0 1 5-1" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  reset:    icEm('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.4 8a4.6 4.6 0 1 0 1.4-3.3M3.3 2.4V5h2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.4 6.4l3.2 3.2M9.6 6.4 6.4 9.6" stroke-linecap="round"/></svg>'),
  more:     icEm('<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.6" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.4" cy="8" r="1.25"/></svg>'),
});
// @r8-icones-fim
// botão ⋯ do cabeçalho da Tarefa (index.html): o ícone vem da fonte, não de uma cópia do SVG no HTML
{ const mb = document.getElementById('fwMore'); if (mb) mb.innerHTML = IC.more; }
// R7: o motor escrevia eventos com emoji na frente (balão de fala, interrogação, ampulheta, setas de retomar…).
// Os novos vêm em texto puro ("Você: …", "perguntou ao humano: …", "Na fila (1º): …"); aqui o histórico
// ANTIGO é reescrito no mesmo formato ao chegar (snapshot/task_events) — assim toda tela e todo parser
// só precisam conhecer o formato novo. Só prefixos que o PRÓPRIO app/motor escrevia; texto do agente fica intacto.
const EV_LEGACY = [
  [/^💬\s*(?:📎\s*)?/u, (e)=>e.agent==='Você'?'Você: ':null],
  [/^❓\s*(?:perguntou ao humano:?\s*)?/u, ()=>'perguntou ao humano: '],
  [/^⏳\s*pedido NA FILA\s*/u, ()=>'Na fila '],
  [/^⏳\s*limite de uso/u, ()=>'Limite de uso'],
  [/^⏳\s*/u, ()=>''],
  [/^▶️\s*/u, ()=>'▶ '],
  [/^(?:🔀|🔄)\s*/u, ()=>''],
  [/^(?:📦|🛠️?|🔗|☑️?)\s*/u, (e)=>{ e.tool=true; return ''; }],
  [/^📱\s*/u, ()=>''],
  [/^⚠️?\s*/u, (e)=>e.agent==='Sistema'?'':null],
];
function evNorm(e){
  if(!e || typeof e.text!=='string' || e._n) return e;
  const tx=e.text; e._n=1;
  const c=tx.charCodeAt(0); if(c<0x2190) return e; // começa com letra/ASCII: nada a fazer (caminho quente)
  for(const [re, fn] of EV_LEGACY){ const m=tx.match(re); if(!m) continue; const r=fn(e); if(r===null) continue; e.text=r+tx.slice(m[0].length); break; }
  return e;
}
function evNormAll(arr){ if(Array.isArray(arr)) for(const e of arr) evNorm(e); return arr; }
// URL de preview que o agente anuncia numa linha "PREVIEW: http://…" (antes: globo emoji + "preview:")
const PREVIEW_RE=/(?:🌐\s*)?\bpreview:\s*(https?:\/\/[^\s'"”)]+)/i;
// mensagem digitada pelo humano no chat da tarefa (formato novo "Você: …"; o antigo com o balão de fala é normalizado acima)
function evIsUserMsg(e){ return !!e && e.agent==='Você' && /^Você:\s/.test(String(e.text||'')); }
function evUserText(tx){ return String(tx||'').replace(/^Você:\s*/,''); }
// nota de sistema do motor → ícone (antes o emoji do prefixo fazia esse papel)
function evSysIcon(tx){ const s=String(tx||'');
  if(/^Na fila \(/.test(s)) return IC.clock;
  if(/^Fila limpa:/.test(s)) return IC.clock;
  if(/^Limite de uso/i.test(s)) return IC.clock;
  if(/^▶ intervalo cumprido/.test(s)) return IC.retry;
  if(/^A sessão( do chat)? /i.test(s)) return IC.retry;
  if(/roteando esta tarefa|^Route AI:/i.test(s)) return IC.route;
  return ''; }
// helper: ícone + rótulo num botão (substitui os emojis por SVG da biblioteca)
async function openExternal(url){ try{ await invoke('open_url',{ url }); }catch(e){ showErr(e, 'Não consegui abrir o link'); } }
async function copyLink(url, btn){ try{ await navigator.clipboard.writeText(url); if(btn){ const o=btn.textContent; btn.textContent='copiado!'; setTimeout(()=>btn.textContent=o,1200);} }catch(e){ openExternal(url); } }

// cores de status vêm do dicionário único (STATUS_META em 00-util.js)
const STATUS_COLOR = Object.fromEntries(Object.entries(STATUS_META).map(([k,v])=>[k,v.c]));
const GLYPH = { status:"◆", think:"…", read:"‹", edit:"±", write:"+", bash:"$", note:"»", claim:"⊞", collision:"!", error:"✕", done:"✓" };
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
    { const h=humanErr(e,"Não consegui abrir o projeto"); $id("connTxt").textContent = h.msg; $id("connTxt").title = h.raw||""; }
    $id("conn").classList.remove("live");
  }
}

// ---- ferramentas de dev/admin (publicar release, trocar o backend): só pra instalação de desenvolvimento
// ou owner/admin da organização — pro usuário comum são botões que só confundem ----
let devInstall=false;
function isOrgAdmin(){ try{ return typeof cloudData!=='undefined' && !!cloudData && (cloudData.meRole==='owner'||cloudData.meRole==='admin'); }catch(_){ return false; } }
function canSeeDevTools(){ return devInstall || isOrgAdmin(); }
function devUiSync(){ const b=$id('pubRelBtn'); if(b) b.style.display=canSeeDevTools()?'':'none'; }
setTimeout(()=>{ invokeQuiet('is_dev_install').then(v=>{ devInstall=!!v; devUiSync(); }).catch(()=>{}); }, 0);
// ---- pasta aberta SEM git: o app abre, mas branch/PR/worktree só depois de criar o repositório ----
function repoHasGit(){ return !state || !state.repo || state.git!==false; }
// E4: repositório com remote (GitHub)? Projeto criado só local não tem — o PR vira "publicar no GitHub"
function repoHasRemote(){ return !state || !state.repo || state.git===false || state.remote!==false; }
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
  const name=pathBase(state.repo)||'esta pasta';
  if(!await askYes(`"${name}" não tem repositório git.\n\nCada demanda roda numa branch própria, então o Starfork precisa de um repositório. Criar agora?\n\n(cria o repositório na branch main, deixa a pasta de trabalho do Starfork fora do versionamento e faz o 1º commit com o conteúdo atual)`)) return false;
  try{ await invoke('git_init_repo'); lastSig=''; await refresh(); if(typeof loadProjects==='function') loadProjects(); return repoHasGit(); }
  catch(e){ showErr(e, 'Não consegui criar o repositório'); return false; }
}
// etiqueta na barra lateral: "sem git · criar repositório"
function gitRailTag(){
  if(repoHasGit()) return '';
  return `<div class="nogitrow" title="esta pasta não tem repositório git — sem branch/PR até criar um"><span class="nogittag">sem git</span><button class="nogitbtn" onclick="gitGate()">criar repositório</button></div>`;
}
function curView(){ return (((document.querySelector('#viewSeg button.on')||{}).dataset)||{}).v || "flow"; }
// Assinatura barata do estado: se nada mudou, pulamos o render inteiro.
function snapSig(){
  const t=(state.tasks||[]).map(x=>x.id+":"+x.status+":"+x.stage+":"+(x.sortOrder??"")+":"+((x.loop&&x.loop.at)||"")).join(","); // loop: o aviso pode sumir sem evento novo
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
// macOS: o Rust usa UNUserNotificationCenter e responde a permissão (notif_status). 'unsupported' = Linux/
// Windows ou binário fora do .app → vale a checagem do plugin, como antes.
let notifState='';
const NOTIF_OFF_MSG='Notificações do Starfork bloqueadas — abra Ajustes do Sistema › Notificações › Starfork e ative.';
async function notifOpenSettings(){ try{ await invoke('notif_open_settings'); }catch(e){ showErr(e, 'Não consegui abrir os Ajustes do Sistema'); } }
async function notifRefresh(){
  let st='unsupported';
  try{ st=String(await invokeQuiet('notif_status')||'unsupported'); }catch(_){ st='unsupported'; }
  notifState=st;
  return st;
}
async function initNotifs(){
  const st=await notifRefresh();
  if(st!=='unsupported'){
    // notDetermined: o pedido de permissão está na tela (feito no boot pelo Rust) — deixa ligado
    notifOn = st!=='denied';
    if(st==='denied'){
      // aviso UMA vez por bloqueio (volta a avisar se o usuário liberar e bloquear de novo)
      if(!lsGet('notifDeniedWarned')){ lsSet('notifDeniedWarned','1'); toast(NOTIF_OFF_MSG, 'warn', { label:'abrir Ajustes', fn:notifOpenSettings }); }
    } else lsSet('notifDeniedWarned','');
    return;
  }
  const n=notifApi(); if(!n){ return; }
  try{ let ok = await n.isPermissionGranted(); if(!ok){ const p=await n.requestPermission(); ok = p==='granted'; } notifOn=!!ok; }
  catch(_){ notifOn=false; }
}
// bloco "Notificações" das Configurações: estado atual + atalho pros Ajustes do Sistema
async function notifCfgMount(){
  const h=$id('notifHost'); if(!h) return;
  h.innerHTML='<span class="dim">lendo…</span>';
  const st=await notifRefresh();
  if(st!=='unsupported') notifOn = st!=='denied';
  const line={ authorized:'Notificações: ativadas', provisional:'Notificações: ativadas (entregues em silêncio na Central)',
    notDetermined:'Notificações: aguardando sua resposta no pedido de permissão do macOS', denied:NOTIF_OFF_MSG,
    unsupported:'Notificações: '+(notifOn?'ativadas':'desativadas')+' (pelo sistema)' }[st] || ('Notificações: '+st);
  h.innerHTML='<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span'+(st==='denied'?' style="color:var(--warn)"':'')+'>'+esc(line)+'</span>'
    +(st!=='unsupported'?'<button class="btn sm" id="notifOpen" type="button">'+IC.extlink+' abrir Ajustes do Sistema</button>':'')+'</div>';
  bindClick('notifOpen', notifOpenSettings);
}
let lastNotif=null; // {id, ts} — última notificação disparada (pro roteamento do clique)
function pushNotif(title, body, taskId){
  if(!notifOn) return;
  if(taskId && !document.hasFocus()) lastNotif={ id:taskId, ts:Date.now() };
  // caminho nativo: atribuição correta (Starfork) — clicar abre o APP
  // falha (sem permissão, fora do .app) → plugin; invokeQuiet: não é erro pra mostrar, é só o caminho B
  invokeQuiet('notify_native', { title, body: String(body||'').slice(0,180), taskId: taskId||null })
    .catch(()=>{ const n=notifApi(); if(n) try{ n.sendNotification({ title, body: String(body||'').slice(0,180) }); }catch(_){} });
}
function notifRoute(id){
  // A9: a vista "Time" saiu da Central — a notificação do time abre a ABA Time (antes clicava o #viewSeg escondido e ficava na Central)
  if(id==='view:team'){ if(window.openTab) window.openTab('time'); else if(typeof setView==='function') setView('team'); return; }
  if(id && (state.tasks||[]).some(t=>t.id===id)){
    selected=id;
    if(window.openTab && typeof activeTab!=='undefined' && activeTab!=='flow') window.openTab('flow'); // com outra aba na frente a tarefa ficava escondida
    const b=document.querySelector('#viewSeg button[data-v="flow"]'); if(b && !activeIs('flow')) b.click();
    render();
  }
}
// clique na notificação → o macOS ativa o app (atribuição) e nós roteamos:
// pelo evento nativo quando a lib entrega o clique, ou pelo GANHO DE FOCO logo
// após uma notificação (banner clicado ativa o app em segundos).
try{ window.__TAURI__.event.listen('notif-open', (ev)=>{ lastNotif=null; notifRoute(ev.payload||''); }); }catch(_){ }
window.addEventListener('focus', ()=>{
  // liberou nos Ajustes e voltou pro app: religa sem reiniciar (e o bloco das Configurações acompanha)
  if(notifState==='denied' || notifState==='notDetermined') notifRefresh().then(st=>{ if(st!=='unsupported') notifOn = st!=='denied'; if($id('notifHost')) notifCfgMount(); }).catch(()=>{});
  if(lastNotif && Date.now()-lastNotif.ts<180000){ const id=lastNotif.id; lastNotif=null; notifRoute(id); }
});
// ⌘K — busca global (redesign): vai pra Central de execuções e foca a busca.
// Com outra aba na frente (Skills, Conta…) a busca ficava escondida atrás dela: ativa a aba Central antes.
window.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    if(window.openTab && typeof activeTab!=='undefined' && activeTab!=='flow') window.openTab('flow');
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
        // fim de turno (saiu de running/thinking pra QUALQUER estado: review, parada, teto, erro…) → o medidor do plano relê
        if((prev==='running'||prev==='thinking') && t.status!=='running' && t.status!=='thinking' && typeof planMeterTurnEnd==='function') planMeterTurnEnd();
        // parada pelo humano (■ parar) ou pelo teto de custo NÃO é "pronta" — era notificação falsa
        if(t.status==='review'){ if(!(typeof budgetQuiet!=='undefined' && budgetQuiet.delete(t.id))) pushNotif('Pronta para review ✓', t.title, t.id); }
        else if(t.status==='plan-review') pushNotif('Plano pronto pra aprovar', t.title, t.id);
        else if(t.status==='needs-you') pushNotif('Precisa de você', t.title, t.id);
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
  if(typeof loopWatch==='function') loopWatch(tasks); // detector de loop: notifica (e pausa, se ligado) o episódio NOVO
  notifReady=true;
  // guarda-custos: AVISO (só notifica) UMA vez quando a tarefa cruza o limite (padrão $25).
  // O TETO que pausa e pergunta é outro mecanismo (budgetWatch, 53-teto-protecao) — o antigo
  // "teto rígido" chamava stop_task e jogava a tarefa em "pronta pra revisar" (bug #13).
  try{
    const lim=parseFloat(lsGet('costWarn')||'25');
    if(lim>0){ for(const t of tasks){ if(ACTIVE_ST.has(t.status)||t.status==='thinking'){ const c=taskCost(t.id); if(c.usd>=lim && !costWarned.has(t.id)){ costWarned.add(t.id);
      pushNotif('Custo alto — '+fmtCost(c.usd), t.title+' passou de '+fmtCost(lim)+' — avalie pausar/encerrar');
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
  // painel da tela dividida: usa o snapshot que a janela principal JÁ leu (cópia rasa — nada de IPC nem de 0,5 MB a
  // mais por painel); notificações, teto de custo e sincronias ficam só com a janela principal
  if(typeof SF_PANE!=='undefined' && SF_PANE){ try{ if(window.parent.state && window.parent.state.tasks) snap=Object.assign({}, window.parent.state); }catch(_){ } }
  if(!snap) try{ snap = await Promise.race([ invoke("snapshot"), new Promise((_,rej)=>setTimeout(()=>rej(new Error('snapshot demorou >8s')), 8000)) ]); }
  catch(e){ if(/demorou/.test(String(e&&e.message))){ console.error('refresh: snapshot', e); __diagLog('[preso] snapshot sem resposta · em voo ('+__inflight.size+'): '+__inflightTx()); }
    if(typeof ldBootFail==='function') ldBootFail(e, ()=>refresh()); // boot sem snapshot: erro com "tentar de novo", não esqueleto eterno
    return; }
  // pergunta do teto de custo = pendência sintética; entra ANTES do detectNotifs (vira "Precisa de você")
  const pane=(typeof SF_PANE!=='undefined' && SF_PANE);
  if(!pane){
  if(typeof budgetInject==='function') try{ budgetInject(snap); }catch(e){ tickErr('budgetInject', e); }
  evNormAll(snap&&snap.events); // R7: histórico antigo com emoji no prefixo → formato novo
  detectNotifs(snap);
  }
  const prevGraph = state.graph, prevCfg = state.config, prevRepo = state.repo;
  state = snap;
  if(!pane){
  if(typeof nvSweep==='function') try{ nvSweep(snap); }catch(e){ tickErr('nvSweep', e); } // Prévia: tarefa acabou → proxy dela morre (57-navegador)
  if(typeof envSweep==='function') try{ envSweep(snap); }catch(e){ tickErr('envSweep', e); } // "Subir ambiente": tarefa acabou → o site dela para (58-ambiente)
  if(typeof memLearnTick==='function') memLearnTick(snap); // selo dos aprendizados pra revisar (só lê a fila quando muda)
  }
  // R5-5: o snapshot não traz o catálogo (config) — antes cada refresh o apagava e as cores dos agentes caíam no hash
  if(prevCfg && !state.config && prevRepo===snap.repo) state.config = prevCfg;
  connected = !!snap.repo;
  if(!pane && typeof budgetWatch==='function') try{ budgetWatch(); }catch(e){ tickErr('budgetWatch', e); }
  if(typeof protectLoad==='function' && !protectLoaded) protectLoad();
  gitUiSync(); // pasta sem git: esconde Grafo e o que depende de branch
  if(typeof noProjSync==='function') noProjSync(); // sem projeto: apaga Skills/Issues/Agentes/Chat/Daily (36-comecar)
  if(!pane){
  loadAllTasks(); // atualiza o cache multi-projeto (não bloqueia)
  if(typeof trkSyncTasks==='function') trkSyncTasks(); // painel de issues: status da issue acompanha a tarefa
  }
  // git log é caro: só recomputa o grafo quando a aba Grafo está aberta.
  if(curView()==="graph"){ try{ state.graph = await invoke("graph"); }catch(e){ state.graph = prevGraph || []; } }
  else state.graph = prevGraph || [];
  const conn = $id("conn");
  conn.classList.toggle("live", connected && state.tasks.length>0);
  $id("connTxt").textContent = snap.repo ? snap.repo.split(/[\\/]+/).filter(Boolean).slice(-2).join("/") : "sem repo";
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
  const bigOverlay=['fwOverlay','cvSplit','plannerOverlay','ntOverlay','agOverlay','artOverlay','cloudOverlay','ctOverlay','envOverlay','cfgOverlay','obOverlay','bdOverlay','dailyOverlay','pcOverlay','txOverlay','skOverlay']
    .some(id=>{ const el=$id(id); return el && el.style.display && el.style.display!=='none'; });
  if(bigOverlay){
    lastSig='';                                   // ao fechar, força um render completo
    // as telas hoje são ABAS: a barra lateral continua à mostra ao lado — mantém ela viva (só troca o que mudou)
    if(typeof renderRail==='function') safe(renderRail);
    // a página Projeto (cabeçalho + cartão de contagens) também está à mostra em Conversa/Agentes/Skills — antes congelava
    if(typeof g1TabOn==='function' && g1TabOn('projeto') && typeof projPageRender==='function') safe(projPageRender);
    const fw=$id('fwOverlay');
    if(fw && fw.style.display!=='none' && fwTask){ try{ fwLiveUpdate(); }catch(_){} }
    if(typeof cvPanesTick==='function') try{ cvPanesTick(); }catch(e){ tickErr('cvPanesTick', e); } // tela dividida: os painéis acompanham
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
  if(!window.__perfBoot){ window.__perfBoot=1; perfLog('[aba] central dados '+Math.round(performance.now())+'ms (boot → 1º render com o snapshot)'); }
}
// clique protegido: qualquer pointerdown segura re-renders por 600ms
let uiHoldUntil=0;
document.addEventListener('pointerdown', ()=>{ uiHoldUntil=Date.now()+600; }, true);
