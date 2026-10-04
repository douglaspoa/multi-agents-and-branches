// ===== MOVIMENTO (redesenho F3) — os helpers do protótipo aprovado (_bmad-output/redesign/proto) =====
// Regras: 150–300 ms; só transform/opacity (exceto a altura da linha que expande); prefers-reduced-motion → corte
// instantâneo; NADA anima no boot nem em atualização de fundo (poll/snapshot) — só em resposta a um gesto recente da
// pessoa (mvUser) ou a uma MUDANÇA real de estado detectada por quem chama (ex.: requisito que acabou de ser provado).
// Sem laço: nenhum requestAnimationFrame contínuo; a única animação infinita do app é o ponto "rodando" visível.
// @movimento-puro-inicio (testado em app/tests/tema-movimento.test.mjs)
const MV_EASE='cubic-bezier(.2,.8,.2,1)';
/** pode animar? o: { reduced, boot, hidden, can } — reduzir movimento, ainda no boot, janela escondida, sem Web Animations */
function mvShouldAnimate(o){ return !!(o && o.can && !o.reduced && !o.boot && !o.hidden); }
/** direção do deslize ao trocar de modo/aba: 1 = o novo vem da direita, -1 = da esquerda, 0 = sem deslize */
function slideDir(oldIdx, newIdx){ return (oldIdx==null || newIdx==null || oldIdx<0 || newIdx<0 || oldIdx===newIdx) ? 0 : (newIdx>oldIdx?1:-1); }
/** FLIP: quanto o elemento andou (null = ficou no lugar, menos de 1 px) */
function mvFlipDelta(first, last){ if(!first || !last) return null; const dx=first.left-last.left, dy=first.top-last.top; return (Math.abs(dx)<1 && Math.abs(dy)<1)?null:{ dx, dy }; }
/** chaves que passaram de NÃO provado a provado entre duas pinturas (prev null = 1ª pintura → nada carimba) */
function mvNewlyTrue(prev, next){ if(!prev || !next) return []; return Object.keys(next).filter(k=>next[k]===true && prev[k]===false); }
/** contador que subiu (o portão anda) — só quando já havia um valor antes */
function mvTicked(prev, next){ return prev!=null && next!=null && +next>+prev; }
// @movimento-puro-fim
const MV_RM=(typeof matchMedia==='function')?matchMedia('(prefers-reduced-motion: reduce)'):null;
const MV={ booted:false, userAt:0, pressEl:null, pressAt:0, inVT:false };
// boot: as primeiras pinturas (snapshot chegando, abas restauradas) nunca animam
setTimeout(()=>{ MV.booted=true; }, 1500);
// gesto da pessoa: só o que acontece logo depois de um clique/tecla anima (o poll de fundo não)
['pointerdown','keydown'].forEach(ev=>document.addEventListener(ev, e=>{ MV.userAt=performance.now(); if(ev==='pointerdown'){ MV.pressEl=e.target; MV.pressAt=MV.userAt; } }, true));
function mvReduced(){ return !!(MV_RM && MV_RM.matches); }
function mvUser(ms){ return performance.now()-MV.userAt<(ms||700); }
function mvOk(el){ return mvShouldAnimate({ reduced:mvReduced(), boot:!MV.booted, hidden:document.hidden, can:!!(el && el.animate && el.isConnected) }); }
/** Web Animations com o easing do protótipo; devolve a Animation ou null (não animou) */
function mvAnim(el, kf, o){ if(!mvOk(el)) return null; try{ return el.animate(kf, Object.assign({ duration:220, easing:MV_EASE }, o||{})); }catch(_){ return null; } }

/** View Transition com fallback: a mudança (fn) roda SEMPRE; sem suporte/reduzido/boot, roda direto (fallback: fade). */
function vt(fn, o){
  o=o||{};
  if(document.startViewTransition && MV.booted && !mvReduced() && !document.hidden){
    try{ const t=document.startViewTransition(()=>{ fn(); }); return t; }catch(_){ }
  }
  fn();
  if(o.fade) mvAnim(o.fade, [{ opacity:0 }, { opacity:1 }], { duration:180 });
  return null;
}
/** FLIP: mede os filhos, roda a mutação e anima cada um do lugar velho pro novo (os novos entram com fade). */
function flip(container, mutate, o){
  o=o||{};
  if(!container || !mvOk(container) || (o.user!==false && !mvUser())){ mutate(); return; }
  const sel=o.sel||':scope > *', key=o.key||(el=>el);
  const first=new Map(); container.querySelectorAll(sel).forEach(el=>first.set(key(el), el.getBoundingClientRect()));
  mutate();
  container.querySelectorAll(sel).forEach(el=>{
    const f=first.get(key(el));
    if(!f){ mvAnim(el, [{ opacity:0 }, { opacity:1 }], { duration:200 }); return; }
    const d=mvFlipDelta(f, el.getBoundingClientRect());
    if(d) mvAnim(el, [{ transform:`translate(${d.dx}px,${d.dy}px)` }, { transform:'none' }], { duration:260 });
  });
}
/** carimbo que cai: escala 1,3→1 com leve rotação (o ângulo final é o do CSS, --rot) */
function stampLand(el){
  if(!el) return null;
  const r=getComputedStyle(el).getPropertyValue('--rot').trim()||'-3deg';
  return mvAnim(el, [{ transform:'scale(1.35) rotate(-9deg)', opacity:0 }, { transform:'scale(.96) rotate(-2deg)', opacity:1, offset:.55 }, { transform:`scale(1) rotate(${r})`, opacity:1 }], { duration:300, easing:'cubic-bezier(.2,.9,.3,1.2)' });
}
/** chips/itens novos entram com mola, em cascata de 45 ms */
function springIn(els){
  [...(els||[])].forEach((el,i)=>mvAnim(el, [{ opacity:0, transform:'translateY(8px) scale(.94)' }, { opacity:1, transform:'none' }], { duration:280, delay:i*45, easing:'cubic-bezier(.3,1.45,.5,1)', fill:'backwards' }));
}
/** conteúdo que entra deslizando na direção do clique (dir 1/-1); 0 = só fade */
function mvSlideIn(el, dir){ if(!el) return; mvAnim(el, [{ opacity:0, transform:`translateX(${16*(dir||0)}px)` }, { opacity:1, transform:'none' }], { duration:220 }); }
/** número que "rola" pra cima (contador do portão) */
function mvTick(el){ if(el) mvAnim(el, [{ transform:'translateY(60%)', opacity:0 }, { transform:'none', opacity:1 }], { duration:260 }); }
/** folha/menu que abre a partir do botão que o chamou (transform-origin no centro do botão) */
function mvFromOrigin(el, opener){
  if(!el) return;
  if(opener && opener.getBoundingClientRect){ const b=opener.getBoundingClientRect(), r=el.getBoundingClientRect(); if(r.width) el.style.transformOrigin=`${Math.round(b.left+b.width/2-r.left)}px ${b.top>r.top+r.height/2?'100%':'0'}`; }
  mvAnim(el, [{ opacity:0, transform:'scale(.94) translateY(6px)' }, { opacity:1, transform:'none' }], { duration:200 });
}
/** abrir uma demanda POR CLIQUE (lateral/Central): o título clicado "voa" até o título da aba — View Transition com
 *  view-transition-name no título de origem e no da aba. A mudança (fn) roda inteira, síncrona, dentro do callback da
 *  transição. Sem View Transitions, com reduzir movimento, no boot ou aberto por código/poll: fn() direto (e o voo
 *  WAAPI do mvTabIn, no renderTabs, é o fallback). */
function mvOpen(src, fn){
  const can=!!(document.startViewTransition && MV.booted && !mvReduced() && !document.hidden && mvUser() && src && src.isConnected);
  if(!can){ fn(); return; }
  const clear=()=>document.querySelectorAll('[style*="view-transition-name"]').forEach(e=>{ e.style.viewTransitionName=''; });
  src.style.viewTransitionName='sf-open';
  try{
    const t=document.startViewTransition(()=>{ src.style.viewTransitionName=''; MV.inVT=true; try{ fn(); }finally{ MV.inVT=false; }
      const dst=document.querySelector('#tabBar .tab.on .tt'); if(dst) dst.style.viewTransitionName='sf-open'; });
    t.finished.then(clear, clear);
  }catch(_){ clear(); fn(); }
}
/** aba nova: desce e assenta; se veio de um clique (linha da lateral/Central), "voa" de onde foi clicada */
function mvTabIn(el){
  if(!el) return;
  const src=(MV.pressEl && performance.now()-MV.pressAt<700 && MV.pressEl.isConnected && !el.contains(MV.pressEl)) ? MV.pressEl.closest('[data-task],[data-ctrow],.ctrow,.rrow,.frow,li,button')||MV.pressEl : null;
  if(src){ const a=src.getBoundingClientRect(), b=el.getBoundingClientRect(); const dx=a.left-b.left, dy=a.top-b.top;
    if(Math.abs(dx)+Math.abs(dy)>4){ mvAnim(el, [{ transform:`translate(${dx}px,${dy}px) scale(.96)`, opacity:.35 }, { transform:'none', opacity:1 }], { duration:280 }); return; } }
  mvAnim(el, [{ opacity:0, transform:'translateY(-6px) scale(.97)' }, { opacity:1, transform:'none' }], { duration:240 });
}
/** linha que expande: anima a ALTURA (única exceção ao transform/opacity), do 0 até a altura natural */
function mvExpand(el){
  if(!el || !mvOk(el)) return;
  const h=el.scrollHeight; if(!h) return;
  const a=mvAnim(el, [{ height:'0px', opacity:0, overflow:'hidden' }, { height:h+'px', opacity:1, overflow:'hidden' }], { duration:220 });
  if(a) a.onfinish=()=>{ el.style.height=''; };
}
/** toast que sobe (in) ou desce sumindo (out → resolve quando terminar, pra remover depois) */
function mvToast(el, out){
  const a=out ? mvAnim(el, [{ opacity:1, transform:'none' }, { opacity:0, transform:'translateY(6px)' }], { duration:200 })
              : mvAnim(el, [{ opacity:0, transform:'translateY(10px)' }, { opacity:1, transform:'none' }], { duration:240 });
  return a ? a.finished.catch(()=>{}) : Promise.resolve();
}
// janela escondida/minimizada: tudo que é infinito (o ponto "rodando") pausa — volta sozinho ao aparecer
document.addEventListener('visibilitychange', ()=>document.documentElement.classList.toggle('sf-hidden', document.hidden));
// abas: a que acabou de aparecer (aberta por um clique) desliza pra dentro — o render inicial/restaurado não anima
const MV_TABS={ seen:null };
function mvTabsPainted(bar){
  if(!bar) return;
  const ids=[...bar.querySelectorAll('[data-tk]')].map(el=>el.dataset.tk), prev=MV_TABS.seen;
  MV_TABS.seen=new Set(ids);
  if(!prev || !mvUser(900) || MV.inVT) return; // dentro da View Transition quem anima é ela
  ids.filter(id=>!prev.has(id)).forEach(id=>mvTabIn(bar.querySelector(`[data-tk="${CSS.escape(id)}"]`)));
}
/** a tela da aba ativa trocou por um clique: entra num fade curto (a mesma tela re-pintada pelo poll nunca) */
function mvViewIn(el){ if(el && mvUser(900) && !MV.inVT) mvAnim(el, [{ opacity:0, transform:'translateY(4px)' }, { opacity:1, transform:'none' }], { duration:180 }); }
/** segmentado: a pílula (.mvind) e o sublinhado (.mvul) deslizam até o botão .on — translateX + largura (escala distorcia
 *  os cantos redondos). O innerHTML do dono apaga os dois: renascem na posição VELHA (guardada no container) e a transição
 *  CSS leva até a nova — só logo depois de um clique; 1ª pintura, poll e redimensionar posicionam sem deslizar. */
function mvGlide(box){
  if(!box || box.offsetParent===null) return;
  const on=box.querySelector('.on'); if(!on || box.classList.contains('asmenu')){ box.classList.remove('has-ind'); return; }
  let ind=box.querySelector(':scope > .mvind'), ul=box.querySelector(':scope > .mvul');
  if(!ind){ ind=document.createElement('i'); ind.className='mvind'; ind.setAttribute('aria-hidden','true'); ul=document.createElement('i'); ul.className='mvul'; ul.setAttribute('aria-hidden','true'); box.prepend(ind); box.append(ul); }
  const T={ x:on.offsetLeft, w:on.offsetWidth }, old=box.__mvT;
  const put=(p)=>{ ind.style.transform=`translateX(${p.x}px)`; ind.style.width=p.w+'px'; ul.style.transform=`translateX(${p.x+10}px)`; ul.style.width=Math.max(0,p.w-20)+'px'; };
  box.classList.add('has-ind');
  const glide=!!(old && (old.x!==T.x || old.w!==T.w) && mvOk(box) && mvUser());
  box.classList.add('mv-instant'); put(glide?old:T); void ind.offsetWidth; box.classList.remove('mv-instant');
  if(glide) put(T);
  box.__mvT=T;
}
// a fonte local terminou de carregar / a janela mudou de largura: a pílula reposiciona sem deslizar (evento, sem laço)
function mvGlideAll(){ document.querySelectorAll('.has-ind').forEach(b=>{ b.__mvT=null; b.querySelectorAll(':scope > .mvind, :scope > .mvul').forEach(x=>x.remove()); mvGlide(b); }); }
{ let tm=0; window.addEventListener('resize', ()=>{ clearTimeout(tm); tm=setTimeout(mvGlideAll, 160); }); }
try{ if(document.fonts && document.fonts.ready) document.fonts.ready.then(mvGlideAll); }catch(_){ }
