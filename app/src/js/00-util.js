// ===== utilitários compartilhados (carrega ANTES de tudo) =====
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
function bindClick(id, fn, ev){ const el=$id(id); if(el) el[ev||'onclick']=fn; return el; }
// localStorage tolerante (webview em modo privado / sem permissão não derruba o app)
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
// base da barra de abas → --chrome-h (as views-aba são position:fixed a partir daí).
// Chamar sempre que o topo mudar de altura: render das abas, recolher/expandir sidebar.
function syncChromeH(){ const tb=$id('tabBar'); if(tb && tb.style.display!=='none') document.documentElement.style.setProperty('--chrome-h', Math.round(tb.getBoundingClientRect().bottom)+'px'); }
// Esc: digitando num campo ou com um modal aberto por cima, o Esc é DELES — não fecha a aba de trás
function escBusy(e){
  if(e && e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return true;
  return ['artOverlay','lbOverlay','askOverlay','sumOverlay','cmOverlay','ctOverlay','goOverlay','pubOverlay','orgTplOverlay','repOverlay','txOverlay']
    .some(id=>{ const m=document.getElementById(id); return m && m.style.display && m.style.display!=='none'; });
}
// Confirmação SIM/NÃO de verdade. NÃO use window.confirm: o tauri-plugin-dialog troca ele por
// uma função async que chama 'plugin:dialog|confirm' — comando que o plugin 2.7 nem expõe (o ACL
// rejeita) — e a Promise devolvida é "truthy": todo if(confirm(...)) passava como SIM sem perguntar.
// Aqui vai direto no comando 'message' com OK/Cancelar (o mesmo que o ask/confirm do plugin usam).
async function askYes(message, title){
  const inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
  if(!inv) return window.confirm(String(message)); // preview no browser: confirm nativo
  try{ return (await inv('plugin:dialog|message',{ message:String(message), title:title||'Starfork', kind:'warning', buttons:'OkCancel' }))==='Ok'; }
  catch(e){ console.error('askYes:', e); return false; } // na dúvida, NÃO executa
}

// ===== status: UMA fonte de verdade (nome em PT + cor + ícone) =====
// Toda tela que mostra status de tarefa/cartão usa stLabel/stColor/stIcon — nada de
// mapa próprio nem de t.status cru em inglês na tela.
const STATUS_META={
  draft:        { pt:'rascunho',          c:'var(--muted)',     ic:'·' },
  backlog:      { pt:'na fila',           c:'var(--muted)',     ic:'·' },
  queued:       { pt:'na fila',           c:'var(--muted)',     ic:'·' },
  'plan-review':{ pt:'plano pra aprovar', c:'var(--st-ask)',    ic:'?' },
  running:      { pt:'rodando',           c:'var(--st-run)',    ic:'●' },
  thinking:     { pt:'pensando',          c:'var(--st-run)',    ic:'●' },
  asking:       { pt:'precisa de você',   c:'var(--st-ask)',    ic:'?' },
  paused:       { pt:'pausada',           c:'var(--muted)',     ic:'❚❚' },
  review:       { pt:'pronta pra revisar',c:'var(--st-review)', ic:'◆' },
  delivered:    { pt:'pronta pra revisar',c:'var(--st-review)', ic:'◆' },
  done:         { pt:'concluída',         c:'var(--st-done)',   ic:'✓' },
  merged:       { pt:'mergeada',          c:'var(--st-done)',   ic:'✓' },
  closed:       { pt:'concluída',         c:'var(--st-done)',   ic:'✓' },
  error:        { pt:'erro',              c:'var(--st-err)',    ic:'!' },
  conflict:     { pt:'conflito',          c:'var(--st-err)',    ic:'!' },
  blocked:      { pt:'bloqueada',         c:'var(--warn)',      ic:'⏸' },
  aborted:      { pt:'abortada',          c:'var(--muted)',     ic:'×' },
  cancelled:    { pt:'cancelada',         c:'var(--muted)',     ic:'×' },
  waiting:      { pt:'na espera',         c:'var(--muted)',     ic:'·' },
};
function stMeta(st){ return STATUS_META[st]||{ pt:String(st||'—'), c:'var(--muted)', ic:'·' }; }
function stLabel(st){ return stMeta(st).pt; }
function stColor(st){ return stMeta(st).c; }
function stIcon(st){ return stMeta(st).ic; }
function stIsBad(st){ return st==='error'||st==='conflict'; }
// selo de status padrão (mesma cara em todas as telas)
function stBadge(st){ const m=stMeta(st); return '<span class="stbadge" style="--stc:'+m.c+'"><i>'+m.ic+'</i>'+m.pt+'</span>'; }

// ===== toast global: feedback curto de sucesso/aviso sem travar a tela (alert só pra erro fatal) =====
function toast(msg, kind){
  let el=$id('appToast'); if(!el){ el=document.createElement('div'); el.id='appToast'; el.setAttribute('role','status'); document.body.appendChild(el); }
  el.className='apptoast '+(kind||'info'); el.textContent=String(msg);
  el.style.display='block'; clearTimeout(el._t); el._t=setTimeout(()=>{ el.style.display='none'; }, kind==='err'?7000:4200);
}
window.toast=toast;
