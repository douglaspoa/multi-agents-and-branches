// Starfork — 06-carregamento: UM sistema de carregamento pro app inteiro (aposenta o antigo céu de estrelas em canvas).
// Peças: skeletonHtml(kind) com a forma do layout real · brandLoaderHtml(label) (a estrela que se bifurca, em traço)
// · emptyHtml/errorHtml padronizados · tabBusy (barra de 2px no topo da aba) · loadInto ("pinta, depois busca").
// Regras (party mode, Júlia/Lia): nada de canvas/rAF/width/background-position/filter animados; animação só em
// transform/opacity (o traço da marca usa stroke-dashoffset, que só repinta); respeita prefers-reduced-motion e para
// com a janela oculta. Nada aparece antes de 150 ms (carga rápida não pisca); aos 4 s entra o texto "ainda carregando";
// a marca só entra depois de 1,5 s e só onde não há skeleton.
// @puro-inicio
const LD_MS={ delay:150, brand:1500, slow:4000 };
function ldIsEmpty(d){ return d==null || (Array.isArray(d) && !d.length); }
function ldReduced(){ try{ return !!(typeof matchMedia==='function' && matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(_){ return false; } }
function ldMotion(){ return ldReduced()?' ld-static':''; }
const ldB=(w,h,cls)=>`<i class="ld-b${cls?' '+cls:''}" style="width:${w};${h?'height:'+h:''}"></i>`;
const ldRep=(n,f)=>Array.from({length:n},(_,i)=>f(i)).join('');
const LD_W=['72%','58%','84%','46%','66%','78%','52%','90%'];
// formas (o mais perto possível do layout que vem depois — a troca não "pula")
const LD_SHAPES={
  cards:(o)=>`<div class="ld-cards">${ldRep(o.n||6,i=>`<div class="ld-card">${ldB(LD_W[i%8],'12px')}${ldB('92%')}${ldB(LD_W[(i+3)%8])}<div class="ld-row">${ldB('64px','18px','ld-round')}${ldB('48px','18px','ld-round')}</div></div>`)}</div>`,
  kanban:(o)=>`<div class="ld-kanban">${ldRep(o.cols||4,c=>`<div class="ld-col">${ldB('46%','11px')}${ldRep(c===0?3:c===1?2:c===2?3:1,i=>`<div class="ld-card">${ldB('38px','9px')}${ldB(LD_W[(c+i)%8])}${ldB(LD_W[(c+i+2)%8])}</div>`)}</div>`)}</div>`,
  lista:(o)=>`<div class="ld-lista${o.compact?' ld-compact':''}">${ldRep(o.n||6,i=>`<div class="ld-li">${o.compact?'':ldB('22px','22px','ld-dot')}<div class="ld-col1">${ldB(LD_W[i%8])}${o.compact?'':ldB(LD_W[(i+4)%8],'8px')}</div></div>`)}</div>`,
  chat:(o)=>`<div class="ld-chat"><div class="ld-msgs">${ldRep(o.n||3,i=>`<div class="ld-msg${i%2?' me':''}">${ldB(i%2?'70%':'92%')}${ldB(i%2?'40%':'64%')}</div>`)}</div>${o.composer===false?'':`<div class="ld-composer">${ldB('38%')}</div>`}</div>`,
  nota:(o)=>`<div class="ld-nota"><div class="ld-side">${ldRep(o.n||7,i=>`<div class="ld-li">${ldB(LD_W[i%8])}${ldB(LD_W[(i+5)%8],'8px')}</div>`)}</div><div class="ld-page">${ldB('44%','18px')}${ldB('28%','9px')}${ldRep(3,i=>`<div class="ld-par">${ldB('96%')}${ldB('90%')}${ldB(LD_W[(i+1)%8])}</div>`)}</div></div>`,
  tabela:(o)=>`<div class="ld-tabela"><div class="ld-tr ld-th">${ldRep(o.cols||4,i=>ldB(i?'50%':'70%','9px'))}</div>${ldRep(o.n||6,r=>`<div class="ld-tr">${ldRep(o.cols||4,c=>ldB(LD_W[(r+c)%8]))}</div>`)}</div>`,
};
const LD_HEAD=`<div class="ld-head">${ldB('180px','24px')}${ldB('min(420px,70%)','10px')}</div>`;
// skeletonHtml(kind, {n, cols, head, compact, label, wrap}) — o bloco some sozinho (opacidade 0 até 150 ms, só CSS):
// uma carga rápida troca o skeleton antes de ele aparecer. `.ld-slow` recebe o texto honesto aos 4 s.
function skeletonHtml(kind, o){
  o=o||{}; const f=LD_SHAPES[kind]||LD_SHAPES.lista;
  const lbl=o.label?esc(o.label):'carregando';
  const h=`<div class="ld-sk ld-sk-${kind in LD_SHAPES?kind:'lista'}${o.head?' ld-hashead':''}${ldMotion()}" role="status" aria-busy="true" aria-label="${lbl}">${o.head?LD_HEAD:''}${f(o)}<div class="ld-slow" aria-live="polite"></div></div>`;
  return o.wrap?`<div class="${esc(o.wrap)}">${h}</div>`:h;
}
// loader da marca: a estrela que se bifurca (mesmo desenho do logo .brand), em traço. Só em espera longa (> 1,5 s,
// via CSS) e só onde NÃO há skeleton com a forma do conteúdo. o.now: aparece já (quem chama já esperou os 1,5 s).
function brandLoaderHtml(label, o){
  o=o||{};
  return `<div class="ld-brand${o.now?' ld-now':''}${o.inline?' ld-inline':''}${ldMotion()}" role="status" aria-busy="true">`
    +`<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.1" stroke-linecap="round">`
    +`<path class="ld-t1" pathLength="1" d="M5 14L9.5 9"/><path class="ld-t2" pathLength="1" d="M9.5 9L15 11.5"/><path class="ld-t3" pathLength="1" d="M9.5 9L12 4"/></g>`
    +`<g fill="currentColor"><circle class="ld-n0" cx="5" cy="14" r="1.5"/><circle class="ld-n1" cx="9.5" cy="9" r="2.2"/><circle class="ld-n2" cx="15" cy="11.5" r="1.5"/><circle class="ld-n3" cx="12" cy="4" r="1.4"/></g></svg>`
    +`<div class="ld-bl">${label?esc(label):'carregando'}</div><div class="ld-slow" aria-live="polite"></div></div>`;
}
function ldIcon(ic){ if(!ic) return (typeof IC!=='undefined'&&IC.search)||''; if(String(ic).trim().startsWith('<svg')) return ic; return (typeof IC!=='undefined'&&IC[ic])||''; }
// vazio padrão: ícone SVG, uma frase, uma linha de ajuda e UM botão (action:{id,label}; o clique quem liga é o dono)
function emptyHtml(o){
  o=o||{}; const a=o.action;
  return `<div class="ld-empty"><span class="ld-ic">${ldIcon(o.icon)}</span><b>${esc(o.title||'Nada por aqui ainda')}</b>${o.help?`<p>${esc(o.help)}</p>`:''}`
    +`${a&&a.label?`<button class="btn${a.primary===false?'':' primary'} sm" ${a.id?`id="${esc(a.id)}"`:''} data-ldact>${esc(a.label)}</button>`:''}</div>`;
}
// erro padrão: a mensagem HUMANA (humanErr) + "tentar de novo" (retryId); o texto cru fica no title
function errorHtml(err, retryId, ctx){
  const h=(typeof humanErr==='function')?humanErr(err, ctx):{ msg:String((err&&err.message)||err||'erro'), raw:String(err) };
  return `<div class="ld-empty ld-err" role="alert"><span class="ld-ic">${ldIcon('warn')}</span><b>${esc(h.msg)}</b>`
    +`${h.raw&&h.raw!==h.msg?`<p class="ld-raw" title="${esc(h.raw)}">${esc(String(h.raw).split('\n')[0].slice(0,160))}</p>`:''}`
    +`<button class="btn sm" ${retryId?`id="${esc(retryId)}"`:''} data-ldretry>${ldIcon('retry')}tentar de novo</button></div>`;
}
// Núcleo puro (testável sem DOM): roda fetchFn e dispara os ganchos na hora certa.
// h: { show() aos 150 ms, brand() aos 1,5 s (se o.brand), slow() aos 4 s, done(d), empty(d), fail(e), stale() }
// o: { alive() → false descarta a resposta (outra carga começou / a tela saiu), isEmpty(d), brand:boolean }
// Devolve Promise<'done'|'empty'|'fail'|'stale'>. Nenhum gancho de tempo dispara depois do fim.
function ldRun(fetchFn, h, o){
  h=h||{}; o=o||{}; const T=[]; let over=false;
  const live=()=>!o.alive || o.alive();
  const at=(ms,fn)=>{ if(fn) T.push(setTimeout(()=>{ if(!over && live()) fn(); }, ms)); };
  at(LD_MS.delay, h.show); if(o.brand) at(LD_MS.brand, h.brand); at(LD_MS.slow, h.slow);
  const fin=()=>{ over=true; T.forEach(clearTimeout); };
  let p; try{ p=Promise.resolve(fetchFn()); }catch(e){ p=Promise.reject(e); }
  const failed=e=>{ if(h.fail) h.fail(e); return 'fail'; };
  return p.then(d=>{ fin(); if(!live()){ if(h.stale) h.stale(); return 'stale'; }
      try{ if((o.isEmpty||ldIsEmpty)(d) && h.empty){ h.empty(d); return 'empty'; }
        if(h.done) h.done(d); return 'done'; }catch(e){ return failed(e); } }, // render quebrou: erro com retry, nunca "carregando…" eterno
    e=>{ fin(); if(!live()){ if(h.stale) h.stale(); return 'stale'; } return failed(e); });
}
function ldSlowText(label){ return 'ainda carregando'+(label?': '+label:'')+'…'; }
// @puro-fim

// pinta seguindo a guarda el.__html (sem ela, o render seguinte podia achar que "nada mudou" e deixar o skeleton)
// (__first: quem escreve innerHTML sem a guarda não engana o "nada mudou")
function ldPaint(el, html){ if(!el) return false; if(el.__html===html && el.firstChild && el.__ldFirst===el.firstChild) return false; el.__html=html; el.innerHTML=html; el.__ldFirst=el.firstChild; return true; }
// qual aba (kind) mostra este elemento — pra barra de 2px ir na aba certa
function ldTabOf(el){
  if(typeof VIEW_OVERLAY==='undefined' || !el || !el.closest) return null;
  const ov=el.closest('.overlay'); if(!ov) return null;
  return Object.keys(VIEW_OVERLAY).find(k=>VIEW_OVERLAY[k]===ov.id)||null;
}
// barra de 2px no topo da aba + (aos 4 s) o texto do que está sendo buscado. Aparece só se passar de 150 ms.
// Várias cargas na mesma aba: a barra fica até a última terminar. Devolve a própria promise.
function tabBusy(kind, promise, o){
  o=o||{};
  const ov=(typeof VIEW_OVERLAY!=='undefined' && VIEW_OVERLAY[kind]) ? document.getElementById(VIEW_OVERLAY[kind]) : null;
  const t0=performance.now();
  if(!ov) return promise;
  ov.__ldBusy=(ov.__ldBusy||0)+1;
  const T=[setTimeout(()=>{ if(!ov.querySelector(':scope>.ld-bar')){ const b=document.createElement('div'); b.className='ld-bar'+ldMotion(); b.setAttribute('role','progressbar'); b.setAttribute('aria-label', o.label||'carregando'); b.innerHTML='<i></i>'; ov.prepend(b); } }, LD_MS.delay)];
  if(o.text!==false && o.label) T.push(setTimeout(()=>{ let p=ov.querySelector(':scope>.ld-pill'); if(!p){ p=document.createElement('div'); p.className='ld-pill'; p.setAttribute('aria-live','polite'); ov.prepend(p); } p.textContent=ldSlowText(o.label); }, LD_MS.slow));
  const end=()=>{ T.forEach(clearTimeout); ov.__ldBusy=Math.max(0,(ov.__ldBusy||1)-1);
    if(!ov.__ldBusy) ov.querySelectorAll(':scope>.ld-bar,:scope>.ld-pill').forEach(x=>x.remove());
    const ms=Math.round(performance.now()-t0); if(typeof perfLog==='function' && ms>=LD_MS.delay) perfLog('[aba] '+kind+' dados '+ms+'ms'+(o.label?' · '+o.label:'')); };
  Promise.resolve(promise).then(end,end);
  return promise;
}
// "pinta, depois busca": o skeleton (kind) entra NA HORA no elemento (invisível até 150 ms), a barra da aba corre,
// aos 4 s aparece "ainda carregando: <label>"; depois renderFn(dados) — ou o vazio padrão (o.empty) — ou o erro com
// "tentar de novo" (refaz a carga). Uma carga nova no mesmo elemento descarta a resposta atrasada da anterior.
// kind null/'marca' = sem forma de conteúdo: aí entra o loader da marca aos 1,5 s.
// o: { label, empty:{icon,title,help,action:{label,onClick}}, isEmpty, keep:true (não repinta o skeleton se já há conteúdo), ctx }
function loadInto(el, kind, fetchFn, renderFn, o){
  o=o||{}; if(typeof el==='string') el=document.getElementById(el); if(!el) return Promise.resolve('stale');
  const g=(el.__ldGen=(el.__ldGen||0)+1);
  const alive=()=>el.__ldGen===g && el.isConnected;
  const shaped=!!kind && kind!=='marca';
  if(shaped && !(o.keep && el.firstChild && !el.querySelector('.ld-sk'))) ldPaint(el, skeletonHtml(kind, { ...(o.shape||{}), label:o.label }));
  else if(!shaped) ldPaint(el, '<div class="ld-hold"></div>');
  const slot=()=>el.querySelector('.ld-sk>.ld-slow,.ld-brand>.ld-slow');
  const run=ldRun(fetchFn, {
    brand:()=>ldPaint(el, brandLoaderHtml(o.label, { now:true })),
    slow:()=>{ const s=slot(); if(s) s.textContent=ldSlowText(o.label); },
    done:(d)=>{ el.__html=null; renderFn(d); },
    empty:o.empty?(d)=>{ ldPaint(el, emptyHtml(o.empty)); const b=el.querySelector('[data-ldact]'); if(b && o.empty.action && o.empty.action.onClick) b.onclick=o.empty.action.onClick; }:null,
    fail:(e)=>{ console.warn('[carregamento]', o.label||kind, e); ldPaint(el, errorHtml(e, null, o.ctx)); const b=el.querySelector('[data-ldretry]'); if(b) b.onclick=()=>loadInto(el, kind, fetchFn, renderFn, o); },
  }, { alive, brand:!shaped, isEmpty:o.isEmpty });
  const tab=o.tab||ldTabOf(el);
  if(tab) tabBusy(tab, run, { label:o.label, text:false });
  return run;
}
// janela oculta = animação parada (o CSS pausa tudo sob .ld-paused)
document.addEventListener('visibilitychange', ()=>{ document.documentElement.classList.toggle('ld-paused', document.hidden); });
// Central no boot: o quadro pinta os cartões-esqueleto já, antes do 1º snapshot (render() troca depois)
{ const f=document.getElementById('flow'); if(f && !f.firstChild){ ldPaint(f, skeletonHtml('cards', { n:6 }));
  requestAnimationFrame(()=>setTimeout(()=>{ if(typeof perfLog==='function') perfLog('[aba] central 1º paint '+Math.round(performance.now())+'ms (boot, esqueleto)'); }, 0)); } }
