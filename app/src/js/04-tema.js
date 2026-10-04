// ===== TEMA (redesenho F2) — Sistema · Claro (Cartório) · Escuro (verde do logo) =====
// A escolha mora em localStorage 'theme' ('system' | 'light' | 'dark'; padrão Sistema). O <head> do index.html já gravou
// html[data-theme] ANTES da 1ª pintura (sem piscar); aqui: trocar pela tela de Configurações, seguir o macOS ao vivo
// (listener do prefers-color-scheme, nada de polling) e avisar quem pinta fora do CSS — o xterm (60-terminal) e o
// canvas da memória (37-memoria) — pelo evento 'sf-theme' na window.
// @tema-puro-inicio (testado em app/tests/tema-movimento.test.mjs)
const TEMA_PREFS=['system','light','dark'];
function temaPrefNorm(v){ return TEMA_PREFS.includes(v)?v:'system'; }
/** preferência + o SO está escuro? → o tema que pinta ('light' | 'dark') */
function temaResolve(pref, sysDark){ pref=temaPrefNorm(pref); return pref==='system'?(sysDark?'dark':'light'):pref; }
// @tema-puro-fim
const TEMA_MQ=(typeof matchMedia==='function')?matchMedia('(prefers-color-scheme: dark)'):null;
function temaPref(){ return temaPrefNorm(lsGet('theme')); }
function temaAtual(){ return document.documentElement.dataset.theme==='dark'?'dark':'light'; }
function temaApply(){
  const t=temaResolve(temaPref(), !!(TEMA_MQ && TEMA_MQ.matches)), el=document.documentElement;
  if(el.dataset.theme===t) return false;
  const go=()=>{ el.dataset.theme=t; try{ window.dispatchEvent(new CustomEvent('sf-theme', { detail:{ theme:t } })); }catch(_){ } };
  // troca de tema = um corte suave (View Transitions, 05-movimento) — nunca no boot
  if(typeof vt==='function') vt(go); else go();
  return true;
}
// a janela nativa (barra de título, menus do sistema) acompanha: Claro/Escuro fixam, Sistema devolve pro SO (null).
// Tauri v2 com withGlobalTauri; precisa da permissão core:window:allow-set-theme na capability — sem ela, falha calada.
function temaNative(pref){ try{ const W=window.__TAURI__ && window.__TAURI__.window; const w=W && W.getCurrentWindow && W.getCurrentWindow(); if(w && w.setTheme){ const r=w.setTheme(pref==='system'?null:pref); if(r && r.catch) r.catch(()=>{}); } }catch(_){ } }
function temaSet(pref){ pref=temaPrefNorm(pref); lsSet('theme', pref); temaApply(); temaNative(pref); }
if(TEMA_MQ){ const on=()=>{ if(temaPref()==='system') temaApply(); }; if(TEMA_MQ.addEventListener) TEMA_MQ.addEventListener('change', on); else if(TEMA_MQ.addListener) TEMA_MQ.addListener(on); }
// outra janela/aba do app trocou o tema (localStorage é compartilhado): acompanha
window.addEventListener('storage', e=>{ if(e.key==='theme') temaApply(); });
// garante o atributo (o <head> já pôs; sem ele — ex.: harness — o 1º temaApply grava sem animar: vt só anima depois do boot)
temaApply();
// controle "Aparência" das Configurações (15-config): radiogroup de 3 opções (Tab entra na escolhida; ←/→ trocam), salva sozinho
function temaCfgHtml(){
  const cur=temaPref(), L={ system:'Sistema', light:'Claro', dark:'Escuro' };
  return `<div class="seg2 temaseg" role="radiogroup" aria-label="Tema do app">${TEMA_PREFS.map(k=>`<button type="button" role="radio" aria-checked="${k===cur}" tabindex="${k===cur?0:-1}" class="${k===cur?'on':''}" data-tema="${k}">${L[k]}</button>`).join('')}</div>`;
}
function temaCfgMount(host){
  if(!host) return;
  const pick=(k)=>{ temaSet(k); paint(); const n=host.querySelector('[aria-checked="true"]'); if(n) n.focus(); };
  const paint=()=>{ host.innerHTML=temaCfgHtml();
    host.querySelectorAll('[data-tema]').forEach(b=>{ b.onclick=()=>pick(b.dataset.tema);
      b.onkeydown=(e)=>{ const d={ ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1 }[e.key]; if(!d && e.key!=='Home' && e.key!=='End') return; e.preventDefault();
        const i=TEMA_PREFS.indexOf(b.dataset.tema), n=e.key==='Home'?0:e.key==='End'?TEMA_PREFS.length-1:(i+d+TEMA_PREFS.length)%TEMA_PREFS.length; pick(TEMA_PREFS[n]); }; }); };
  paint();
}
