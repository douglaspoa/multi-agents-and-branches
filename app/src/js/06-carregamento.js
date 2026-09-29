// Starfork — 06-carregamento: UM sistema de carregamento pro app inteiro (aposenta o antigo céu de estrelas em canvas).
// Peças: skeletonHtml(kind) com a forma do layout real · brandLoaderHtml(label) (a estrela que se bifurca, em traço)
// · emptyHtml/errorHtml padronizados · tabBusy (barra de 2px no topo da aba) · loadInto ("pinta, depois busca").
// Regras (party mode, Júlia/Lia): nada de canvas/rAF/width/background-position/filter animados; animação só em
// transform/opacity (o traço da marca usa stroke-dashoffset, que só repinta); respeita prefers-reduced-motion e para
// com a janela oculta. Nada aparece antes de 150 ms (carga rápida não pisca); aos 4 s entra o texto "ainda carregando";
// a marca só entra depois de 1,5 s e só onde não há skeleton.
// @puro-inicio
const LD_MS={ delay:150, brand:1500, slow:4000, timeout:30000 };
// texto em atributo (o esc do app não escapa aspas; e este roda no boot, antes do 10-core definir o esc)
const ldA=(v)=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
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
// skeletonHtml(kind, {n, cols, head, compact, label, wrap, inline}) — o bloco some sozinho (opacidade 0 até 150 ms, só CSS):
// uma carga rápida troca o skeleton antes de ele aparecer. `.ld-slow` recebe o texto honesto aos 4 s (a região viva é
// o próprio role=status — sem aria-live aninhado). inline:true = pedaço dentro de uma tela que se redesenha (lista de
// arquivos, comentários…): aparece já, sem o atraso de entrada (senão piscava a cada innerHTML) e fica fora da árvore
// de acessibilidade (só aria-busy), pra não encher a página de regiões vivas.
function skeletonHtml(kind, o){
  o=o||{}; const f=LD_SHAPES[kind]||LD_SHAPES.lista;
  const lbl=ldA(o.label||'carregando');
  const k=kind in LD_SHAPES?kind:'lista';
  const h=o.inline
    ? `<div class="ld-sk ld-sk-${k} ld-inl${ldMotion()}" aria-busy="true" aria-label="${lbl}"><div aria-hidden="true">${f(o)}</div></div>`
    : `<div class="ld-sk ld-sk-${k}${o.head?' ld-hashead':''}${ldMotion()}" role="status" aria-busy="true" aria-label="${lbl}">${o.head?LD_HEAD:''}${f(o)}<div class="ld-slow"></div></div>`;
  return o.wrap?`<div class="${ldA(o.wrap)}">${h}</div>`:h;
}
// loader da marca: a estrela que se bifurca (IC.starfork, o mesmo símbolo do logo), em traço. Só em espera longa (> 1,5 s,
// via CSS) e só onde NÃO há skeleton com a forma do conteúdo. o.now: aparece já (quem chama já esperou os 1,5 s).
function brandLoaderHtml(label, o){
  o=o||{};
  return `<div class="ld-brand${o.now?' ld-now':''}${o.inline?' ld-inline':''}${ldMotion()}" role="status" aria-busy="true">`
    +((typeof IC!=='undefined'&&IC.starfork)||'')
    +`<div class="ld-bl">${label?esc(label):'carregando'}</div><div class="ld-slow"></div></div>`;
}
// ícone por chave: IC.* (svg pronto) ou _ICONS.* (só os paths, ex.: folder) — o tamanho quem dá é o CSS do estado
function ldIcon(ic){ if(!ic) return (typeof IC!=='undefined'&&IC.search)||''; if(String(ic).trim().startsWith('<svg')) return ic;
  if(typeof IC!=='undefined' && IC[ic]) return IC[ic];
  if(typeof _ICONS!=='undefined' && _ICONS[ic]) return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round">'+_ICONS[ic]+'</svg>';
  return ''; }
// vazio padrão: ícone SVG, uma frase, uma linha de ajuda e UM botão (action:{id,label}; o clique quem liga é o dono)
function emptyHtml(o){
  o=o||{}; const a=o.action;
  return `<div class="ld-empty"><span class="ld-ic">${ldIcon(o.icon)}</span><b>${esc(o.title||'Nada por aqui ainda')}</b>${o.help?`<p>${esc(o.help)}</p>`:''}`
    +`${a&&a.label?`<button class="btn${a.primary===false?'':' primary'} sm" ${a.id?`id="${ldA(a.id)}"`:''} data-ldact>${esc(a.label)}</button>`:''}</div>`;
}
// erro padrão: a mensagem HUMANA (humanErr) + a ação do catálogo quando existe (entrar de novo, reconectar…) +
// "tentar de novo" (retryId); o texto cru fica no title. o.human: err já é texto humano (não traduz de novo).
// Erro com .ldHuman (o prazo estourado de ldRun) também vai direto.
function ldHumanOf(err, ctx, o){
  if((o&&o.human) || (err&&err.ldHuman)){ const m=String((err&&err.message)||err||''); return { msg:m, raw:m, action:null }; }
  return (typeof humanErr==='function')?humanErr(err, ctx):{ msg:String((err&&err.message)||err||'erro'), raw:String(err), action:null };
}
function errorHtml(err, retryId, ctx, o){
  const h=ldHumanOf(err, ctx, o);
  return `<div class="ld-empty ld-err" role="alert"><span class="ld-ic">${ldIcon('warn')}</span><b>${esc(h.msg)}</b>`
    +`${h.raw&&h.raw!==h.msg?`<p class="ld-raw" title="${ldA(h.raw)}">${esc(String(h.raw).split('\n')[0].slice(0,160))}</p>`:''}`
    +`<div class="ld-acts">${h.action&&h.action.label?`<button class="btn primary sm" data-ldfix>${esc(h.action.label)}</button>`:''}`
    +`<button class="btn sm" ${retryId?`id="${ldA(retryId)}"`:''} data-ldretry>${ldIcon('retry')}tentar de novo</button></div></div>`;
}
// liga os botões do erro dentro de root: a ação do catálogo e o "tentar de novo" (retry)
function ldWireErr(root, err, ctx, retry, o){
  if(!root || !root.querySelector) return;
  const h=ldHumanOf(err, ctx, o);
  const f=root.querySelector('[data-ldfix]'); if(f && h.action && h.action.fn) f.onclick=()=>h.action.fn();
  const r=root.querySelector('[data-ldretry]'); if(r && retry) r.onclick=retry;
}
// Núcleo puro (testável sem DOM): roda fetchFn e dispara os ganchos na hora certa.
// h: { show() aos 150 ms, brand() aos 1,5 s (se o.brand), slow() aos 4 s, done(d), empty(d), fail(e), stale() }
// o: { alive() → false descarta a resposta (outra carga começou / a tela saiu), isEmpty(d), brand:boolean,
//      timeout: ms (padrão 30 s; 0 = sem prazo) — estourou: fail(erro "demorou demais") e a promise resolve 'fail';
//      se a resposta chegar depois e ainda for a carga atual, ela pinta mesmo assim (done/empty) }
// Devolve Promise<'done'|'empty'|'fail'|'stale'>. Nenhum gancho de tempo dispara depois do fim.
function ldTimeoutErr(){ const e=new Error('Demorou demais pra responder — tente de novo.'); e.ldHuman=true; return e; }
function ldRun(fetchFn, h, o){
  h=h||{}; o=o||{}; const T=[]; let over=false, settled=false, resolve;
  const out=new Promise(r=>{ resolve=r; });
  const settle=v=>{ if(!settled){ settled=true; resolve(v); } return v; };
  const live=()=>!o.alive || o.alive();
  const at=(ms,fn)=>{ if(fn) T.push(setTimeout(()=>{ if(!over && live()) fn(); }, ms)); };
  at(LD_MS.delay, h.show); if(o.brand) at(LD_MS.brand, h.brand); at(LD_MS.slow, h.slow);
  const fin=()=>{ over=true; T.forEach(clearTimeout); };
  const failed=e=>{ if(h.fail) h.fail(e); return 'fail'; };
  const tmo=o.timeout===0?0:(o.timeout||LD_MS.timeout);
  if(tmo) T.push(setTimeout(()=>{ if(over) return; fin(); settle(live()?failed(ldTimeoutErr()):'stale'); }, tmo));
  let p; try{ p=Promise.resolve(fetchFn()); }catch(e){ p=Promise.reject(e); }
  p.then(d=>{ const late=over; fin(); if(!live()){ if(!late && h.stale) h.stale(); return settle('stale'); }
      try{ if((o.isEmpty||ldIsEmpty)(d) && h.empty){ h.empty(d); return settle('empty'); }
        if(h.done) h.done(d); return settle('done'); }catch(e){ return settle(failed(e)); } }, // render quebrou: erro com retry, nunca "carregando…" eterno
    e=>{ const late=over; fin(); if(late) return; if(!live()){ if(h.stale) h.stale(); return settle('stale'); } settle(failed(e)); });
  return out;
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
// A barra vai na CAIXA da tela (.modal da aba), não no overlay inteiro — em modo modal ficava no fundo escurecido.
// O texto dos 4 s entra no .ld-slow do skeleton quando há um; senão, numa pílula no topo ao centro (longe do fechar/ações).
function ldHost(ov){ return (ov.querySelector && ov.querySelector(':scope>.modal')) || ov; }
function tabBusy(kind, promise, o){
  o=o||{};
  const ov=(typeof VIEW_OVERLAY!=='undefined' && VIEW_OVERLAY[kind]) ? document.getElementById(VIEW_OVERLAY[kind]) : null;
  const t0=performance.now();
  if(!ov) return promise;
  const host=ldHost(ov);
  host.__ldBusy=(host.__ldBusy||0)+1;
  const T=[setTimeout(()=>{ if(!host.querySelector(':scope>.ld-bar')){ host.classList.add('ld-host'); const b=document.createElement('div'); b.className='ld-bar'+ldMotion(); b.setAttribute('role','progressbar'); b.setAttribute('aria-label', o.label||'carregando'); b.innerHTML='<i></i>'; host.prepend(b); } }, LD_MS.delay)];
  if(o.text!==false && o.label) T.push(setTimeout(()=>{
    const slot=host.querySelector('.ld-sk>.ld-slow'); if(slot){ slot.textContent=ldSlowText(o.label); return; }
    let p=host.querySelector(':scope>.ld-pill'); if(!p){ host.classList.add('ld-host'); p=document.createElement('div'); p.className='ld-pill'; p.setAttribute('role','status'); host.prepend(p); } p.textContent=ldSlowText(o.label); }, LD_MS.slow));
  const end=()=>{ T.forEach(clearTimeout); host.__ldBusy=Math.max(0,(host.__ldBusy||1)-1);
    if(!host.__ldBusy) host.querySelectorAll(':scope>.ld-bar,:scope>.ld-pill').forEach(x=>x.remove());
    const ms=Math.round(performance.now()-t0); if(typeof perfLog==='function' && ms>=LD_MS.delay) perfLog('[aba] '+kind+' dados '+ms+'ms'+(o.label?' · '+o.label:'')); };
  Promise.resolve(promise).then(end,end);
  return promise;
}
// "pinta, depois busca": o skeleton (kind) entra NA HORA no elemento (invisível até 150 ms), a barra da aba corre,
// aos 4 s aparece "ainda carregando: <label>"; depois renderFn(dados) — ou o vazio padrão (o.empty) — ou o erro com
// "tentar de novo" (refaz a carga). Uma carga nova no mesmo elemento descarta a resposta atrasada da anterior.
// kind null/'marca' = sem forma de conteúdo: aí entra o loader da marca aos 1,5 s.
// o: { label, empty:{icon,title,help,action:{label,onClick}}, isEmpty, keep:true (não repinta o skeleton se já há conteúdo), ctx,
//      timeout (ms, padrão 30 s), retry (o que o "tentar de novo" chama; padrão: refaz esta carga) }
function loadInto(el, kind, fetchFn, renderFn, o){
  o=o||{}; if(typeof el==='string') el=document.getElementById(el); if(!el) return Promise.resolve('stale');
  const g=(el.__ldGen=(el.__ldGen||0)+1);
  const alive=()=>el.__ldGen===g && el.isConnected;
  const shaped=!!kind && kind!=='marca';
  // keep: conteúdo de verdade na tela (não skeleton/erro/vazio de carga anterior) fica até a leitura nova chegar
  const kept=!!(o.keep && el.firstChild && !el.querySelector('.ld-sk,.ld-err,.ld-hold'));
  if(shaped && !kept) ldPaint(el, skeletonHtml(kind, { ...(o.shape||{}), label:o.label }));
  else if(!shaped && !kept) ldPaint(el, '<div class="ld-hold"></div>');
  const slot=()=>el.querySelector('.ld-sk>.ld-slow,.ld-brand>.ld-slow');
  const run=ldRun(fetchFn, {
    brand:()=>ldPaint(el, brandLoaderHtml(o.label, { now:true })),
    slow:()=>{ const s=slot(); if(s) s.textContent=ldSlowText(o.label); },
    done:(d)=>{ el.__html=null; renderFn(d); },
    empty:o.empty?(d)=>{ ldPaint(el, emptyHtml(o.empty)); const b=el.querySelector('[data-ldact]'); if(b && o.empty.action && o.empty.action.onClick) b.onclick=o.empty.action.onClick; }:null,
    fail:(e)=>{ console.warn('[carregamento]', o.label||kind, e);
      // falhou um recarregar com conteúdo na tela (Memória/Mesa): não troca o que você está lendo por um erro de tela cheia
      if(kept){ if(typeof showErr==='function') showErr(e, o.ctx||'Não consegui atualizar'); return; }
      ldPaint(el, errorHtml(e, null, o.ctx)); ldWireErr(el, e, o.ctx, o.retry||(()=>loadInto(el, kind, fetchFn, renderFn, o))); },
  }, { alive, brand:!shaped, isEmpty:o.isEmpty, timeout:o.timeout });
  const tab=o.tab||ldTabOf(el);
  if(tab) tabBusy(tab, run, { label:o.label, text:false });
  return run;
}
// janela oculta = animação parada (o CSS pausa tudo sob .ld-paused)
document.addEventListener('visibilitychange', ()=>{ document.documentElement.classList.toggle('ld-paused', document.hidden); });
// Central no boot: o quadro pinta os cartões-esqueleto já, antes do 1º snapshot (render() troca depois).
// Sem projeto (render sai cedo) ou snapshot falhando: o esqueleto não fica pra sempre — ldBootClear/ldBootFail.
function ldBootLeft(){ const f=document.getElementById('flow'); return (f && f.__ldBoot && f.querySelector(':scope>.ld-sk,:scope>.ld-err')) ? f : null; }
function ldBootClear(){ const f=ldBootLeft(); if(f){ f.__ldBoot=false; ldPaint(f, ''); } }
function ldBootFail(e, retry){ const f=ldBootLeft(); if(!f) return; ldPaint(f, errorHtml(e, null, 'Não consegui ler o estado do projeto')); ldWireErr(f, e, 'Não consegui ler o estado do projeto', retry); }
{ const f=document.getElementById('flow'); if(f && !f.firstChild){ ldPaint(f, skeletonHtml('cards', { n:6 })); f.__ldBoot=true;
  requestAnimationFrame(()=>setTimeout(()=>{ if(typeof perfLog==='function') perfLog('[aba] central 1º paint '+Math.round(performance.now())+'ms (boot, esqueleto)'); }, 0)); } }
