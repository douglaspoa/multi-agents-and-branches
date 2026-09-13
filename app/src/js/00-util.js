// ===== utilitários compartilhados (carrega ANTES de tudo) =====
// atalhos de DOM: $id no lugar de document.getElementById; bindClick() liga um handler só se o elemento existir
function $id(id){ return document.getElementById(id); }
function bindClick(id, fn, ev){ const el=$id(id); if(el) el[ev||'onclick']=fn; return el; }
// localStorage tolerante (webview em modo privado / sem permissão não derruba o app)
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
// base da barra de abas → --chrome-h (as views-aba são position:fixed a partir daí).
// Chamar sempre que o topo mudar de altura: render das abas, recolher/expandir sidebar.
function syncChromeH(){ const tb=$id('tabBar'); if(tb && tb.style.display!=='none') document.documentElement.style.setProperty('--chrome-h', Math.round(tb.getBoundingClientRect().bottom)+'px'); }
