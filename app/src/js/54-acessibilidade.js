// ===== R8 acessibilidade: janelas (modais) e abas-overlay pelo teclado e pelo leitor de tela =====
// Uma regra só pro app inteiro, sem mexer em cada tela:
//  - janela (modal, lista A11Y_DIALOGS em 00-util.js): role=dialog + aria-modal + nome (o título da própria janela);
//    ao abrir, o foco entra nela (na ação MENOS destrutiva); Tab/⇧Tab ficam presos dentro; ao fechar, o foco VOLTA
//    pro elemento que abriu (antes caía no <body> e o próximo Tab recomeçava do topo do app).
//  - aba-overlay (Skills, Configurações, Tarefa…): role=region com o nome da aba. Não prende o foco (a barra de
//    abas e a lateral continuam alcançáveis) e, ao sumir, só leva o foco pra aba ativa se ele se perdeu.
//  - painel de atalhos: tecla ? (fora de campo de texto) ou ⌘/ — lista SHORTCUTS (15-config-abas-onboarding.js).
// @puro-a11y-inicio (testado em app/tests/acessibilidade.test.mjs — sem DOM)
// nome da janela quando ela não tem título visível
const A11Y_NAMES={ lbOverlay:'provas (prints)', goOverlay:'colocando no ar', errOverlay:'detalhes do erro', payOverlay:'assinatura', kbdOverlay:'atalhos do teclado' };
// próximo índice do Tab preso: dá a volta nas pontas; foco fora da lista → primeiro (ou último com ⇧)
function a11yWrapIndex(n, cur, back){
  if(!(n>0)) return -1;
  if(cur<0 || cur>=n) return back?n-1:0;
  return back ? (cur-1+n)%n : (cur+1)%n;
}
// ? abre o painel só quando não se está digitando; ⌘/ (ou Ctrl+/) abre de qualquer lugar
function a11yIsHelpKey(e, typing){
  if(!e) return false;
  if((e.metaKey||e.ctrlKey) && !e.altKey && e.key==='/') return true;
  return e.key==='?' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing;
}
// botão "seguro" pro foco inicial: cancelar/fechar/não/voltar/ok — nunca a ação destrutiva
const A11Y_SAFE_RE=/^(cancelar|fechar|não|nao|voltar|agora não|depois|ok)\b/i;
const A11Y_DANGER_RE=/(excluir|apagar|remover|descartar|sair|deletar|abortar|parar)/i;
// escolhe o índice do foco inicial numa janela: campo de texto → botão seguro → 1º botão comum que não seja
// perigoso/primário → o X → o primeiro. items: [{tag, text, id, cls}]
function a11yPickInitial(items){
  const it=items||[]; if(!it.length) return -1;
  const at=(fn)=>it.findIndex(fn);
  const isX=x=>/\bx\b/.test(x.cls||'') || /close$/i.test(x.id||'');
  const isField=x=>/^(INPUT|TEXTAREA|SELECT)$/.test(x.tag);
  let i=at(isField); if(i>=0) return i;
  i=at(x=>!isX(x) && (A11Y_SAFE_RE.test(String(x.text||'').trim()) || /(cancel|close)$/i.test(x.id||''))); if(i>=0) return i;
  i=at(x=>!isX(x) && !/\b(primary|danger)\b/.test(x.cls||'') && !A11Y_DANGER_RE.test(x.text||'')); if(i>=0) return i;
  i=at(isX); return i>=0?i:0;
}
// @puro-a11y-fim
const A11Y_FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
function a11yShown(el){ if(!el || !el.isConnected) return false; const d=el.style.display; if(d==='none') return false; return getComputedStyle(el).display!=='none'; }
function a11yVisible(el){ return !!(el && el.getClientRects().length) && getComputedStyle(el).visibility!=='hidden'; }
function a11yFocusables(root){ return [...root.querySelectorAll(A11Y_FOCUSABLE)].filter(a11yVisible); }
function a11yTyping(t){ return !!(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)); }
function a11yTabKind(el){ if(typeof VIEW_OVERLAY==='undefined') return null; return Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===el.id)||null; }
function a11yIsDialog(el){ if(A11Y_DIALOGS.includes(el.id)) return true; const k=a11yTabKind(el); return !!(k && !el.classList.contains('astab')); } // form/agentes ainda abrem como janela em alguns fluxos
function a11yInDialog(node){ for(let n=node; n && n!==document.body; n=n.parentElement){ if(n.id && A11Y_DIALOGS.includes(n.id) && a11yShown(n)) return true; } return false; }
// o nome: o título da janela (1º <b>/h2 do cabeçalho), senão o nome fixo, senão o da aba.
// aria-labelledby apontando pra um id que não existe mais (a tela re-renderizou) → nomeia de novo
function a11yLabel(el){
  if(el.getAttribute('aria-label')) return;
  const lb=el.getAttribute('aria-labelledby');
  if(lb && document.getElementById(lb)) return;
  if(lb) el.removeAttribute('aria-labelledby');
  const h=el.querySelector('.mhead b, .mhead h2, h2, h1');
  if(h && h.textContent.trim()){ if(!h.id) h.id=el.id+'-titulo'; el.setAttribute('aria-labelledby', h.id); return; }
  const k=a11yTabKind(el); const t=A11Y_NAMES[el.id] || (k && typeof VIEW_META!=='undefined' && VIEW_META[k] && VIEW_META[k].title) || '';
  if(t) el.setAttribute('aria-label', t);
}
function a11yPrep(el){
  if(a11yIsDialog(el)){ el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); }
  else { el.setAttribute('role','region'); el.removeAttribute('aria-modal'); }
  a11yLabel(el);
}
// último elemento focado FORA de uma janela: quem abre a janela e já joga o foco lá dentro na mesma hora
// (errDetails, publicar) deixava o activeElement já dentro — o "quem abriu" vem daqui
let a11yLastOutside=null;
document.addEventListener('focusin', e=>{ const t=e.target; if(t && t!==document.body && !a11yInDialog(t)) a11yLastOutside=t; }, true);
// a janela visível de cima (a última aberta)
const a11yStack=[];
function a11yTop(){ for(let i=a11yStack.length-1;i>=0;i--){ const el=a11yStack[i].el; if(a11yShown(el) && a11yIsDialog(el)) return el; } return null; }
function a11yFocusIn(el){
  const cur=document.activeElement; if(cur!==el && el.contains(cur)) return true; // foco na PRÓPRIA caixa (esperando conteúdo) não conta
  const f=a11yFocusables(el);
  const i=a11yPickInitial(f.map(x=>({ tag:x.tagName, text:x.textContent, id:x.id, cls:String(x.className||'') })));
  if(i>=0){ f[i].focus({preventScroll:true}); return true; }
  return false;
}
// janela que ainda vai ser preenchida (depois de um invoke): tenta agora; se não há nada focável, espera o
// conteúdo chegar (observer) e tenta UMA vez — sem prazo fixo. Enquanto isso o foco fica na própria caixa.
function a11yFocusWhenReady(el){
  if(a11yFocusIn(el)) return;
  if(!el.hasAttribute('tabindex')) el.tabIndex=-1;
  el.focus({preventScroll:true});
  const mo=new MutationObserver(()=>{ if(!a11yShown(el) || a11yTop()!==el){ mo.disconnect(); return; } if(a11yFocusables(el).length){ mo.disconnect(); if(document.activeElement===el || !el.contains(document.activeElement)) a11yFocusIn(el); } });
  mo.observe(el, { childList:true, subtree:true });
  setTimeout(()=>mo.disconnect(), 15000);
}
function a11yRestore(entry){
  const a=document.activeElement;
  // só devolve se o foco ficou "perdido" (no body ou dentro do que fechou) — não rouba foco de quem já o moveu
  if(a && a!==document.body && a.isConnected && !entry.el.contains(a) && a11yVisible(a)) return;
  const back=entry.dialog ? entry.opener : null; // aba-overlay: nunca volta pro "abridor" antigo (troca de aba pelo mouse)
  if(back && back.isConnected && a11yVisible(back) && !back.closest('[aria-hidden="true"]')){ back.focus({preventScroll:true}); return; }
  const tab=document.querySelector('#tabBar .tab.on'); if(tab) tab.focus({preventScroll:true});
}
function a11yOnShow(el){
  a11yPrep(el);
  const i=a11yStack.findIndex(x=>x.el===el); if(i>=0) a11yStack.splice(i,1);
  const a=document.activeElement, dialog=a11yIsDialog(el);
  const cand=(a && a!==document.body && !el.contains(a)) ? a : a11yLastOutside;
  const entry={ el, dialog, opener:(cand && !el.contains(cand)) ? cand : null };
  a11yStack.push(entry);
  if(dialog) a11yFocusWhenReady(el);
}
function a11yOnHide(el){
  const i=a11yStack.findIndex(x=>x.el===el); if(i<0) return;
  const entry=a11yStack.splice(i,1)[0];
  setTimeout(()=>a11yRestore(entry), 0);
}
function a11yWatch(el){
  if(!el || el.__a11y) return; el.__a11y=true;
  let was=a11yShown(el); a11yPrep(el); if(was) a11yOnShow(el);
  new MutationObserver(()=>{ const now=a11yShown(el); if(now===was){ if(now) a11yPrep(el); return; } was=now; if(now) a11yOnShow(el); else a11yOnHide(el); })
    .observe(el, { attributes:true, attributeFilter:['style','class'] });
}
function a11yWatchAll(){
  const ids=new Set(A11Y_DIALOGS); if(typeof VIEW_OVERLAY!=='undefined') Object.values(VIEW_OVERLAY).forEach(id=>ids.add(id));
  ids.forEach(id=>{ const el=document.getElementById(id); if(el) a11yWatch(el); });
}
a11yWatchAll();
// janelas criadas na hora (detalhes do erro, atalhos): entram e saem do <body>
new MutationObserver(recs=>{ for(const r of recs){
  r.addedNodes.forEach(n=>{ if(n.nodeType===1 && A11Y_DIALOGS.includes(n.id)) a11yWatch(n); });
  r.removedNodes.forEach(n=>{ if(n.nodeType===1 && n.__a11y) a11yOnHide(n); });
} }).observe(document.body, { childList:true });
// Tab preso na janela de cima
function a11yTrapTab(e){
  if(e.key!=='Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  const act=document.activeElement;
  if(act && act.matches && act.matches('textarea[data-tab-indent]')) return; // editor que usa Tab pra indentar
  const top=a11yTop(); if(!top) return;
  const f=a11yFocusables(top); if(!f.length){ e.preventDefault(); return; }
  const cur=f.indexOf(act);
  if(cur<0 && act && act!==top && top.contains(act)) return; // dentro, num focável que a lista não conhece (área rolável): o navegador segue
  // dentro e no meio da lista: o navegador resolve; nas pontas ou fora da janela, dá a volta
  if(cur>0 && cur<f.length-1) return;
  if(cur===0 && !e.shiftKey && f.length>1) return;
  if(cur===f.length-1 && e.shiftKey && f.length>1) return;
  e.preventDefault(); f[a11yWrapIndex(f.length, cur, e.shiftKey)].focus();
}
document.addEventListener('keydown', a11yTrapTab, true);

// ----- painel de atalhos (tecla ? ou ⌘/) -----
function kbdKeysHtml(keys){ return (keys||[]).map(x=>(typeof SHORTCUT_WORDS!=='undefined' && SHORTCUT_WORDS.has(x)) ? '<span class="kbdor">'+esc(x)+'</span>' : '<kbd>'+esc(x)+'</kbd>').join(' '); }
function kbdPanelHtml(){
  const groups=(typeof SHORTCUTS!=='undefined'?SHORTCUTS:[]);
  return '<div class="modal kbdmodal">'
    +'<div class="mhead"><b id="kbdTitle">Atalhos do teclado</b><span style="flex:1"></span><button class="x" id="kbdClose" aria-label="Fechar atalhos">'+(IC.x||'×')+'</button></div>'
    +'<div class="mbody">'+groups.map(([g,items])=>'<section class="kbdsec"><h3 class="kbdh">'+esc(g)+'</h3><dl class="kbdlist">'
      +items.map(([k,d])=>'<div class="kbdrow"><dt>'+kbdKeysHtml(k)+'</dt><dd>'+esc(d)+'</dd></div>').join('')
      +'</dl></section>').join('')+'</div>'
    +'<div class="mfoot"><span class="dim">no Windows/Linux, ⌘ = Ctrl</span><span style="flex:1"></span><button class="btn primary" id="kbdOk">ok</button></div></div>';
}
function kbdClose(){ const o=$id('kbdOverlay'); if(o) o.remove(); }
function openShortcuts(){
  if($id('kbdOverlay')) return;
  const o=document.createElement('div'); o.id='kbdOverlay'; o.className='overlay'; o.style.cssText='display:flex;z-index:130';
  o.innerHTML=kbdPanelHtml();
  o.addEventListener('click', e=>{ if(e.target===o) kbdClose(); });
  document.body.appendChild(o);
  bindClick('kbdClose', kbdClose); bindClick('kbdOk', kbdClose);
}
window.openShortcuts=openShortcuts;
// captura na window: com o painel aberto, Esc fecha SÓ ele e os atalhos ⌘ (⌘W/⌘N/⌘K/⌘1-9…) não mexem nas abas de trás
function kbdKey(e){
  if($id('kbdOverlay')){
    if(e.key==='Escape' || ((e.metaKey||e.ctrlKey) && e.key==='/')){ e.preventDefault(); e.stopImmediatePropagation(); kbdClose(); return; }
    if(e.metaKey||e.ctrlKey){ e.preventDefault(); e.stopImmediatePropagation(); }
    return;
  }
  if(!a11yIsHelpKey(e, a11yTyping(e.target))) return;
  if(a11yTop()) return; // com outra janela aberta, o ? é dela
  e.preventDefault(); e.stopImmediatePropagation(); openShortcuts();
}
window.addEventListener('keydown', kbdKey, true);
