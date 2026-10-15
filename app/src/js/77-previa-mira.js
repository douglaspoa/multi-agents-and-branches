// Starfork — 77-previa-mira
// ===== PRÉVIA COM MIRA (⌘4) — redesenho "Semana", 14/10 (mesa-semana-app.md §7, mock starfork-semana-completo.html) =====
// No modo etapas, a Prévia é UMA superfície: alternador Navegador | iPhone | Android, a Mira (tecla M; Esc desliga) e,
// depois de um pedido, "Agora | Antes e depois".
//  - Página web da tarefa (proxy da Prévia, 57-navegador + 58-ambiente): a MESMA página dentro de uma moldura de navegador
//    ou de aparelho (iPhone 390 px, Android 412 px). A Mira é o script de seleção que o proxy injeta na página
//    (src/browser-picker.ts): contorno + rótulo no hover, clique marca com nº (vários). O painel "O que mudar aqui?"
//    mostra, por elemento, o print recortado (salvo em .cardume/refs/mira-N.png pelo snapshot nativo), o seletor, o
//    aparelho, um campo de texto e "tirar". "Mandar pro agente (N)" manda pro TERMINAL da tarefa (tiSend — na fila se a
//    IA estiver no meio de um passo) o pedido numerado, com @anexo e o seletor de cada elemento.
//  - App nativo (projeto mobile — 57-dispositivo, simulador iOS / emulador Android): o painel do aparelho vem pra dentro
//    da Prévia. Lá NÃO há DOM: a Mira é a marcação por REGIÃO do próprio painel (arrastar um retângulo → recorte + tela
//    inteira anexados, "o que mudar nesta área"). Limitação: sem seletor, só coordenadas e o recorte.
//  - Antes e depois: ao mandar, a Prévia tira um print da página como estava; quando a IA edita algo depois disso, a
//    etapa diz "mudou · comparar" e "Antes e depois" mostra o print de antes ao lado da página de agora.
// Fontes únicas: nvSt/nvTogglePick/nvSnap/nvPaint (57-navegador), appRender (58-ambiente), DV/dvSync (57-dispositivo),
// tiSend (64), toast/showErr.

// @mr-puro-inicio (puro: só esc/escA — testado em app/tests/previa-mira.test.mjs)
const MR_DEVS=[ { k:'web', n:'Navegador', w:0 }, { k:'ios', n:'iPhone', w:390 }, { k:'and', n:'Android', w:412 } ];
/** seletor pra LER (o exato vai pro agente): o último pedaço, sem :nth-of-type */
function mrSelShort(sel){ return String(sel||'').split(' > ').pop().replace(/:nth-of-type\(\d+\)/g,'')||'elemento'; }
function mrDevLabel(k){ return k==='ios'?'iPhone':k==='and'?'Android':'navegador'; }
/** O pedido que vai pro terminal. picks: [{ selector, text, note, rel }] · dev: 'web'|'ios'|'and' */
function mrRequestText(picks, dev, url){
  const L=(picks||[]).filter(Boolean);
  if(!L.length) return '';
  const out=[`Pedido pela Mira na Prévia (${mrDevLabel(dev)}${url?' · '+url:''}) · ${L.length} ${L.length===1?'elemento':'elementos'}:`];
  L.forEach((p,i)=>{
    const sel=String(p.selector||p.tag||'elemento').replace(/\s+/g,' ').slice(0,160);
    const tx=String(p.text||'').replace(/\s+/g,' ').trim().slice(0,70);
    const note=String(p.note||'').replace(/\s+/g,' ').trim();
    out.push(`[${i+1}] ${sel}${tx?' "'+tx+'"':''} → ${note||'(sem texto: veja o print e me pergunte o que mudar)'}`);
    out.push(`    anexo ${p.rel?'@'+p.rel:'(sem print)'} (print recortado) · seletor ${sel}`);
  });
  out.push('Mude só esses elementos, nesta branch. Depois diga em uma linha o que mudou — a Prévia recarrega sozinha.');
  return out.join('\n');
}
/** A etapa mudou depois do pedido? (alguma edição/escrita da IA depois do envio) */
function mrChangedOf(sentAt, evs){ if(!(sentAt>0)) return false; return (evs||[]).some(e=>e && ['edit','write'].includes(e.type) && (+new Date(e.ts)||0)>sentAt); }
/** Tecla M (sem modificador, fora de campo de texto e do terminal) → alterna a Mira. */
function mrKeyToggles(e){ if(!e || e.metaKey || e.ctrlKey || e.altKey) return false; if(String(e.key).toLowerCase()!=='m') return false;
  const el=e.target; if(!el) return true; const tag=String(el.tagName||'');
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || el.isContentEditable) return false;
  return !(el.closest && el.closest('.xterm')); }
// @mr-puro-fim

const MR={ dev:{}, cmp:{}, before:{}, notes:{}, sent:{}, devHosted:false };
function mrOn(){ return typeof TE!=='undefined' && TE.on; }
function mrDev(id){ return MR.dev[id] || lsGet('mr:dev') || 'web'; }
/** Projeto nativo (simulador/emulador) com a plataforma escolhida? Então a Prévia mostra o aparelho de verdade. */
function mrNative(t, dev){
  if(dev==='web' || typeof DV==='undefined') return false;
  const info=DV.info[t.id]; if(!info || !info.mobile) return false;
  const plat=dev==='ios'?'ios':'android';
  return (info.platforms||[]).includes(plat);
}
function mrChanged(taskId){ const s=MR.sent[taskId]; if(!s) return false; return mrChangedOf(s, typeof eventsOf==='function'?eventsOf(taskId):[]) || !!MR.before[taskId]&&MR.before[taskId].seen; }
function mrToolsHtml(t){
  const dev=mrDev(t.id), st=typeof nvSt==='function'?nvSt(t.id):{ picking:false }, native=mrNative(t, dev);
  const changed=!!MR.before[t.id] && mrChanged(t.id);
  const cmp=!!MR.cmp[t.id] && changed;
  const seg=MR_DEVS.map(d=>`<button type="button" data-mr="dev" data-v="${d.k}" aria-pressed="${dev===d.k}">${esc(d.n)}</button>`).join('');
  return `<div class="te-seg" role="group" aria-label="Onde ver">${seg}</div>`+
    `<button type="button" class="btn sm mr-mira${st.picking?' on':''}" data-mr="mira" aria-pressed="${st.picking?'true':'false'}" aria-keyshortcuts="M" title="${native?'marcar uma área da tela do aparelho e dizer o que mudar':'passe o mouse no app e clique nas partes que quer mudar (Esc sai)'}">${MR_IC.target}<span>Mira</span><span class="kbd">M</span></button>`+
    (changed?`<div class="te-seg" role="group" aria-label="Comparar"><button type="button" data-mr="cmp" data-v="0" aria-pressed="${!cmp}">Agora</button><button type="button" data-mr="cmp" data-v="1" aria-pressed="${cmp}">Antes e depois</button></div>`:'')+
    `<span class="sp"></span><span class="mr-st">${esc(t.branch||'')}${t.branch?' · ':''}${esc(changed?'recarregada após a alteração da IA':(typeof stMeta==='function'?stMeta(typeof taskSt==='function'?taskSt(t):t.status).pt:''))}</span>`+
    `<button type="button" class="btn ghost sm" data-mr="ext">Abrir no Navegador</button>`;
}
const MR_IC={ target:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.6"/><path d="M8 1.4v2.4M8 12.2v2.4M1.4 8h2.4M12.2 8h2.4" stroke-linecap="round"/></svg>',
  send:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8 13.4 2.8 10.6 13.4 8 9.2z" stroke-linejoin="round"/><path d="M8 9.2 13.4 2.8" stroke-linecap="round"/></svg>' };
function mrPanelHtml(t){
  const st=nvSt(t.id), dev=mrDev(t.id);
  if(!st.picking && !st.picks.length) return '';
  const notes=MR.notes[t.id]||(MR.notes[t.id]={});
  const body=st.picks.length ? st.picks.map((p,i)=>{
    const it=p.item||{}, sel=String(it.selector||it.tag||'elemento');
    const th=p.shot&&p.shot.dataUrl?`<img src="${escA(p.shot.dataUrl)}" alt="recorte do elemento ${i+1}">`:`<span class="mr-thst">${p.shotSt==='tirando'?'print…':p.shotSt==='erro'?'sem print':'—'}</span>`;
    return `<div class="mr-pin"><div class="mr-crop"><span class="mr-n">${i+1}</span><span class="mr-th">${th}</span><span class="mr-cl mono" title="${escA(sel)}">${esc(mrSelShort(sel))}${it.text?' · \''+esc(String(it.text).slice(0,40))+'\'':''}</span></div>`+
      `<div class="mr-sel"><span class="mono">${esc(mrSelShort(sel))} · ${esc(mrDevLabel(dev))}</span><button type="button" class="lnk" data-mr="unpin" data-id="${p.id}">tirar</button></div>`+
      `<textarea class="in mr-in" rows="2" data-mr-note="${p.id}" placeholder="o que mudar neste elemento" aria-label="O que mudar no elemento ${i+1}">${esc(notes[p.id]||'')}</textarea></div>`; }).join('')+
    `<button type="button" class="btn primary mr-send" data-mr="send"${st.sending?' disabled':''}>${MR_IC.send}<span>${st.sending?'Mandando…':'Mandar pro agente ('+st.picks.length+')'}</span></button>`+
    `<div class="mr-foot">Vai pro terminal da tarefa com o print recortado e o seletor de cada elemento.</div>`
    : `<p class="mr-help">Passe o mouse no app: cada parte ganha contorno e nome. Clique para marcar; dá para marcar várias antes de mandar.</p>`;
  return `<aside class="mr-panel" aria-label="O que mudar aqui?"><h3>${MR_IC.target}O que mudar aqui?</h3>${body}</aside>`;
}
/** A superfície (chamada pelo fwRenderPrevia no modo etapas). O iframe da página NÃO é recriado a cada render. */
function mrRender(t, main){
  const dev=mrDev(t.id), native=mrNative(t, dev);
  const changed=!!MR.before[t.id] && mrChanged(t.id), cmp=!!MR.cmp[t.id] && changed;
  const kind=native?'native':cmp?'cmp':'page';
  if(!(main.firstElementChild && main.firstElementChild.classList.contains('mr') && main.firstElementChild.dataset.mrTask===t.id && main.firstElementChild.dataset.kind===kind)){
    main.innerHTML=`<div class="mr" data-mr-task="${escA(t.id)}" data-kind="${kind}"><div class="mr-tools" role="toolbar" aria-label="Prévia"></div><div class="mr-stage"><div class="mr-dev"><div class="mr-bar"><span class="mr-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="mr-url mono"></span></div><div class="mr-scr"><div class="mr-app"></div></div></div><div class="mr-side"></div></div></div>`;
    main.__mrTools=''; main.__mrSide='';
    if(!main.__mrWired){ main.__mrWired=1; main.addEventListener('click', mrClick); main.addEventListener('input', (e)=>{ const n=e.target.dataset&&e.target.dataset.mrNote; if(n!=null){ const tt=fwTaskObj(); if(tt) (MR.notes[tt.id]=MR.notes[tt.id]||{})[n]=e.target.value; } }); }
  }
  const root=main.firstElementChild;
  root.dataset.dev=dev;
  const tools=root.querySelector('.mr-tools'); const th=mrToolsHtml(t); if(main.__mrTools!==th){ main.__mrTools=th; tools.innerHTML=th; }
  const devEl=root.querySelector('.mr-dev'), app=root.querySelector('.mr-app');
  devEl.className='mr-dev mr-'+dev+(native?' mr-native':'');
  if(native) mrHostDevice(t, app, dev);
  else {
    mrReleaseDevice();
    if(typeof nvSt==='function'){ const st=nvSt(t.id); if(st.vp!=='desktop'){ st.vp='desktop'; } }
    if(cmp){ app.innerHTML=''; mrCmpPaint(t, root); }
    else { const b=root.querySelector('.mr-cmp'); if(b) b.remove(); if(typeof appRender==='function') appRender(t.id, app); else if(typeof nvRender==='function') nvRender(t.id, app); }
  }
  const url=root.querySelector('.mr-url'); if(url){ const a=(typeof nvSt==='function'&&nvSt(t.id).addr)||''; const s=a.replace(/^https?:\/\//,''); if(url.textContent!==s) url.textContent=s||'app desta tarefa'; }
  mrSidePaint(t);
  if(typeof cvReqOverlayPaint==='function') cvReqOverlayPaint(t.id);
}
function mrSidePaint(t){
  const main=$id('fwMain'); const side=main&&main.querySelector('.mr-side'); if(!side) return;
  if(mrNative(t, mrDev(t.id))){ if(side.innerHTML){ side.innerHTML=''; main.__mrSide=''; } return; }
  const h=mrPanelHtml(t); if(main.__mrSide===h) return;
  const ae=document.activeElement, keep=ae&&side.contains(ae)&&ae.dataset.mrNote!=null?{ id:ae.dataset.mrNote, s:ae.selectionStart }:null;
  main.__mrSide=h; side.innerHTML=h;
  if(keep){ const el=side.querySelector(`[data-mr-note="${CSS.escape(keep.id)}"]`); if(el){ el.focus({ preventScroll:true }); try{ el.setSelectionRange(keep.s, keep.s); }catch(_){ } } }
}
// antes e depois: o print de antes (imagem) ao lado da página de agora (o iframe continua vivo no lugar dele)
function mrCmpPaint(t, root){
  const scr=root.querySelector('.mr-stage'); let box=root.querySelector('.mr-cmp');
  const b=MR.before[t.id]; if(!b) return; b.seen=true;
  const h=`<div class="mr-cmp"><figure><img src="${escA(b.dataUrl)}" alt="a página antes do pedido"><figcaption>Antes</figcaption></figure><figure class="mr-now"><div class="mr-cmpapp"></div><figcaption>Depois · ${esc(b.label||'pedido pela Mira')}</figcaption></figure></div>`;
  if(!box){ scr.insertAdjacentHTML('afterbegin', h); box=root.querySelector('.mr-cmp'); }
  const host=box.querySelector('.mr-cmpapp'); if(host && typeof appRender==='function') appRender(t.id, host);
}
function mrHostDevice(t, el, dev){
  if(typeof DV==='undefined' || typeof dvSync!=='function') return;
  const plat=dev==='ios'?'ios':'android';
  if(DV.plat[t.id]!==plat){ DV.plat[t.id]=plat; lsSet('dv:plat:'+t.id, plat); DV.sig=''; if(typeof dvStopStream==='function') dvStopStream(); }
  if(DV.host!==el){ if(typeof dvStopStream==='function') dvStopStream(); DV.host=el; DV.sig=''; DV.task=null; el.hidden=false; }
  DV.forced=t.id; MR.devHosted=true; dvSync(t);
}
function mrReleaseDevice(){
  if(!MR.devHosted || typeof DV==='undefined') return;
  MR.devHosted=false; if(typeof dvStopStream==='function') dvStopStream(); DV.host=null; DV.forced=null; DV.sig=''; DV.task=null;
}
async function mrClick(e){
  const b=e.target.closest('[data-mr]'); if(!b) return;
  const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(!t || fwMode!=='previa') return;
  const k=b.dataset.mr;
  if(k==='dev'){ MR.dev[t.id]=b.dataset.v; lsSet('mr:dev', b.dataset.v); if(typeof renderWorkspace==='function') renderWorkspace(); return; }
  if(k==='mira'){ mrToggle(t); return; }
  if(k==='cmp'){ MR.cmp[t.id]=b.dataset.v==='1'; if(typeof renderWorkspace==='function') renderWorkspace(); return; }
  if(k==='ext'){ const a=nvSt(t.id).addr; if(a) openExternal(a); else toast('a prévia ainda não tem endereço — suba o ambiente primeiro','info'); return; }
  if(k==='unpin'){ const st=nvSt(t.id), id=+b.dataset.id; st.picks=st.picks.filter(p=>p.id!==id); if(typeof nvPost==='function') nvPost(st, { cmd:'unmark', id }); nvPaint(t.id); return; }
  if(k==='send'){ mrSend(t); return; }
}
function mrToggle(t){
  if(mrNative(t, mrDev(t.id))){ // aparelho nativo: a marcação por região do painel do dispositivo
    if(typeof DV!=='undefined'){ DV.mark=DV.mark?null:{ start:null, rect:null }; DV.sig=''; if(typeof dvRender==='function') dvRender(); toast(DV.mark?'arraste um retângulo na tela do aparelho e diga o que mudar':'mira desligada','info'); }
    return;
  }
  if(typeof nvTogglePick==='function') nvTogglePick(t.id);
}
async function mrSend(t){
  const st=nvSt(t.id); if(!st.picks.length || st.sending) return;
  if(st.picks.some(p=>p.shotSt==='tirando')){ toast('espere os prints terminarem','info'); return; }
  const notes=MR.notes[t.id]||{};
  const picks=st.picks.map(p=>({ selector:(p.item||{}).selector, tag:(p.item||{}).tag, text:(p.item||{}).text, note:notes[p.id]||'', rel:p.shot&&p.shot.rel }));
  const dev=mrDev(t.id), txt=mrRequestText(picks, dev, st.addr);
  st.sending=true; nvPaint(t.id);
  // o "antes": print da página como está (as marcações saem antes — nvSnap esconde e devolve)
  let before=null;
  try{ if(st.frame){ const fr=st.frame.getBoundingClientRect(); const rect=typeof nvShotRect==='function'?nvShotRect({ left:Math.max(0,fr.left), top:Math.max(0,fr.top), right:Math.min(innerWidth,fr.right), bottom:Math.min(innerHeight,fr.bottom) }, { x:0, y:0, w:fr.width, h:fr.height }):null;
    if(rect) before=await nvSnap(t.id, rect, 'attachment', { text:'antes', tag:'pagina' }); } }catch(_){ }
  let ok=false; try{ ok=typeof tiSend==='function' ? await tiSend(t.id, txt) : false; }finally{ st.sending=false; }
  if(ok){
    if(before && before.dataUrl) MR.before[t.id]={ dataUrl:before.dataUrl, label:picks.map(p=>mrSelShort(p.selector||p.tag)).join(', ') };
    MR.sent[t.id]=Date.now(); MR.cmp[t.id]=false;
    st.picks=[]; MR.notes[t.id]={}; st.picking=false; if(typeof nvPost==='function'){ nvPost(st, { cmd:'clear' }); nvPost(st, { cmd:'pick', on:false }); }
    toast('mandado pro terminal da tarefa com '+(picks.length>1?'os prints':'o print')+' — quando a IA alterar, compare em "Antes e depois"', 'ok');
  }
  nvPaint(t.id); if(typeof renderWorkspace==='function') renderWorkspace();
}
// o painel acompanha cada marcação da página (o 57 pinta o dele; aqui só a caixa "O que mudar aqui?" e o botão da Mira)
if(typeof nvPaint==='function'){ const base=nvPaint; nvPaint=function(taskId){ base(taskId); try{ const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(t && t.id===taskId && mrOn() && fwMode==='previa'){ mrSidePaint(t); const main=$id('fwMain'); const tools=main&&main.querySelector('.mr-tools'); if(tools){ const h=mrToolsHtml(t); if(main.__mrTools!==h){ main.__mrTools=h; tools.innerHTML=h; } } } }catch(_){ } }; }
// print do elemento marcado pela Mira: mira-N.png (o nome que o pedido cita)
if(typeof nvShotReq==='function'){ const base=nvShotReq; nvShotReq=function(taskId, item, rect){ const r=base(taskId, item, rect); try{ if(mrOn() && fwMode==='previa' && !(item&&item.text==='antes')) r.name='mira-'+Math.max(1, nvSt(taskId).picks.length)+'.png'; else if(item&&item.text==='antes') r.name='mira-antes.png'; }catch(_){ } return r; }; }
// tecla M na Prévia (fora de campo e do terminal); Esc já desliga a Mira (20-workspace → nvEscape)
document.addEventListener('keydown', (e)=>{
  if(!mrOn() || typeof fwMode==='undefined' || fwMode!=='previa' || !mrKeyToggles(e)) return;
  const t=fwTaskObj(); if(!t) return;
  e.preventDefault(); mrToggle(t);
});
/** Saiu da Prévia (75 chama a cada render): devolve o painel do aparelho pro lugar dele. */
function mrAfterRender(){ if(MR.devHosted && !(mrOn() && fwMode==='previa')) mrReleaseDevice(); }
