// ===== utilitários compartilhados (carrega ANTES de tudo) =====
// ===== PAINEL DA TELA DIVIDIDA (spec-canvas-workspace, pivot "canvas no topo") =====
// Uma demanda lado a lado com outra é o app INTEIRO carregado num iframe (index.html?sfpane=task:<id>): estado JS
// próprio (nenhum global de uma demanda vaza pra outra) e a tela da demanda exatamente como ela é. Esse "painel":
//  - fala com o Rust pela ponte da janela principal (mesma origem) — e só escuta os eventos da demanda;
//  - não roda nada "do app inteiro" (nuvem, cobrança, onboarding, polling): na carga, setInterval e timers ≥ 1 s
//    viram nada; quem atualiza o painel é a janela principal (sfPaneTick depois de cada snapshot);
//  - esconde barra lateral e abas (quem manda nelas é a janela principal).
const SF_PANE=(()=>{ try{ const p=new URLSearchParams(location.search).get('sfpane'); return (p && window.parent && window.parent!==window) ? p : null; }catch(_){ return null; } })();
const CV_REALM=SF_PANE||'main'; // chave dos recursos (gerente de recursos é um só no app, mas cada painel tem os seus)
if(SF_PANE){
  document.documentElement.classList.add('sfpane');
  try{
    const T=window.parent.__TAURI__, unl=[];
    // só os eventos que a tela da demanda usa (nada de notificação duplicada); o terminal ao vivo (term-data/term-exit)
    // passa SÓ o desta demanda — sem eles o terminal congelava dentro do painel, e sem o filtro todo PTY inundava cada painel
    const PANE_EV=['env-progress','checks-progress','term-data','term-exit'], PANE_TID=String(SF_PANE).replace(/^task:/,'');
    const listen=(name, fn)=>{ if(!PANE_EV.includes(name)) return Promise.resolve(()=>{});
      const f=/^term-/.test(name) ? (ev=>{ const p=ev&&ev.payload; if(p && String(p.taskId)===PANE_TID) fn(ev); }) : fn;
      return T.event.listen(name, f).then(u=>{ unl.push(u); return u; }); };
    const api=Object.assign({}, T, { event:Object.assign({}, T.event, { listen }) });
    try{ window.__TAURI__=api; }catch(_){ }
    if(window.__TAURI__!==api) try{ Object.defineProperty(window, '__TAURI__', { value:api, configurable:true, writable:true }); }catch(_){ }
    window.sfPaneDispose=()=>{ unl.splice(0).forEach(u=>{ try{ u(); }catch(_){ } }); };
  }catch(_){ }
  const _si=window.setInterval.bind(window), _st=window.setTimeout.bind(window); let booting=true;
  window.setInterval=function(fn, ms, ...a){ return booting ? 0 : _si(fn, ms, ...a); };
  window.setTimeout=function(fn, ms, ...a){ return (booting && (+ms||0)>=1000) ? 0 : _st(fn, ms, ...a); };
  document.addEventListener('DOMContentLoaded', ()=>{ booting=false; });
}
// atalhos de DOM: $id no lugar de document.getElementById; bindClick() liga um handler só se o elemento existir
function $id(id){ return document.getElementById(id); }
// erros ANTES do 52-erros carregar (boot dos arquivos 00–51) ficam guardados aqui e ele despacha
window.__earlyErrs=[];
window.addEventListener('error', e=>{ if(window.__earlyErrs) window.__earlyErrs.push(['window.error', e.error||e.message, { at:(e.filename||'')+':'+(e.lineno||0) }]); });
window.addEventListener('unhandledrejection', e=>{ if(window.__earlyErrs) window.__earlyErrs.push(['unhandledrejection', e]); });
// falha de tick em segundo plano: rede instável é esperada (não polui app_errors); bug de verdade vai pro console.error → tabela
function tickErr(name, e){
  const m=String((e&&e.message)||e||'');
  if(/load failed|failed to fetch|networkerror|network|timeout|timed out|expirou|offline|abort|sem conex[ãa]o/i.test(m)) return;
  console.error('tick '+name+':', e);
}
// ===== rastreio de erros (52-erros): o que NÃO vai pra app_errors =====
// Estado legítimo que a tela já explica em pt-BR, ou ação do próprio usuário — não é defeito do produto.
const ERR_EXPECTED=[
  /^SECRET_(UNBOUND|MISSING):/,                          // chave do painel de issues não configurada NESTA máquina
  /^[A-Z][A-Z_]*_STOPPED$/,                              // o usuário apertou "parar" (PROJECT_CHAT_STOPPED, ORQ_CHAT_STOPPED…)
  /^GH_NO_ACCESS:/,                                      // gh logado sem acesso ao repo — a tela do PR orienta a trocar de conta
  /c[óo]pia de trabalho desta tarefa n[ãa]o existe mais/, // worktree limpa (merge) — mandar mensagem recria
  /^esta tarefa n[ãa]o est[áa] neste projeto/,           // tarefa apagada/de outro projeto: listas voltam vazias
  /n[ãa]o existe mais nesta c[óo]pia da tarefa/,         // arquivo apagado/renomeado pelo agente
  /^artefato n[ãa]o encontrado/,                          // ainda não gerado / já removido — a tela mostra vazio
  /\(mock\)/,                                             // preview/harness com __TAURI__ falso
];
function errIsExpected(msg){ const m=String(msg||'').trim(); return ERR_EXPECTED.some(re=>re.test(m)); }
// anti-flood por sessão: mesma origem+mensagem no máximo 1x por janela (10 min) e, no total,
// no máximo `cap` registros por janela — um laço nunca mais gera 500 linhas (book = objeto mutável)
function errRateOk(book, key, now, winMs, cap){
  winMs=winMs||600000; cap=cap||30;
  if(book[key] && now-book[key]<winMs) return false;
  const hits=(book.__hits||[]).filter(t=>now-t<winMs);
  if(hits.length>=cap){ book.__hits=hits; return false; }
  hits.push(now); book.__hits=hits; book[key]=now; return true;
}
// só o app de verdade (binário Tauri) reporta. O preview/harness injeta um __TAURI__ falso servido por
// http://localhost e mandava "rede indisponível (mock)" etc. pro Supabase de PRODUÇÃO.
function isRealApp(w){
  try{
    if(!w || w.__SF_MOCK__) return false;
    if(!w.__TAURI_INTERNALS__) return false; // o shim só define window.__TAURI__
    const l=w.location||{};
    return l.protocol==='tauri:' || /(^|\.)tauri\.localhost$/i.test(String(l.hostname||''));
  }catch(_){ return false; }
}
function bindClick(id, fn, ev){ const el=$id(id); if(el) el[ev||'onclick']=fn; return el; }
// localStorage tolerante (webview em modo privado / sem permissão não derruba o app)
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
// @puro-migra-inicio (F4 G1 — testado em app/tests/redesign-f4-g1.test.mjs)
// preferências antigas → lugar novo, UMA vez e ANTES de quem lê (roda aqui, na carga do 00-util). Nada se perde:
// o valor antigo fica com sufixo ":f4". get/set = localStorage. Devolve as chaves que mudaram.
function g1MigratePrefs(get, set){
  const done=[]; if(get('g1:migrado')==='1') return done;
  const mv=(k, from, to)=>{ const v=get(k); if(v!=null && from.includes(v)){ set(k+':f4', v); set(k, to); done.push(k); } };
  mv('flowView', ['grid'], 'table');              // D22: a grade saiu
  mv('flowScope', ['team','all','mine'], 'exec'); // "Time" virou página; escopos antigos da Central
  mv('tmView', ['grafo'], 'overview');            // só a vista que não existe mais ('feed' = Atividade continua válida)
  set('g1:migrado','1');
  return done;
}
// @puro-migra-fim
try{ g1MigratePrefs(lsGet, lsSet); }catch(_){ }
// Chats (planner, projeto, issues, orquestrador): o que a tela guarda depois de uma rodada é o sid DEVOLVIDO —
// vazio LIMPA o guardado (a próxima rodada leva o histórico; aiCallResumeSafe em 10-core.js).
function aiKeepSid(r, set){ set(String((r&&r.sessionId)||'')); }
// caminhos de ARQUIVO nos dois formatos (/Users/x/proj e C:\Users\x\proj) — Windows mostrava o caminho inteiro.
// Só pra caminho do sistema de arquivos: URL e nome de branch continuam com split('/').
// @adiado-puro-inicio — UMA régua de "requisito ADIADO por decisão sua" (o agente marca deferred/waived, ou blocked com
// a nota da decisão). Vale pro portão (proofMissingOf, 21), o orquestrador (orqReqSettled, 34), o painel e a faixa
// (60-terminal-layout/60-ciclo), a Entrega (27), a Central (66) e a Prévia (58) — e bate com o verifyProofs do motor
// ("done ou deferred" passa). Provado (com arquivo de prova) nunca é adiado. Adiado conta como resolvido, nunca riscado.
const REQ_ADIADO_RE=/deferid|adiad|dispensad|fora de escopo|decis[aã]o (de produto|do humano|do usu[aá]rio)|via ask_human/i;
function reqIsAdiado(r){
  if(!r) return false;
  if((r.st==='ok' || r.status==='done') && Array.isArray(r.evidence) && r.evidence.length) return false;
  const s=String(r.status||''); return s==='deferred' || s==='waived' || (s==='blocked' && REQ_ADIADO_RE.test(String(r.note||'')));
}
// @adiado-puro-fim
function pathBase(p){ return String(p||'').split(/[\\/]+/).filter(Boolean).slice(-1)[0]||''; }
function pathDir(p){ const s=String(p||''); const i=Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i>0?s.slice(0,i):(i===0?s.slice(0,1):''); }
// sistema operacional do app ('mac' | 'win' | 'linux') — o updater só aplica o .app no Mac
function osKind(){
  const p=String((typeof navigator!=='undefined'&&((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||navigator.userAgent))||'');
  return /mac|iphone|ipad/i.test(p)?'mac':/win/i.test(p)?'win':'linux';
}
// base da barra de abas → --chrome-h (as views-aba são position:fixed a partir daí).
// Chamar sempre que o topo mudar de altura: render das abas, recolher/expandir sidebar.
function syncChromeH(){ const tb=$id('tabBar'); if(tb && tb.style.display!=='none') document.documentElement.style.setProperty('--chrome-h', Math.round(tb.getBoundingClientRect().bottom)+'px'); }
// Esc: digitando num campo ou com um modal aberto por cima, o Esc é DELES — não fecha a aba de trás
// @puro-dialogos-inicio (testado em app/tests/acessibilidade.test.mjs)
// UMA lista de janelas (modais) do app: o Esc é delas (escBusy) e o 54-acessibilidade.js dá role=dialog, foco preso e
// devolvido. Janela nova entra AQUI — antes o escBusy tinha a própria lista e esquecia as mais novas.
const A11Y_DIALOGS=['artOverlay','lbOverlay','sumOverlay','cmOverlay','ctOverlay','goOverlay','pubOverlay','repOverlay','txOverlay','errOverlay','prepOverlay','bdOverlay','payOverlay','kbdOverlay']; // F4: orgTplOverlay e howOverlay saíram (viraram página/aba)
// @puro-dialogos-fim
function escBusy(e){
  if(e && e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return true;
  return A11Y_DIALOGS
    .some(id=>{ const m=document.getElementById(id); return m && m.style.display && m.style.display!=='none'; });
}
// Confirmação SIM/NÃO de verdade. NÃO use window.confirm: o tauri-plugin-dialog troca ele por
// uma função async que chama 'plugin:dialog|confirm' — comando que o plugin 2.7 nem expõe (o ACL
// rejeita) — e a Promise devolvida é "truthy": todo if(confirm(...)) passava como SIM sem perguntar.
// Aqui vai direto no comando 'message' com OK/Cancelar (o mesmo que o ask/confirm do plugin usam).
async function askYes(message, title){
  const inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
  // F4 · G3: folha ancorada no botão que perguntou (52-erros: sheetAsk) — nada de diálogo nativo destoando do app
  if(typeof sheetAsk==='function'){ const t=String(message).split('\n\n'); return !!(await sheetAsk({ title:title&&title!=='Starfork'?title:t[0], text:title&&title!=='Starfork'?String(message):t.slice(1).join('\n\n'), ok:'confirmar', danger:/\b(apagar|remover|excluir|revogar|sair|descartar|interromper|limpar|tirar)\b/i.test(String(message)) })); }
  if(!inv) return window.confirm(String(message)); // preview no browser sem a folha: confirm nativo
  try{ return (await inv('plugin:dialog|message',{ message:String(message), title:title||'Starfork', kind:'warning', buttons:'OkCancel' }))==='Ok'; }
  catch(e){ console.error('askYes:', e); return false; } // na dúvida, NÃO executa
}

// ===== status: UMA fonte de verdade (nome em PT + cor + ícone) =====
// Toda tela que mostra status de tarefa/cartão usa stLabel/stColor/stIcon — nada de
// mapa próprio nem de t.status cru em inglês na tela.
// `short` = forma curta (etiqueta da barra lateral / espaço apertado) — derivada DESTE mapa, nunca inventada na tela.
// 'pr-open' é um status DERIVADO (tarefa com PR aberto no GitHub), usado pelo taskSt(t) do 22.
const STATUS_META={
  draft:        { pt:'rascunho',          short:'rascunho', c:'var(--muted)',     ic:'stQueue' },
  backlog:      { pt:'na fila',           short:'fila',     c:'var(--muted)',     ic:'stQueue' },
  requested:    { pt:'na fila',           short:'fila',     c:'var(--muted)',     ic:'stQueue' },
  queued:       { pt:'na fila',           short:'fila',     c:'var(--muted)',     ic:'stQueue' },
  'plan-review':{ pt:'plano pra aprovar', short:'plano',    c:'var(--st-ask)',    ic:'stAsk' },
  // exceção do ciclo (mesa 03/10): teto a 80%, 3ª rodada de revisão ou veredito ilegível — o motivo vem em spec.needsYou
  'needs-you':  { pt:'precisa de você',   short:'sua vez',  c:'var(--st-ask)',    ic:'stAsk' },
  running:      { pt:'rodando',           short:'rodando',  c:'var(--st-run)',    ic:'stRun' },
  thinking:     { pt:'rodando',           short:'rodando',  c:'var(--st-run)',    ic:'stRun' },
  asking:       { pt:'aguardando você',   short:'aguardando', c:'var(--st-ask)',    ic:'stAsk' },
  paused:       { pt:'pausada',           short:'pausada',  c:'var(--muted)',     ic:'stPause' },
  review:       { pt:'pronta pra revisar',short:'pra revisar', c:'var(--st-review)', ic:'stReview' },
  delivered:    { pt:'pronta pra revisar',short:'pra revisar', c:'var(--st-review)', ic:'stReview' },
  'pr-open':    { pt:'PR aberto',         short:'PR',       c:'var(--info)',      ic:'stPr' },
  done:         { pt:'concluída',         short:'concluída',c:'var(--st-done)',   ic:'stDone' },
  merged:       { pt:'integrada',         short:'integrada', c:'var(--st-done)',   ic:'stDone' },
  closed:       { pt:'concluída',         short:'concluída',c:'var(--st-done)',   ic:'stDone' },
  error:        { pt:'erro',              short:'erro',     c:'var(--st-err)',    ic:'stErr' },
  conflict:     { pt:'conflito',          short:'conflito', c:'var(--st-err)',    ic:'stErr' },
  blocked:      { pt:'bloqueada',         short:'bloqueada',c:'var(--warn)',      ic:'stBlock' },
  aborted:      { pt:'interrompida',      short:'interrompida', c:'var(--muted)',     ic:'stX' },
  cancelled:    { pt:'cancelada',         short:'cancelada',c:'var(--muted)',     ic:'stX' },
  waiting:      { pt:'na espera',         short:'espera',   c:'var(--muted)',     ic:'stQueue' },
};
function stMeta(st){ return STATUS_META[st]||{ pt:String(st||'—'), c:'var(--muted)', ic:'stQueue' }; }
function stLabel(st){ return stMeta(st).pt; }
function stColor(st){ return stMeta(st).c; }
// ícone = SVG de IC (10-core) pela chave guardada em STATUS_META.ic; é HTML: NÃO passe por esc()
function stIcon(st){ const k=stMeta(st).ic; return (typeof IC!=='undefined'&&IC[k])||''; }
function stIsBad(st){ return st==='error'||st==='conflict'; }
// selo de status padrão (mesma cara em todas as telas)
function stBadge(st){ const m=stMeta(st); return '<span class="stbadge" style="--stc:'+m.c+'"><i>'+stIcon(st)+'</i>'+m.pt+'</span>'; }

// ===== toast global: feedback curto de sucesso/aviso sem travar a tela (alert só pra erro fatal) =====
// action (opcional): { label, fn } vira um botão no próprio toast (ex.: "abrir Ambiente");
// extra (opcional): segundo botão discreto (ex.: "ver detalhes" do erro cru)
function toast(msg, kind, action, extra){
  let el=$id('appToast'); if(!el){ el=document.createElement('div'); el.id='appToast'; document.body.appendChild(el); }
  el.className='apptoast '+(kind||'info'); el.textContent='';
  a11yAnnounce(msg, toastUrgent(kind));
  const tx=document.createElement('span'); tx.className='apptoast-t'; tx.textContent=String(msg); el.appendChild(tx);
  // F3: some descendo (o token impede que o fade de um toast velho esconda o novo que chegou no meio)
  // (_hiding: o fade em curso; um toast novo ou o mouse em cima cancelam o fade — e o "esconder" atrasado não vale mais)
  const tok=el._tok=(el._tok||0)+1; const fading=!!el._hiding; mvToastStop(el);
  const hide=()=>{ el._hiding=true; const go=()=>{ if(el._tok===tok && el._hiding){ el._hiding=false; el.style.display='none'; } }; if(typeof mvToast==='function') mvToast(el, true).then(go); else go(); };
  const btns=[action, extra].filter(a=>a && a.label && typeof a.fn==='function');
  if(btns.length){ const row=document.createElement('div'); row.className='apptoast-acts';
    btns.forEach((a,i)=>{ const b=document.createElement('button'); b.type='button'; b.className='apptoast-btn'+(i?' ghost':''); b.textContent=a.label;
      b.onclick=(ev)=>{ ev.stopPropagation(); hide(); try{ const r=a.fn(); if(r&&r.catch) r.catch(err=>console.warn('toast action', err)); }catch(err){ console.warn('toast action', err); } };
      row.appendChild(b); });
    el.appendChild(row); }
  const was=el.style.display==='block' && !fading; el.style.display='block'; clearTimeout(el._t);
  if(!was && typeof mvToast==='function') mvToast(el); // F3: sobe ao aparecer (inclusive por cima de um que sumia)
  // com botão, dá tempo de ler e clicar; o mouse em cima segura o toast
  const ms=btns.length?12000:(kind==='err'?7000:4200);
  el._t=setTimeout(hide, ms);
  el.onmouseenter=()=>{ clearTimeout(el._t); if(el._hiding) mvToastStop(el); }; el.onmouseleave=()=>{ clearTimeout(el._t); el._t=setTimeout(hide, 4000); };
}
// para o fade de saída em curso (e o "esconder" que viria no fim dele)
function mvToastStop(el){ el._hiding=false; try{ if(el.getAnimations) el.getAnimations().forEach(a=>a.cancel()); }catch(_){ } }
window.toast=toast;
// R8 a11y: DUAS regiões vivas fixas (criadas uma vez, sempre no DOM — trocar o role de um nó não é anunciado de forma
// confiável). Erro e aviso (warn = algo foi barrado, ex.: "não dá pra aprovar: …" do chkBlockWhy) vão pro alert; o resto, status.
// @puro-toast-inicio
function toastUrgent(kind){ return kind==='err' || kind==='warn'; }
// @puro-toast-fim
function a11yAnnounce(msg, urgent){
  const mk=(id, role)=>{ let r=$id(id); if(!r){ r=document.createElement('div'); r.id=id; r.className='a11y-live'; r.setAttribute('role', role); r.setAttribute('aria-live', role==='alert'?'assertive':'polite'); document.body.appendChild(r); } return r; };
  const st=mk('a11yLiveStatus','status'), al=mk('a11yLiveAlert','alert');
  const r=urgent?al:st; r.textContent=''; setTimeout(()=>{ r.textContent=String(msg); }, 30); // limpar e repor: repetir a mesma frase também é anunciado
}

// ===== catálogo de erros pt-BR com AÇÃO (mesa de produto, votado pelas 5 personas) =====
// Erro cru do Rust/gh/git/claude CLI/rede/Supabase/Tauri → { msg em pt-BR, action?:{label,fn} }.
// UMA regra pra todo o app: showErr(e, 'Falha ao pausar') no lugar de alert('Falha…'+e).
function errText(e){
  if(e==null) return '';
  if(typeof e==='string') return e;
  if(e.message) return String(e.message);
  try{ const j=JSON.stringify(e); return j==='{}'?String(e):j; }catch(_){ return String(e); }
}
// 1ª linha útil do erro cru, sem "Error:"/"fatal:" na frente e curta (vai no toast)
function errFirstLine(raw){
  const ln=String(raw||'').split(/\r?\n/).map(s=>s.replace(/^\s*(uncaught\s+)?(error|erro|fatal|warning)\s*:\s*/i,'').trim()).find(Boolean)||'';
  return ln.length>140 ? ln.slice(0,137)+'…' : ln;
}
// ações do catálogo: abrem a tela que resolve (nada de "vá em Configurações" sem botão)
const ERR_ACTIONS={
  env:     ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('verificacao'); else if(window.openTab) window.openTab('env'); },
  github:  ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('github'); else if(window.openTab) window.openTab('env'); },
  gitinit: ()=>{ if(typeof gitGate==='function') return gitGate(); },
  publish: ()=>{ if(typeof publishGithub==='function') return publishGithub(); },
  conta:   ()=>{ if(typeof auShow==='function' && typeof SB!=='undefined' && !SB.sess()) auShow('login'); else if(typeof ajustesOpen==='function') ajustesOpen('perfil'); else if(window.openTab) window.openTab('conta'); },
  suaia:   ()=>{ if(window.suaIaOpenCfg) window.suaIaOpenCfg(); else if(window.openTab) window.openTab('cfg'); },
  // wt-gone: abre a conversa da tarefa aberta (mandar uma mensagem recria a cópia) e põe o foco na caixa
  conversa:()=>{ if(typeof fwTask!=='undefined' && fwTask && typeof renderWorkspace==='function'){ fwMode='conversa'; renderWorkspace(); setTimeout(()=>{ if(typeof fwFocusTalk==='function'){ fwFocusTalk(); return; } const i=document.getElementById('fwInput'); if(i) i.focus(); },60); } }, // compositor escondido (terminal integrado): o foco vai pro terminal
};
// ORDEM importa: o primeiro que casa vence (ex.: "'origin' does not appear… Could not read from remote"
// é SEM REMOTE, não rede; "Permission denied (publickey)… Could not read from remote" é permissão).
const ERR_CATALOG=[
  // antes do gh-auth: a frase orienta com "gh auth switch/login" e casaria lá
  { id:'gh-no-access', re:/^GH_NO_ACCESS:|could not resolve to a repository/i,
    msg:'A conta logada no GitHub (gh) não tem acesso a este repositório — troque pra conta certa (gh auth switch) ou entre com ela (gh auth login).', act:'github', label:'abrir GitHub (Ajustes)' },
  // wt-gone ANTES dos *-missing: spawn com a pasta da tarefa apagada também dá ENOENT/os error 2
  { id:'wt-gone', re:/c[óo]pia de trabalho desta tarefa n[ãa]o existe mais|worktree[^\n]{0,200}(os error 2\b|no such file|ENOENT)|(os error 2\b|no such file|ENOENT)[^\n]{0,200}worktree/i,
    msg:'A cópia de trabalho desta tarefa já foi limpa — mande uma mensagem na conversa da tarefa pra retomá-la (ela é recriada).', act:'conversa', label:'abrir a conversa' },
  // IA auxiliar plural (Claude, Codex ou gateway — app/src-tauri/src/ai_once.rs): ANTES do claude-login, que casaria
  // no "invalid api key" entre parênteses e mandaria quem usa Codex/gateway fazer login no Claude
  { id:'ai-none', re:/nenhuma ia dispon[ií]vel/i,
    msg:'Nenhuma IA disponível neste computador — instale o Claude Code ou o Codex, configure um gateway da sua empresa, ou use o DeepSeek Harness (beta).', act:'suaia', label:'escolher a IA' },
  // DeepSeek Harness (beta) — mensagens do motor/auxiliar (src/engine/dsh.ts, ai_once.rs). A da CHAVE antes de tudo
  // que casaria "api key"/"401" (claude-login) — quem usa DeepSeek não precisa de login no Claude
  { id:'dsh-key', re:/falta a chave da deepseek|DEEPSEEK_API_KEY/i,
    msg:'Falta a chave da DeepSeek (ou ela foi recusada) — adicione/confira a DEEPSEEK_API_KEY em Ajustes › IA e modelos.', act:'suaia', label:'abrir IA e modelos' },
  { id:'dsh-missing', re:/deepseek harness \(dsh\) n[aã]o est[aá] instalado|spawn dsh ENOENT|n[aã]o consegui rodar o deepseek harness/i,
    msg:'O DeepSeek Harness (beta) não está instalado — npm i -g @deepseek-ai/dsh.', act:'env', label:'ver como instalar (Verificação)' },
  { id:'dsh-node', re:/deepseek harness precisa do node/i,
    msg:'O DeepSeek Harness precisa do Node 22.19+ ou 24+ — atualize o Node.', act:'env', label:'abrir Verificação' },
  { id:'dsh-timeout', re:/o deepseek n[aã]o respondeu a tempo/i,
    msg:'O DeepSeek não respondeu a tempo — tente de novo.' },
  { id:'dsh-quota', re:/o deepseek est[aá] sem saldo/i,
    msg:'O DeepSeek está sem saldo/limite no momento — confira a conta na DeepSeek e tente de novo.' },
  { id:'dsh-network', re:/o deepseek n[aã]o conseguiu falar com a api/i,
    msg:'O DeepSeek não conseguiu falar com a API — cheque a internet/VPN e tente de novo.' },
  // o motor só diz "não foi encontrado" quando o resolvedor único (bin-resolve.ts ≡ resolve_tool) não achou em LUGAR
  // NENHUM — a mensagem dele traz a lista de onde procurou (ver detalhes)
  { id:'codex-missing', re:/o codex n[aã]o est[aá] instalado|o codex n[aã]o foi encontrado neste computador|n[aã]o consegui rodar o codex|spawn codex ENOENT/i,
    msg:'O Codex não foi encontrado neste computador (procurei no PATH, nvm, volta, asdf, fnm, npm, Homebrew e no app do ChatGPT).', act:'env', label:'ver como instalar (Verificação)' },
  // achou o binário mas ele não iniciou (shim do npm sem node, sem permissão…)
  { id:'codex-broken', re:/o codex foi encontrado[^\n]{0,300}(mas|precisa do node)|n[aã]o consegui iniciar o codex/i,
    msg:'O Codex está instalado, mas não consegui iniciá-lo — reinstale com npm i -g @openai/codex e rode de novo.', act:'env', label:'abrir Verificação' },
  { id:'codex-timeout', re:/o codex n[aã]o respondeu a tempo/i,
    msg:'O Codex não respondeu a tempo — tente de novo.' },
  { id:'codex-quota', re:/o codex est[aá] sem cota|o codex bateu o limite de uso/i,
    msg:'O Codex está sem cota/limite no momento — espere um pouco e tente de novo.' },
  { id:'codex-network', re:/o codex n[aã]o conseguiu falar com a openai|caiu a conex[aã]o do codex/i,
    msg:'O Codex não conseguiu falar com a OpenAI — cheque a internet/VPN e tente de novo.' },
  // chats fora do Claude (ai_once::chat_turn): a sessão sumiu e não deu pra seguir com o histórico (o normal é o
  // aiCallResumeSafe resolver sozinho — isto só aparece se nem o histórico existir)
  { id:'ai-session-lost', re:/\bsession not found — a conversa anterior/i,
    msg:'A conversa anterior não pode ser retomada nesta IA — envie de novo (o app continua com o histórico) ou toque em "+ novo".' },
  { id:'codex-empty', re:/o codex terminou sem resposta/i,
    msg:'O Codex terminou sem resposta — tente de novo.' },
  { id:'codex-session', re:/a sess[aã]o anterior do codex n[aã]o foi encontrada/i,
    msg:'A sessão anterior do Codex não existe mais neste computador — mande a mensagem de novo: ele recomeça um turno novo a partir do que já está na worktree.' },
  { id:'codex-context', re:/a conversa ficou longa demais pro codex/i,
    msg:'A conversa ficou longa demais pro Codex — rode de novo (ele recomeça com o que já está na worktree) ou divida o pedido.' },
  { id:'codex-exit', re:/o codex parou com um erro|o codex encerrou sem concluir o turno/i,
    msg:'O Codex parou no meio do turno — mande uma mensagem pra ele seguir de onde parou, ou rode de novo.' },
  { id:'dsh-empty', re:/o deepseek terminou sem resposta/i,
    msg:'O DeepSeek terminou sem resposta — tente de novo.' },
  { id:'gateway-unreachable', re:/n[aã]o consegui falar com o gateway/i,
    msg:'Não consegui falar com o gateway da sua empresa — cheque a URL em Ajustes › IA da sua empresa e a internet/VPN.', act:'suaia', label:'abrir IA e modelos' },
  { id:'gateway-truncated', re:/resposta do gateway foi cortada/i,
    msg:'A resposta do gateway foi cortada (limite de tokens) — peça algo menor ou aumente o limite no gateway.' },
  { id:'gateway-empty', re:/o gateway devolveu uma resposta vazia|o gateway n[aã]o respondeu|sem resposta do gateway/i,
    msg:'O gateway não devolveu resposta — tente de novo; se continuar, confira o modelo em Ajustes › IA da sua empresa.', act:'suaia', label:'abrir IA e modelos' },
  // só a falha REAL de autenticação do Codex (a mensagem que o ai_once monta), não qualquer menção a "codex login"
  { id:'codex-login', re:/o codex est[aá] sem login\/chave|o codex n[aã]o est[aá] logado/i,
    msg:'O Codex está sem login/chave — rode `codex login` num terminal ou configure a chave OpenAI em Ajustes › IA e modelos.', act:'suaia', label:'abrir IA e modelos' },
  { id:'gateway-key', re:/o gateway recusou a chave/i,
    msg:'O gateway da sua empresa recusou a chave — confira URL, chave e modelo em Ajustes › IA da sua empresa.', act:'suaia', label:'abrir IA e modelos' },
  { id:'claude-missing', re:/spawn claude ENOENT|claude:?\s*(command )?not found|command not found: claude\b|n[aã]o (encontrei|achei) o (bin[aá]rio do )?claude|claude (code )?n[aã]o (est[aá] )?instalado|claude[^\n]{0,40}ENOENT|falha ao rodar claude:[^\n]{0,120}(os error 2\b|no such file or directory|program not found|cannot find the file)/i,
    msg:'O Claude Code não está instalado neste computador.', act:'env', label:'ver como instalar (Verificação)' },
  { id:'claude-login', re:/please run \/login|run \/login|invalid api key|not logged in|n[aã]o est[aá] logado no claude|authentication_error|oauth token (has )?expired|oauth session expired|failed to authenticate|login do claude( code)? expirou|claude auth login|x-api-key/i,
    msg:'O Claude Code precisa de login (ou o login expirou) — abra um terminal, rode `claude` e digite /login (ou `claude auth login`), depois envie de novo.', act:'env', label:'abrir Verificação' },
  { id:'gh-missing', re:/spawn gh ENOENT|\bgh:?\s*(command )?not found(?!\s*\(HTTP)|command not found: gh\b|gh n[aã]o (est[aá] )?instalado|github cli n[aã]o|(gh indispon[ií]vel|sem resposta do GitHub \(gh\)|^gh):[^\n]{0,120}(os error 2\b|no such file or directory|program not found|cannot find the file)/i,
    msg:'O GitHub CLI (gh) não está instalado.', act:'env', label:'ver como instalar (Verificação)' },
  { id:'git-missing', re:/spawn git ENOENT|\bgit:?\s*(command )?not found(?!\s*\(HTTP)|command not found: git\b|git n[aã]o (est[aá] )?instalado|xcrun: error: invalid active developer path|^git:[^\n]{0,120}(os error 2\b|no such file or directory|program not found|cannot find the file)/i,
    msg:'O git não está instalado (ou as ferramentas de linha de comando do Mac precisam ser reinstaladas).', act:'env', label:'ver como instalar (Verificação)' },
  { id:'gh-auth', re:/gh auth login|authentication required|not logged into any github|bad credentials|requires authentication|gh sem login|to get started with github cli/i,
    msg:'Conecte sua conta do GitHub.', act:'github', label:'abrir GitHub (Ajustes)' },
  { id:'session', re:/jwt expired|invalid jwt|sess[aã]o expirou|refresh[_ ]token/i,
    msg:'Sua sessão na nuvem expirou — entre de novo na conta.', act:'conta', label:'entrar de novo' },
  { id:'not-git', re:/not a git repository|n[aã]o [eé] um reposit[oó]rio git/i,
    msg:'Esta pasta ainda não é um repositório git.', act:'gitinit', label:'criar repositório' },
  { id:'no-remote', re:/'origin' does not appear to be a git repository|no such remote|no configured push destination|does not appear to be a git repository|sem remote|no git remotes? found|none of the git remotes/i,
    msg:'Este projeto ainda não está no GitHub.', act:'publish', label:'publicar no GitHub' },
  // R8: git — mudanças locais no caminho, lock de outro git, branch/commit que não existe, PR já aberto/sem mudanças
  { id:'git-dirty', re:/local changes to the following files would be overwritten|please commit your changes or stash them|you have unstaged changes|cannot (pull|rebase) with (rebase|uncommitted)|your index contains uncommitted changes/i,
    msg:'Há mudanças ainda não salvas (sem commit) que seriam sobrescritas — salve ou descarte essas mudanças e tente de novo.' },
  // nome de branch que colide com outra ("feat" x "feat/login"): "cannot lock ref … exists; cannot create"
  { id:'branch-clash', re:/cannot lock ref[^\n]*(exists; cannot create|is at [0-9a-f]+ but expected)|'refs\/heads\/[^']+' exists; cannot create/i,
    msg:'O nome da branch colide com outra que já existe (ex.: "feat" e "feat/login" não podem coexistir) — escolha outro nome.' },
  // lock sem permissão (pasta de outro usuário/protegida) não é "espere": o git-lock pula e cai no 'permission' (UM id só — antes duplicado)
  { id:'git-lock', re:/^(?![\s\S]*\.lock'?:?\s*permission denied)[\s\S]*(?:index\.lock|unable to create '[^']*\.lock'|another git process seems to be running|cannot lock ref)/i,
    msg:'Outro comando do git está rodando nesta pasta (ou travou no meio) — espere alguns segundos e tente de novo.' },
  { id:'branch-exists', re:/a branch named .{1,120} already exists|reference already exists|already exists on remote/i,
    msg:'Já existe uma branch com esse nome — escolha outro nome ou use a que já existe.' },
  { id:'git-ref', re:/invalid reference|pathspec .{1,200} did not match|unknown revision|not a valid object name|couldn'?t find remote ref|bad revision/i,
    msg:'A branch ou o commit indicado não existe mais (pode ter sido apagado ou renomeado).' },
  { id:'pr-exists', re:/a pull request for branch .{1,200} already exists/i,
    msg:'Já existe um PR aberto para esta branch.' },
  { id:'no-commits', re:/no commits between/i,
    msg:'Não há mudanças novas para abrir o PR — a branch está igual à base.' },
  { id:'nothing-to-commit', re:/nothing to commit|nada para commitar|no changes added to commit/i,
    msg:'Não há nada novo pra salvar — nenhum arquivo mudou desde o último commit.' },
  { id:'no-pr', re:/no pull requests? found for branch|no open pull requests?/i,
    msg:'Ainda não existe PR para esta branch.' },
  // R8: banco local (SQLite) — outra operação segurando o arquivo
  { id:'db-locked', re:/database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|banco (local )?(est[aá] )?(ocupado|travado)/i,
    msg:'O banco local está ocupado por outra operação do Starfork — espere alguns segundos e tente de novo.' },
  { id:'db-broken', re:/database disk image is malformed|file is not a database|SQLITE_CORRUPT/i,
    msg:'O banco local do projeto está danificado — reabra o app; se continuar, veja os detalhes.' },
  { id:'db-old', re:/no such table|no such column|has no column named/i,
    msg:'O app está desatualizado em relação aos dados deste projeto — atualize o Starfork e abra de novo.' },
  // R8: registro duplicado (Supabase/Postgres)
  { id:'duplicate', re:/duplicate key value|violates unique constraint|\b23505\b|already registered|j[aá] existe um registro/i,
    msg:'Já existe um registro igual — nada foi criado; use outro nome ou abra o existente.' },
  { id:'disk', re:/ENOSPC|no space left on device|disk (is )?full|disco (est[aá] )?cheio|os error (28|112)\b|not enough space on the disk/i,
    msg:'O disco está cheio — libere espaço e tente de novo.' },
  { id:'ai-limit', re:/rate.?limit|usage limit|\b429\b|too many requests|overloaded|quota exceeded|limite de uso|credit balance is too low|hit your limit/i,
    msg:'A IA atingiu o limite de uso agora — espere alguns minutos e tente de novo.' },
  { id:'conflict', re:/merge conflict|CONFLICT \(|automatic merge failed|conflito de merge|not possible to fast-forward|\(fetch first\)|non-fast-forward|is not mergeable|merge commit cannot be cleanly created/i,
    msg:'Deu conflito com mudanças que já estão na base — resolva o conflito (ou peça pra IA resolver) e tente de novo.' },
  { id:'cloud-permission', re:/row-level security|insufficient_privilege|\b42501\b|permission denied for (table|relation|schema|function)/i,
    msg:'Sua função na organização/time não permite isso — peça pra um admin do time fazer (ou te dar a permissão).' },
  { id:'permission', re:/permission denied|EACCES|EPERM|operation not permitted|\b403\b|forbidden|protected branch|write access .* not granted|must have (admin|push) (rights|access)|resource not accessible|access is denied|os error (5|13)\b/i,
    msg:'Sem permissão pra essa ação (arquivo protegido ou conta sem acesso ao repositório).' },
  // R8: arquivo em uso (Windows os error 32 / EBUSY)
  { id:'file-busy', re:/EBUSY|resource busy|os error (16|32|33)\b|being used by another process|text file busy/i,
    msg:'O arquivo está em uso por outro programa — feche esse programa e tente de novo.' },
  // R8: arquivo/pasta que sumiu (depois de claude/gh/git-missing, que também são ENOENT)
  { id:'not-found', re:/no such file or directory|ENOENT|os error 2\b|cannot find the (file|path) specified[^\n]*|the system cannot find|n[aã]o encontrad[oa]: \//i,
    msg:'Arquivo ou pasta não encontrado — pode ter sido movido, renomeado ou apagado.' },
  // A14 (mesa de bugs 2): 413 = o servidor recusou pelo TAMANHO (antes caía em "sem conexão" pelo "upload failed")
  { id:'too-large', re:/\bHTTP[ /]?413\b|status(?: ?code)?"?:? ?"?413\b|\b413 payload|payload too large|request entity too large|entity too large/i,
    msg:'O arquivo é grande demais pro servidor aceitar (HTTP 413) — reempacote menor ou peça pra aumentar o limite do armazenamento.' },
  // R8: servidor com problema (5xx) ≠ sem internet
  { id:'server', re:/\bHTTP[ /]?5\d\d\b|status(?: code)?:? ?5\d\d\b|\b50[0234] (internal|bad|service|gateway)|internal server error|bad gateway|service unavailable|gateway time-?out|PGRST00[0-3]/i,
    msg:'O servidor está com problema agora — tente de novo em alguns minutos.' },
  // R8: resposta num formato inesperado (JSON quebrado/cortado)
  { id:'bad-json', re:/^(?![\s\S]*invalid args)[\s\S]*(?:unexpected token .{0,40}(in json|is not valid json)|is not valid json|unexpected end of json|json\.parse: |json parse error|expected value at line|eof while parsing|invalid json|json inv[aá]lido|trailing characters at line)/i,
    msg:'A resposta veio num formato inesperado — tente de novo; se repetir, veja os detalhes.' },
  { id:'network', re:/failed to fetch|load failed|networkerror|network is unreachable|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|could not resolve host|couldn'?t resolve|temporary failure in name resolution|\boffline\b|sem conex[aã]o|unable to access|failed to connect|could not read from remote|connection (refused|reset|closed)|EAI_AGAIN|EHOSTUNREACH|dns error|error sending request|tempo esgotado|demorou demais|os error (60|61|65|10060|10061)\b/i,
    msg:'Sem conexão agora — cheque a internet/VPN e tente de novo.' },
];
// ctx (opcional): o que se tentava fazer ("Falha ao abrir o PR") — vira o prefixo da mensagem
function humanErr(e, ctx){
  const txt=errText(e);
  const raw=(e&&typeof e==='object'&&e.raw!=null)?String(e.raw):txt; // {message:traduzido, raw:original}: a tela usa o texto, "ver detalhes" o original
  const pre=ctx?String(ctx).replace(/[\s:.…]+$/,''):'';
  const hit=ERR_CATALOG.find(c=>c.re.test(txt));
  if(hit){
    const action=(hit.act && ERR_ACTIONS[hit.act]) ? { label:hit.label, fn:ERR_ACTIONS[hit.act] } : null;
    return { id:hit.id, msg:(pre?pre+' — ':'')+hit.msg, action, raw };
  }
  const first=errFirstLine(txt)||'erro sem detalhe';
  return { id:'generic', msg:(pre||'Algo deu errado')+': '+first, action:null, raw };
}
// detalhes do erro cru (recolhido): pra quem quer ver/copiar o que o sistema disse
function errDetails(h){
  if(typeof errTabOpen==='function'){ errTabOpen(h); return; } // F4 · G3: aba "Detalhes do erro", não modal
  document.getElementById('errOverlay')?.remove();
  const ov=document.createElement('div'); ov.id='errOverlay';
  ov.style.cssText='position:fixed;inset:0;z-index:10000;background:var(--scrim);display:flex;align-items:center;justify-content:center;padding:16px';
  const box=document.createElement('div');
  box.style.cssText='background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;max-width:620px;width:100%;padding:16px 18px;box-shadow:var(--shadow);color:var(--text)';
  const t=document.createElement('div'); t.style.cssText='font-size:var(--fs-base);font-weight:600;margin-bottom:8px'; t.textContent=h.msg;
  const pre=document.createElement('pre'); pre.className='mono'; pre.style.cssText='white-space:pre-wrap;word-break:break-word;font-size:var(--fs-xs);max-height:280px;overflow:auto;background:var(--surface-2);border-radius:8px;padding:10px;margin:0;color:var(--text-2)'; pre.textContent=h.raw||'(sem detalhe)';
  const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
  const cp=document.createElement('button'); cp.className='btn sm'; cp.textContent='copiar'; cp.onclick=()=>{ try{ navigator.clipboard.writeText(h.raw||''); cp.textContent='copiado ✓'; }catch(_){ } };
  const ok=document.createElement('button'); ok.className='btn primary sm'; ok.textContent='fechar'; ok.onclick=()=>ov.remove();
  if(h.action){ const a=document.createElement('button'); a.className='btn sm'; a.textContent=h.action.label; a.onclick=()=>{ ov.remove(); h.action.fn(); }; row.appendChild(a); }
  row.appendChild(cp); row.appendChild(ok);
  box.appendChild(t); box.appendChild(pre); box.appendChild(row); ov.appendChild(box);
  ov.addEventListener('click', ev=>{ if(ev.target===ov) ov.remove(); });
  ov.addEventListener('keydown', ev=>{ if(ev.key==='Escape') ov.remove(); });
  document.body.appendChild(ov); ok.focus();
}
// mostra o erro traduzido num toast com o botão que resolve (+ "ver detalhes" com o texto cru)
function showErr(e, ctx){
  const h=humanErr(e, ctx);
  console.warn('[erro]', ctx||'', h.raw);
  const det={ label:'ver detalhes', fn:()=>errDetails(h) };
  toast(h.msg, 'err', h.action||det, h.action?det:null);
  return h;
}
// texto curto pra caber numa linha da tela: a frase do catálogo quando é erro conhecido, senão a 1ª linha do cru
// (sem o "Algo deu errado:" — quem chama já tem o próprio título, ex.: "não consegui gerar o diff")
function errShort(e){ const h=humanErr(e); return h.id==='generic' ? (errFirstLine(h.raw)||'erro sem detalhe') : h.msg; }
window.humanErr=humanErr; window.showErr=showErr; window.errShort=errShort;
// nº de arquivos de um diff: o backend (Rust, struct Diff) manda `files` como NÚMERO;
// versões antigas/mock mandavam lista — aceita os dois (antes saía "undefined arquivo(s)")
function diffFiles(d){ if(!d) return 0; const f=d.files; return typeof f==='number'?f:(Array.isArray(f)?f.length:0); }

// ===== custo em US$ com o equivalente em R$ (mesa 27/09: "custo antes, em R$") =====
// A cotação é a de Configurações ("cotação do dólar usada nas estimativas", padrão 5,5).
// UMA regra pra toda tela que mostra custo: fmtCost(usd) → "US$ 2,93 (≈ R$ 16,12)".
function usdBrlRate(){ const v=parseFloat(String(lsGet('usdBrl')||'').replace(',','.')); return v>0?v:5.5; }
// número no formato BR: inteiro sem casas ("5"), senão 2 casas ("27,50"); abaixo de 1 centavo, 4 casas
function fmtNumBR(v, forceDec){
  v=+v||0; const r=Math.round(v*100)/100;
  if(v>0 && v<0.01) return v.toLocaleString('pt-BR',{ minimumFractionDigits:4, maximumFractionDigits:4 });
  const dec=(forceDec||!Number.isInteger(r))?2:0;
  return r.toLocaleString('pt-BR',{ minimumFractionDigits:dec, maximumFractionDigits:dec });
}
function fmtCost(usd, opts){
  usd=+usd||0; const o=opts||{};
  const us='US$ '+fmtNumBR(usd);
  if(o.usdOnly) return us;
  return us+' (≈ R$ '+fmtNumBR(usd*usdBrlRate(), usd>0)+')';
}
// faixa de estimativa: "~US$ 2–4 (≈ R$ 11–22)" — arredonda (é previsão, não centavo)
function fmtCostRange(lo, hi){
  const rate=usdBrlRate(), big=lo>=1;
  const f=(v)=> big ? String(Math.round(v)) : fmtNumBR(v, true);
  const rs=(lo*rate>=1) ? `${Math.floor(lo*rate)}–${Math.ceil(hi*rate)}` : `${fmtNumBR(lo*rate,true)}–${fmtNumBR(hi*rate,true)}`;
  return `~US$ ${f(lo)}–${f(hi)} (≈ R$ ${rs})`;
}
// @helpers-comuns-inicio (F4: G1 cria, G2/G3 consomem — testado em app/tests/redesign-f4-g1.test.mjs)
// DINHEIRO (D13): US$ é a verdade; totais e cabeçalhos mostram "US$ 1,79 (≈ R$ 9,82)" com a MESMA cotação da barra
// de status (usdBrlRate ← Ajustes › Custo e limites). Célula de tabela: fmtUsdBr(v,{usdOnly:true}) → "US$ 1,79".
function fmtUsdBr(usd, opts){ return fmtCost(usd, opts); }
// "AGUARDANDO VOCÊ" (D14): pergunta pendente + plano pra aprovar + precisa de você + erro, conflito ou interrompida.
// "Pronta pra revisar" é contada À PARTE e nunca entra nesta soma. Lateral, Central, barra de status, Projetos,
// notificações e Time contam por AQUI (o flowBucket do 22 usa o mesmo predicado). `pend(t)` = tem pergunta aberta.
const AGUARDA_ST=['plan-review','needs-you','error','conflict','aborted'];
function taskEncerrada(t){ return !!t && (t.flag==='closed' || ['merged','done','cancelled'].includes(t.status)); }
function taskAguardaVoce(t, pend){
  if(!t || t.status==='draft' || taskEncerrada(t)) return false;
  const p = pend || (typeof pendingOf==='function' ? (x=>pendingOf(x.id).length>0) : (()=>false));
  return !!p(t) || AGUARDA_ST.includes(t.status);
}
function taskProntaRevisar(t, pend){ return !!t && !taskEncerrada(t) && !t.prUrl && ['review','delivered'].includes(t.status) && !taskAguardaVoce(t, pend); }
// tarefas VIVAS por padrão (sem encerradas; bloqueadas escondidas = mesma visibilidade da Central)
function aguardaSrc(tasks){ if(tasks) return tasks; try{ return flowLiveTasks(); }catch(_){ return (typeof state!=='undefined'&&state.tasks)||[]; } }
function aguardandoVoceCount(tasks, pend){ return aguardaSrc(tasks).filter(t=>taskAguardaVoce(t, pend)).length; }
function prontasRevisarCount(tasks, pend){ return aguardaSrc(tasks).filter(t=>taskProntaRevisar(t, pend)).length; }
// escape de atributo/texto dos helpers de página (independe do escA do 33 — mesmo resultado, sempre seguro)
function phEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// attrs da ação primária: pares { nome:valor } (escapados; nome só [a-z0-9-]) — nunca HTML cru
function phAttrs(a){ return Object.keys(a||{}).filter(k=>/^[a-z][a-z0-9-]*$/i.test(k)).map(k=>` ${k}="${phEsc(a[k])}"`).join(''); }
// PADRÃO DE PÁGINA (D25, mesa-ia §6): UM cabeçalho pra toda aba que não é Tarefa. Título (= título da aba) · selo de
// escopo ("pra quem vale") · resumo de 1 linha · no máximo 1 ação primária · ⋯ · subtítulo de 1 linha · abas/visões.
// Sem X nem "fechar esc" (⌘W fecha a aba). `scope`: 'projeto'|'computador'|'conta'|'org'|'time' + `scopeLabel`,
// ou texto livre. `sum`/`right`/`tabs` são HTML (já escapado por quem chama); `title`/`sub`/rótulos são texto.
const PH_SCOPE={ projeto:['folder','Este projeto'], computador:['pc','Este computador'], conta:['user','Sua conta'], org:['team','Organização'], time:['team','Time'] };
function pageHead(o){
  o=o||{}; const E=phEsc;
  const icn=(k)=>(typeof IC!=='undefined'&&IC[k])||'';
  const sc=o.scope ? (PH_SCOPE[o.scope]||[o.scopeIcon||'folder', o.scope]) : null;
  const scLabel=sc ? (o.scopeLabel ? (PH_SCOPE[o.scope] ? sc[1]+' · '+o.scopeLabel : o.scopeLabel) : sc[1]) : '';
  const p=o.primary;
  const prim=p ? `<button class="btn primary pgh-primary"${p.id?` id="${E(p.id)}"`:''}${p.title?` title="${E(p.title)}"`:''}${phAttrs(p.attrs)}>${p.icon?icn(p.icon):''}${E(p.label)}</button>` : '';
  const m=o.more; const more=m ? `<button class="btn icon quiet pgh-more"${m.id?` id="${E(m.id)}"`:''} title="${E(m.title||'Mais ações')}" aria-label="${E(m.title||'Mais ações')}" aria-haspopup="menu">${icn('dots')}</button>` : '';
  return `<header class="pghead"${o.id?` id="${E(o.id)}"`:''}><div class="pgh-t"><h1 class="pgh-title">${E(o.title||'')}</h1>`
    + (sc?`<span class="pgh-scope" title="Pra quem vale o que está nesta página">${icn(sc[0])}${E(scLabel)}</span>`:'')
    + (o.money?`<span class="pgh-money">${o.money}</span>`:'') // gasto/teto: nunca encolhe nem some (B3) — a linha quebra antes
    + (o.sum?`<span class="pgh-sum">${o.sum}</span>`:'') + `<span class="pgh-sp"></span>${o.right||''}${prim}${more}</div>`
    + (o.sub?`<p class="pgh-sub">${E(o.sub)}</p>`:'') + (o.tabs||'') + `</header>`;
}
// abas horizontais (visões do mesmo dado) no padrão da página: [[chave, rótulo, contagem?, quente?]], role=tablist
function pageTabs(set, items, act){
  const E=phEsc;
  return `<div class="pgtabs" role="tablist" data-pgtabs="${E(set)}">`+items.map(([k,l,n,hot])=>`<button role="tab" class="${k===act?'on':''}${hot?' hot':''}" aria-selected="${k===act}" tabindex="${k===act?0:-1}" data-pgtab="${E(set)}:${E(k)}">${E(l)}${n!=null&&n!==''?` <b>${E(String(n))}</b>`:''}</button>`).join('')+`</div>`;
}
// DINHEIRO DIGITADO (G2, F4): UM parser pra todo campo de teto/valor em US$. "2,5" e "2.5" → 2,5; "1.000" → 1000;
// "1.234,50" → 1234,5; "US$ 40" → 40. Vazio → null; lixo → NaN. Já arredonda nos centavos (valida o que vai ser gravado).
function parseUsd(v){
  let b=String(v==null?'':v).trim().replace(/^US\$\s*/i,'').replace(/\s/g,'');
  if(!b) return null;
  if(b.includes(',')) b=b.replace(/\./g,'').replace(',','.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(b)) b=b.replace(/\./g,'');
  if(!/^-?\d*\.?\d+$/.test(b)) return NaN;
  return Math.round(Number(b)*100)/100;
}
// @helpers-comuns-fim
// teto padrão por tarefa (US$; 0 = sem teto) — Configurações
// teto SEMPRE ligado (veto da Carla, mesa 03/10): 0/vazio/lixo valem o padrão US$ 5 — nunca "sem teto"
function costCapDefault(){ const raw=lsGet('costCap'); const v=parseFloat(raw==null||raw===''?'5':String(raw).replace(',','.')); return v>0?v:5; }
// IA PADRÃO do usuário (painel Sua IA → aiDefaults em 29-ia-picker) pra demanda criada SEM motor escolhido
// (mesa, card do time, celular, orquestrador). Antes esses caminhos gravavam 'claude' fixo — quem só usa Codex
// ganhava tarefa no Claude. O 'claude' daqui só vale se o seletor ainda não carregou (boot/teste isolado).
function defaultAiEngine(){ try{ return (typeof aiDefaults==='function' && aiDefaults().eng) || 'claude'; }catch(_){ return 'claude'; } }
function defaultAiModel(){ try{ return (typeof aiDefaults==='function' && aiDefaults().model) || null; }catch(_){ return null; } }
