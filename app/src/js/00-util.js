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
  if(/load failed|failed to fetch|networkerror|network|timeout|timed out|expirou|offline|abort/i.test(m)) return;
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
  try{ return (await inv('plugin:dialog|message',{ message:String(message), title:title||'Constellation', kind:'warning', buttons:'OkCancel' }))==='Ok'; }
  catch(e){ console.error('askYes:', e); return false; } // na dúvida, NÃO executa
}
