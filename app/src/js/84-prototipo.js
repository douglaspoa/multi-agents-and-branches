// Starfork — 84-prototipo: PROTÓTIPOS (Opção A aprovada pelo dono em 27/10 — scratchpad/starfork-prototipo.html, passos 1–6).
// Duas abas (nunca modal):
//   'prototipos' — a página da lateral (TRABALHO › Protótipos): criar (IA gera · Em branco · De uma tela existente) + Recentes
//   'prototipo'  — UMA aba por protótipo ('prototipo:<id>'): quadro com zoom/pan, telas Desktop/Celular renderizando o
//                  HTML/CSS de cada uma num iframe sandbox SEM scripts, área "Referências" de colagem, ferramentas
//                  V R T P I K C, blocos `data-blk` com HTML/CSS editável (recolhido), colagem (imagem/caixa/texto/caneta/
//                  componente) com camadas, alfinetes de comentário com fio, e painel Tela · Colagem · Comentários · IA.
// Dados: `<repo>/.cardume/prototipos/<id>/prototipo.json` + assets/ + versions/ (prototipos.rs). Salva sozinho (debounce):
// a 1ª mudança de cada abertura vira uma versão nova (a anterior fica em versions/), o resto regrava a mesma.
// A IA (gerar, olhar, crítica), "Comparar com protótipo" na Prévia e a ponte da Nova demanda são da OUTRA frente:
// daqui saem os ganchos window.openPrototipo / protoNew / protoState / protoApplyScreens / protoSnapshot e o evento
// `sf:proto-salvo` {id, version}; daqui chamam window.protoGerarIA(prompt, {id, proto}), window.protoIA
// ({ panelHtml(proto), wire|bind(el, proto), olhar?(proto) }) e window.protoParaDemanda(id), quando existirem.

// @proto-puro-inicio (funções puras — testadas em app/tests/prototipo.test.mjs)
const PT_TELAS={ desk:{ name:'Desktop · 1280', w:1280, h:840 }, cel:{ name:'Celular · 390', w:390, h:844 }, tab:{ name:'Tablet · 820', w:820, h:1180 } };
const PT_REF={ id:'ref', name:'Referências (colagem)', w:640, h:844 };
const PT_GAP=80;
// id novo: p-<tempo em base 36><2 letras> (vira nome de pasta: só [a-z0-9-])
function ptNewId(now, rnd){ return 'p-'+Math.floor(now).toString(36)+Math.floor((rnd==null?Math.random():rnd)*1296).toString(36).padStart(2,'0'); }
function ptTela(id, extra){ const d=PT_TELAS[id]||PT_TELAS.desk; return Object.assign({ id, name:d.name, w:d.w, h:d.h, html:'', css:'' }, extra||{}); }
// protótipo novo no modelo comum (BRIEF): telas = desktop + celular (ou só celular)
function ptNovo(o, now, who){
  o=o||{}; const so=o.only==='cel';
  const title=String(o.title||'').trim() || (o.prompt ? ptTituloDoPedido(o.prompt) : 'Protótipo sem nome');
  return { id:o.id||ptNewId(now), title, version:1, createdAt:now, updatedAt:now, createdBy:who||'Você',
    source:['ia','branco','print','previa','url'].includes(o.source)?o.source:'branco', prompt:String(o.prompt||''), taskId:o.taskId||null,
    screens:Array.isArray(o.screens)&&o.screens.length?o.screens:(so?[ptTela('cel')]:[ptTela('desk'), ptTela('cel')]), els:[], pins:[], history:[] };
}
// "tela de checkout com cupom" → "Tela de checkout com cupom" (curto, 1ª letra maiúscula)
function ptTituloDoPedido(p){ const s=String(p||'').replace(/\s+/g,' ').trim().slice(0,48); return s ? s[0].toUpperCase()+s.slice(1) : 'Protótipo sem nome'; }
function ptOpenPins(p){ return ((p&&p.pins)||[]).filter(x=>!x.resolved && String(x.text||'').trim()).length; }
// versão nova (antes de gravar): sobe o número e anota quem/por quê no histórico
function ptBump(p, by, note, now){ p.version=(+p.version||1)+1; (p.history=p.history||[]).push({ version:p.version, at:now, by:by||'Você', note:note||'edição' }); if(p.history.length>200) p.history.splice(0, p.history.length-200); return p.version; }
// telas que chegam (IA, outra frente) entram por id: substitui a que existe (mantém nome/tamanho se não vier), novas vão pro fim
function ptMergeScreens(old, inc){
  const out=(old||[]).map(s=>Object.assign({}, s));
  for(const s of (inc||[])){ if(!s||!s.id) continue; const i=out.findIndex(x=>x.id===s.id); const base=i>=0?out[i]:ptTela(PT_TELAS[s.id]?s.id:'desk', { id:s.id });
    const m=Object.assign({}, base, s, { html:String(s.html!=null?s.html:base.html||''), css:String(s.css!=null?s.css:base.css||'') }); if(i>=0) out[i]=m; else out.push(m); }
  return out;
}
// onde cada tela fica no quadro: lado a lado com folga, Referências no fim
function ptLayout(screens){ let x=0; const L=[]; for(const s of (screens||[])){ L.push({ id:s.id, x, y:0, w:+s.w||1280, h:+s.h||840, name:s.name||s.id }); x+=(+s.w||1280)+PT_GAP; }
  L.push({ id:'ref', x, y:0, w:PT_REF.w, h:PT_REF.h, name:PT_REF.name, ref:true }); return L; }
// zoom que cabe: as TELAS na área visível (com a área de Referências só quando ela tem colagem), no máx. 100%
function ptFit(L, hw, hh, withRef){ const T=L.filter(a=>withRef||!a.ref); const last=T[T.length-1]||L[0]; const W=last.x+last.w, H=Math.max(...T.map(a=>a.h), 1)+30;
  return Math.max(.08, Math.min((hw-90)/W, (hh-90)/H, 1)); }
// @nome conhecido vira destaque (só nomes do time; sem time não há menção)
function ptMentionsIn(text, names){ const s=String(text||''); return (names||[]).filter(n=>n && new RegExp('@'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(s)); }
// o que a lista mostra de cada protótipo (meta curta)
function ptMetaTx(p){ const n=+p.openPins||0; const bits=[p.createdBy||'', 'v'+(p.version||1)];
  bits.push(p.taskId?'virou tarefa':n?`${n} comentário${n>1?'s':''} aberto${n>1?'s':''}`:'sem comentários abertos'); return bits.filter(Boolean).join(' · '); }
function ptAgoTx(ms, now){ const s=((now||Date.now())-ms)/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return 'há '+Math.floor(s/60)+' min'; if(s<86400) return 'há '+Math.floor(s/3600)+' h'; return 'há '+Math.floor(s/86400)+' d'; }
// nome do arquivo de uma imagem colada
function ptAssetName(type, now, rnd){ const ext=({ 'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp', 'image/svg+xml':'svg' })[type]||'png'; return 'img-'+Math.floor(now).toString(36)+Math.floor((rnd==null?Math.random():rnd)*1296).toString(36)+'.'+ext; }
// @proto-puro-fim

// ---------------------------------------------------------------- ícones (traço 16px, mesmo do IC)
const PT_IC={
  proto:'<rect x="2" y="2.8" width="12" height="10.4" rx="1.4"/><path d="M2 6h12M5.6 6v7.2"/>',
  V:'<path d="M3.6 2.4l8.6 5-3.8 1.2-1.8 3.8z" stroke-linejoin="round"/>', R:'<rect x="2.8" y="3.6" width="10.4" height="8.8" rx="1.2"/>',
  T:'<path d="M3.4 4.2V3h9.2v1.2M8 3v10M6 13h4" stroke-linecap="round"/>', P:'<path d="M2.8 13.2c2.6-.7 4-3.3 6-6l2.6-2.6 2 2-2.6 2.6c-2.6 2-5.3 3.4-6 6z" stroke-linejoin="round"/>',
  I:'<rect x="2" y="3.4" width="12" height="9.2" rx="1.2"/><circle cx="6" cy="6.8" r="1.2"/><path d="M14 10.6l-3.4-3.4-5.4 5.4" stroke-linejoin="round"/>',
  K:'<rect x="2.2" y="2.2" width="5" height="5" rx=".7"/><rect x="8.8" y="2.2" width="5" height="5" rx=".7"/><rect x="2.2" y="8.8" width="5" height="5" rx=".7"/><path d="M11.3 8.8v5M8.8 11.3h5" stroke-linecap="round"/>',
  C:'<path d="M2.6 3.4h10.8v7.4H6.2l-3.6 2.8z" stroke-linejoin="round"/>',
  spark:'<path d="M8 2v4M8 10v4M2 8h4M10 8h4" stroke-linecap="round"/>', eye:'<path d="M1.6 8S4.2 3.6 8 3.6 14.4 8 14.4 8 11.8 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
  err:'<circle cx="8" cy="8" r="6"/><path d="M8 4.8v4M8 10.8v.1" stroke-linecap="round"/>', trash:'<path d="M3 4.6h10M6.4 4.6V3h3.2v1.6M4.4 4.6l.6 8.4h6l.6-8.4" stroke-linejoin="round"/>',
  blank:'<rect x="3" y="2.4" width="10" height="11.2" rx="1.2"/>',
};
// cor do tema (token de css/10-base.css) resolvida agora — o iframe e o canvas não enxergam var(--x)
function ptTok(n, dflt){ try{ const v=getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v||dflt||'currentColor'; }catch(_){ return dflt||'currentColor'; } }
function ptI(k, sz){ return `<svg viewBox="0 0 16 16" width="${sz||16}" height="${sz||16}" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${PT_IC[k]||''}</svg>`; }
function ptE(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function ptK(k){ return `<kbd class="ptkbd">${ptE(k)}</kbd>`; }

// ---------------------------------------------------------------- estado
const PT={ list:null, listRepo:null, listErr:'', listLoading:false, listShowAll:false,
  id:null, cur:null, loading:false, loadErr:'', gen:null, genPrompt:'', genSeq:0,
  tool:'V', sel:null, panel:'props', zoom:null, panX:0, panY:0, hist:[], openPin:null, draft:'', focusDraft:false, crop:false, compMenu:false, keysOpen:false,
  save:{ timer:0, busy:false, again:false, st:'ok', err:'' }, bumped:false, assets:{}, assetsAsk:{}, orig:{}, space:false, drag:null, hov:null, seq:0, fixFlash:0 };
window.PT_DEBUG=PT;

// erro em frase (humanErr devolve { msg }); sem ele, o texto cru
function ptErrTx(e, ctx){ try{ if(typeof humanErr==='function'){ const h=humanErr(e, ctx); return String((h&&h.msg)||h||''); } }catch(_){ } return (ctx?ctx+': ':'')+String((e&&e.message)||e||'erro sem detalhe'); }
function ptMe(){ try{ const n=typeof personMeName==='function'?personMeName():''; return (n&&n!=='você')?n:'Você'; }catch(_){ return 'Você'; } }
// @menção só com time ativo (nuvem): os nomes das pessoas do time; sem time, ninguém pra mencionar
function ptTeamNames(){
  try{
    const t=typeof teamActive==='function'?teamActive():null; if(!t) return [];
    const mm=((typeof cloudData!=='undefined'&&cloudData&&cloudData.teamMembers)||{})[t.id]||[];
    const me=typeof cloudUserId==='function'?cloudUserId():'';
    return [...new Set(mm.filter(m=>m.user_id!==me).map(m=>typeof personName==='function'?personFirst(personName(m.user_id,{ noYou:true })):'').filter(n=>n && !/carregando|sem nome/i.test(n)))].slice(0,12);
  }catch(_){ return []; }
}
function ptAv(name){
  const n=String(name||'?'); const ini=typeof personInitials==='function'?personInitials(n):n.slice(0,2).toUpperCase();
  const bg=n==='IA'?'var(--accent)':(typeof personHue==='function'?personHue(n):'var(--muted)');
  return `<span class="pt-av" style="background:${bg}" title="${ptE(n)}" aria-hidden="true">${n==='IA'?((typeof IC!=='undefined'&&IC.starfork)||'IA'):ptE(ini)}</span>`;
}
function ptMent(s){ let h=ptE(s); for(const n of ptTeamNames()) h=h.replace(new RegExp('@'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'), `<span class="pt-ment">@${ptE(n)}</span>`); return h; }
function ptTabOn(kind){ const t=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null; return !!(t && t.kind===kind); }
function ptActive(){ return ptTabOn('prototipo') && !!PT.cur; }
function ptScreen(id){ return PT.cur && (PT.cur.screens||[]).find(s=>s.id===id); }
function ptAbDims(id){ if(id==='ref') return PT_REF; return ptScreen(id)||null; }

// ---------------------------------------------------------------- invocações (front ↔ prototipos.rs)
function ptInv(cmd, args){ const f=typeof invokeQuiet==='function'?invokeQuiet:invoke; return f(cmd, Object.assign({ repo:(typeof state!=='undefined'&&state.repo)||null }, args||{})); }
async function ptListLoad(force){
  const repo=(typeof state!=='undefined'&&state.repo)||null;
  if(!repo){ PT.list=[]; PT.listRepo=null; PT.listErr=''; ptSideCount(); return; }
  if(PT.listLoading && !force) return;
  PT.listLoading=true; if(PT.listRepo!==repo) PT.list=null; PT.listRepo=repo; ptListPaint();
  try{ PT.list=await ptInv('proto_list'); PT.listErr=''; }
  catch(e){ PT.listErr=ptErrTx(e, 'Ler os protótipos'); if(!PT.list) PT.list=null; }
  finally{ PT.listLoading=false; }
  ptSideCount(); ptListPaint();
}
function ptSideCount(){ const e=typeof $id==='function'?$id('protoCnt'):null; if(!e) return; const n=(PT.list||[]).length; e.hidden=!n; const tx=n>99?'99+':String(n||''); if(e.textContent!==tx) e.textContent=tx; }
// a lateral (76 semSideSync) chama a cada render: trocou de projeto → relê a lista (sem polling)
function ptSideSync(){ const repo=(typeof state!=='undefined'&&state.repo)||null; if(repo!==PT.listRepo && !PT.listLoading) ptListLoad(); }
window.ptSideSync=ptSideSync;

// ---------------------------------------------------------------- abas
if(typeof VIEW_META!=='undefined'){
  VIEW_META.prototipos={ title:'Protótipos', icon:PT_IC.proto };
  VIEW_META.prototipo={ title:'Protótipo', icon:PT_IC.proto };
  VIEW_OVERLAY.prototipos='protoListOverlay'; VIEW_OVERLAY.prototipo='protoOverlay';
}
if(typeof SEM_NAV!=='undefined'){ SEM_NAV.prototipos='protoBtn'; SEM_NAV.prototipo='protoBtn'; } // a lateral marca o item (76)
if(typeof viewOpen==='function' && !viewOpen.__proto){ const vo=viewOpen; viewOpen=function(kind, tab){
    if(kind==='prototipos'){ ptListPaint(true); if(typeof ovShow==='function') ovShow('protoListOverlay'); requestAnimationFrame(ptThumbScale); ptListLoad(); return; }
    if(kind==='prototipo'){ if(typeof ovShow==='function') ovShow('protoOverlay'); ptOpenInner(tab); return; }
    return vo.apply(this, arguments); }; viewOpen.__proto=true; }
function openPrototipos(){ openTab('prototipos'); }
function openPrototipo(id){
  if(!id) return;
  const tid='prototipo:'+id; let tab=tabById(tid);
  const it=(PT.list||[]).find(x=>x.id===id); const tt=(PT.cur&&PT.cur.id===id)?PT.cur.title:(it&&it.title)||'Protótipo';
  if(!tab){ tab={ id:tid, kind:'prototipo', protoId:id, title:('Protótipo: '+tt).slice(0,28) }; TABS.push(tab); }
  activateTab(tid);
}
function ptTabTitle(){ if(!PT.cur) return; const t=tabById('prototipo:'+PT.cur.id); if(!t) return; const nt=('Protótipo: '+PT.cur.title).slice(0,28); if(t.title!==nt){ t.title=nt; if(typeof renderTabs==='function') renderTabs(); } }
bindClick('protoBtn', openPrototipos);

// ---------------------------------------------------------------- abrir / carregar
async function ptOpenInner(tab){
  const id=tab&&tab.protoId; if(!id) return;
  if(PT.cur && PT.cur.id===id && !PT.loadErr){ ptRender(true); return; }
  await ptFlush();
  PT.id=id; PT.cur=null; PT.loading=true; PT.loadErr=''; ptResetUi(); ptRender(true);
  try{ const p=await ptInv('proto_read', { id }); if(PT.id!==id) return; ptAdopt(p); }
  catch(e){ if(PT.id!==id) return; PT.loadErr=ptErrTx(e, 'Abrir o protótipo'); }
  finally{ if(PT.id===id){ PT.loading=false; ptRender(true); } }
}
function ptResetUi(){ Object.assign(PT, { tool:'V', sel:null, panel:'props', zoom:null, panX:0, panY:0, hist:[], openPin:null, draft:'', crop:false, compMenu:false, keysOpen:false, bumped:false, orig:{}, hov:null }); }
function ptAdopt(p){
  p.screens=Array.isArray(p.screens)?p.screens:[]; p.els=Array.isArray(p.els)?p.els:[]; p.pins=Array.isArray(p.pins)?p.pins:[]; p.history=Array.isArray(p.history)?p.history:[];
  PT.cur=p; PT.id=p.id; PT.seq=Math.max(0, ...p.els.map(e=>+e.id||0), ...p.pins.map(x=>+x.id||0));
  // protótipo recém-criado (v1, sem histórico): a 1ª edição continua v1
  PT.bumped=(+p.version||1)===1 && !p.history.length;
  ptTabTitle(); ptLoadAssets();
}
function ptLoadAssets(){
  if(!PT.cur) return; const id=PT.cur.id;
  for(const e of PT.cur.els){ const s=e.src; if(e.type!=='img' || !s || !/^assets\//.test(s) || PT.assets[id+'|'+s] || PT.assetsAsk[id+'|'+s]) continue;
    PT.assetsAsk[id+'|'+s]=1;
    ptInv('proto_asset_url', { id, path:s }).then(u=>{ PT.assets[id+'|'+s]=u; if(PT.cur&&PT.cur.id===id) ptPaintLayers(); }).catch(()=>{ PT.assets[id+'|'+s]=''; }); }
}
function ptSrc(e){ const s=String(e.src||''); if(/^assets\//.test(s)) return PT.assets[(PT.cur&&PT.cur.id)+'|'+s]||''; return /^data:image\//.test(s)?s:''; }

// ---------------------------------------------------------------- salvar sozinho (debounce) + versão
function ptSnap(){ if(!PT.cur) return; PT.hist.push(JSON.stringify({ screens:PT.cur.screens, els:PT.cur.els, pins:PT.cur.pins })); if(PT.hist.length>60) PT.hist.shift(); }
function ptUndo(){ const h=PT.hist.pop(); if(!h||!PT.cur){ toast('Nada pra desfazer','info'); return; } Object.assign(PT.cur, JSON.parse(h)); PT.sel=null; PT.crop=false; PT.openPin=null; ptChanged(true); ptRender(); toast('Desfeito','info'); }
function ptChanged(silent){
  if(!PT.cur) return;
  if(!PT.bumped){ ptBump(PT.cur, ptMe(), 'edição', Date.now()); PT.bumped=true; }
  PT.save.st='dirty'; clearTimeout(PT.save.timer); PT.save.timer=setTimeout(ptSaveNow, 700);
  if(!silent) ptPaintFoot();
}
async function ptSaveNow(){
  clearTimeout(PT.save.timer); PT.save.timer=0;
  const p=PT.cur; if(!p) return;
  if(PT.save.busy){ PT.save.again=true; return; }
  PT.save.busy=true; PT.save.st='saving'; ptPaintFoot();
  try{
    const r=await ptInv('proto_write', { id:p.id, json:p });
    if(r && r.updatedAt) p.updatedAt=r.updatedAt;
    PT.save.st='ok'; PT.save.err='';
    const it=(PT.list||[]).find(x=>x.id===p.id);
    if(it){ Object.assign(it, { title:p.title, updatedAt:p.updatedAt, version:p.version, openPins:ptOpenPins(p), taskId:p.taskId||null }); PT.list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); }
    PT.selfSave=true; try{ window.dispatchEvent(new CustomEvent('sf:proto-salvo', { detail:{ id:p.id, version:p.version } })); }catch(_){ } PT.selfSave=false;
  }catch(e){ PT.save.st='err'; PT.save.err=ptErrTx(e, 'Salvar o protótipo'); }
  finally{ PT.save.busy=false; ptPaintFoot(); if(PT.save.again){ PT.save.again=false; ptSaveNow(); } }
}
async function ptFlush(){ if(PT.save.timer){ await ptSaveNow(); } }

// ---------------------------------------------------------------- criar
async function protoNew(o){
  o=Object.assign({}, o||{});
  const repo=(typeof state!=='undefined'&&state.repo)||null;
  if(!repo){ toast('Abra um projeto primeiro — o protótipo mora dentro dele.','warn'); return null; }
  const p=ptNovo(o, Date.now(), ptMe());
  try{ await ptInv('proto_write', { id:p.id, json:p }); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Criar o protótipo'); return null; }
  PT.list=[Object.assign({ id:p.id, title:p.title, updatedAt:Date.now(), version:1, createdBy:p.createdBy, openPins:0, taskId:p.taskId, source:p.source, thumb:null })].concat((PT.list||[]).filter(x=>x.id!==p.id));
  ptSideCount();
  await ptFlush(); ptAdopt(p); ptResetUi(); PT.bumped=true; PT.loading=false; PT.loadErr='';
  if(p.source==='branco') PT.tool='R';
  openPrototipo(p.id);
  if(p.source==='ia' && o.gerar!==false) ptGenerate(p.id, p.prompt);
  return p.id;
}
// IA gera a 1ª versão (outra frente: window.protoGerarIA). Sem ela: "em breve".
async function ptGenerate(id, prompt){
  if(typeof window.protoGerarIA!=='function'){ toast('A IA que desenha a 1ª versão chega em breve — comece em branco ou de uma tela que já existe.','info'); return; }
  const tok=++PT.genSeq; PT.gen={ tok, id, prompt, st:'loading', err:'', acts:[] }; ptRender();
  try{
    const taskId=(PT.cur&&PT.cur.id===id&&PT.cur.taskId)||null;
    const r=await Promise.resolve(window.protoGerarIA(prompt, { repo:(typeof state!=='undefined'&&state.repo)||null, taskId, id,
      onActivity:(l, acts)=>{ if(!PT.gen||PT.gen.tok!==tok) return; PT.gen.acts=Array.isArray(acts)?acts:PT.gen.acts.concat([l]); ptRender(); } }));
    if(!PT.gen || PT.gen.tok!==tok) return; // parado (esc)
    const sc=Array.isArray(r)?r:(r&&Array.isArray(r.screens)?r.screens:null);
    if(r && !Array.isArray(r) && r.title && PT.cur && PT.cur.id===id && PT.cur.title===ptTituloDoPedido(prompt)){ PT.cur.title=String(r.title).slice(0,80); ptTabTitle(); }
    PT.gen=null;
    if(sc && sc.length) await protoApplyScreens(id, sc, 'IA gerou a 1ª versão');
    ptRender(); toast(r&&r.notes?'1ª versão pronta · '+String(r.notes).slice(0,120):'1ª versão pronta · edite à vontade','ok');
  }catch(e){
    if(!PT.gen || PT.gen.tok!==tok) return;
    if(e && e.stopped){ PT.gen=null; ptRender(); toast('Geração parada · a tela ficou em branco','info'); return; }
    PT.gen={ tok, id, prompt, st:'erro', err:ptErrTx(e, 'Gerar o protótipo'), raw:e, acts:[] }; ptRender();
  }
}
function ptGenCancel(){ if(!PT.gen) return; PT.gen=null; PT.genSeq++; try{ if(typeof window.protoGerarParar==='function') window.protoGerarParar(); }catch(_){ } ptRender(); toast('Geração parada · a tela ficou em branco','info'); }

// telas novas (IA ou outra frente): grava como versão nova e repinta. Funciona com o protótipo aberto ou não.
async function protoApplyScreens(id, screens, note){
  if(!id || !Array.isArray(screens)) return null;
  if(PT.cur && PT.cur.id===id){
    ptSnap(); PT.cur.screens=ptMergeScreens(PT.cur.screens, screens); ptBump(PT.cur, 'IA', note||'IA ajustou', Date.now()); PT.bumped=true;
    await ptSaveNow(); PT.fixFlash=Date.now(); ptRender(); return PT.cur.version;
  }
  const p=await ptInv('proto_read', { id }); p.screens=ptMergeScreens(p.screens, screens); ptBump(p, 'IA', note||'IA ajustou', Date.now());
  const r=await ptInv('proto_write', { id, json:p });
  try{ window.dispatchEvent(new CustomEvent('sf:proto-salvo', { detail:{ id, version:p.version } })); }catch(_){ }
  ptListLoad(true); return (r&&r.version)||p.version;
}
function protoState(){ return PT.cur; }

// ---------------------------------------------------------------- HTML isolado de cada tela (iframe sandbox, sem scripts)
// seleção/destaque dentro do iframe da tela, nas cores do tema (acento = seleção, ok = correção aplicada)
function ptFrameCss(){ const a=ptTok('--accent'), ok=ptTok('--ok');
  return `html,body{margin:0}[data-blk].sf-hov{outline:calc(1px*var(--sfk,1)) dashed color-mix(in srgb,${a} 80%,transparent)!important;outline-offset:calc(2px*var(--sfk,1))}[data-blk].sf-sel{outline:calc(2px*var(--sfk,1)) solid ${a}!important;outline-offset:calc(2px*var(--sfk,1))}.sf-fix{animation:sffix 1.6s ease-out 1}@keyframes sffix{0%{box-shadow:0 0 0 5px ${ok}}100%{box-shadow:0 0 0 0 transparent}}@media (prefers-reduced-motion:reduce){.sf-fix{animation:none;outline:3px solid ${ok}}}`; }
// o sandbox já impede script; tirar <script>/on*/javascript: também evita o aviso "Blocked script execution" no console
function ptNoScripts(html){
  const h=String(html||''); if(!/<script|\son\w+\s*=|javascript:/i.test(h)) return h;
  const t=document.createElement('template'); t.innerHTML=h; t.content.querySelectorAll('script').forEach(n=>n.remove());
  t.content.querySelectorAll('*').forEach(n=>{ for(const a of [...n.attributes]){ const k=a.name.toLowerCase(); if(k.startsWith('on') || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name); } });
  return t.innerHTML;
}
function ptSrcdoc(s){ return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${ptFrameCss()}</style><style>${String(s.css||'').replace(/<\/style/gi,'<\\/style')}</style></head><body>${ptNoScripts(s.html)}</body></html>`; }
// HTML de colagem (componente/caixa) vive no DOM do app: sem script, sem on*, sem javascript:
function ptSanitize(html){
  const t=document.createElement('template'); t.innerHTML=String(html||'');
  t.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(n=>n.remove());
  t.content.querySelectorAll('*').forEach(n=>{ for(const a of [...n.attributes]){ const k=a.name.toLowerCase(); if(k.startsWith('on') || ((k==='href'||k==='src'||k==='xlink:href'||k==='action') && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name); } });
  return t.innerHTML;
}
function ptFrameOf(ab){ const n=document.querySelector(`#ptBoard .pt-ab[data-ab="${CSS.escape(ab)}"] iframe`); return n; }
function ptFrameDoc(ab){ try{ const f=ptFrameOf(ab); return f&&f.contentDocument; }catch(_){ return null; } }
function ptBlkAt(ab, x, y){ const d=ptFrameDoc(ab); if(!d||!d.elementFromPoint) return null; const n=d.elementFromPoint(x, y); return n&&n.closest?n.closest('[data-blk]'):null; }
function ptFrameMarks(){
  const blk=PT.sel&&PT.sel.startsWith('blk:')?PT.sel.slice(4):null;
  const k=String(1/(($id('ptBoard')||{})._s||1));
  document.querySelectorAll('#ptBoard .pt-ab iframe').forEach(f=>{ let d; try{ d=f.contentDocument; }catch(_){ d=null; } if(!d||!d.body) return; d.documentElement.style.setProperty('--sfk', k);
    d.querySelectorAll('.sf-sel').forEach(n=>{ if(n.getAttribute('data-blk')!==blk) n.classList.remove('sf-sel'); });
    if(blk) d.querySelectorAll(`[data-blk="${CSS.escape(blk)}"]`).forEach(n=>n.classList.add('sf-sel'));
    if(PT.fixFlash && Date.now()-PT.fixFlash<1500){ d.querySelectorAll('[data-blk]').forEach(n=>{ n.classList.remove('sf-fix'); void n.offsetWidth; n.classList.add('sf-fix'); }); } });
}
// rótulo legível do alvo de um comentário (botão "Pagar", campo, bloco cupom…)
function ptBlkLabel(n){
  if(!n) return 'ponto livre'; const b=n.getAttribute('data-blk')||'';
  const tag=(n.tagName||'').toLowerCase(); const kind=tag==='button'||/btn|botao|pagar/.test(b)?'botão':tag==='input'||tag==='label'||/campo|input/.test(b)?'campo':'bloco';
  const tx=String(n.getAttribute('aria-label')||n.textContent||'').replace(/\s+/g,' ').trim().slice(0,28);
  return tx?`${kind} “${tx}”`:`${kind} ${b}`;
}

// editar UM bloco em todas as telas que o têm (vale em Desktop e Celular)
function ptBlkGet(blk){
  for(const s of (PT.cur&&PT.cur.screens)||[]){ const t=document.createElement('template'); t.innerHTML=s.html||''; const n=t.content.querySelector(`[data-blk="${CSS.escape(blk)}"]`);
    if(n) return { html:n.innerHTML.replace(/>\s*</g,'>\n<').trim(), style:n.getAttribute('style')||'' }; }
  return null;
}
function ptBlkSet(blk, html, style){
  let n=0;
  for(const s of PT.cur.screens){ const t=document.createElement('template'); t.innerHTML=s.html||''; const L=t.content.querySelectorAll(`[data-blk="${CSS.escape(blk)}"]`); if(!L.length) continue;
    L.forEach(x=>{ if(html!=null) x.innerHTML=html; if(style!=null){ if(String(style).trim()) x.setAttribute('style', style); else x.removeAttribute('style'); } }); s.html=t.innerHTML; n+=L.length; }
  return n;
}
function ptBlocks(ab){ const s=ptScreen(ab); if(!s) return []; const t=document.createElement('template'); t.innerHTML=s.html||''; return [...new Set([...t.content.querySelectorAll('[data-blk]')].map(n=>n.getAttribute('data-blk')))]; }

// render da tela pra recorte/antes-depois (outra frente): SVG foreignObject → PNG. Se o WebView sujar o canvas,
// devolve o próprio SVG (data URL), que também serve em <img>.
async function protoSnapshot(screenId){
  const p=PT.cur; const s=p&&(p.screens||[]).find(x=>x.id===(screenId||(p.screens[0]||{}).id)); if(!s) throw new Error('tela não encontrada');
  const doc=new DOMParser().parseFromString(ptSrcdoc(s).replace(ptFrameCss(),''), 'text/html');
  doc.querySelectorAll('script,iframe,object,embed').forEach(n=>n.remove());
  const extra=(p.els||[]).filter(e=>e.screen===s.id && !e.hidden).map(e=>{ const st=`position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;${e.crop?`clip-path:inset(${e.crop.t}px ${e.crop.r}px ${e.crop.b}px ${e.crop.l}px);`:''}`;
    if(e.type==='img'){ const u=ptSrc(e); return u?`<img src="${ptE(u)}" style="${st}object-fit:cover"/>`:''; }
    if(e.type==='text') return `<div style="${st}font:600 15px sans-serif;color:${ptTok('--on-color-dark')}">${ptE(e.text||'')}</div>`;
    if(e.type==='pen') return `<svg style="${st}overflow:visible" viewBox="0 0 ${e.w} ${e.h}"><path d="${ptE(e.d||'')}" fill="none" stroke="${ptTok('--crit')}" stroke-width="3" stroke-linecap="round"/></svg>`;
    return `<div style="${st}">${ptSanitize(e.html||'')}</div>`; }).join('');
  if(extra){ const w=doc.createElement('div'); w.setAttribute('style','position:absolute;left:0;top:0;width:100%;height:100%'); w.innerHTML=extra; doc.body.appendChild(w); doc.body.style.position='relative'; }
  const xhtml=new XMLSerializer().serializeToString(doc.documentElement);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}" height="${s.h}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  try{
    const img=new Image(); img.decoding='sync';
    await new Promise((ok, no)=>{ img.onload=ok; img.onerror=()=>no(new Error('não renderizou a tela')); img.src=url; });
    const c=document.createElement('canvas'); c.width=s.w; c.height=s.h; const g=c.getContext('2d'); g.fillStyle=ptTok('--web-bg','white'); g.fillRect(0,0,s.w,s.h); g.drawImage(img,0,0);
    return c.toDataURL('image/png');
  }catch(_){ return url; }
}

// ---------------------------------------------------------------- render do editor
function ptRender(full){
  const pg=$id('protoPage'); if(!pg) return;
  if(!ptTabOn('prototipo') && !full) return;
  if(PT.loading || PT.loadErr || !PT.cur || PT.gen){ pg.__sk=''; pg.innerHTML=ptStateHtml(); ptWireState(pg); return; }
  const sig=PT.cur.id+'|'+PT.cur.screens.map(s=>s.id+':'+s.w+'x'+s.h).join(',');
  if(pg.__sk!==sig || !$id('ptBoard')){ pg.__sk=sig; pg.innerHTML=`<div class="pt-ed"><div class="pt-hd" id="ptHd"></div><div class="pt-main"><div class="pt-board" id="ptBoard" tabindex="0" aria-label="Quadro do protótipo"><div class="pt-world" id="ptWorld"></div><div id="ptChrome"></div></div><aside class="pt-rp" id="ptRp" aria-label="Painel do protótipo"></aside></div></div>`; ptWireBoard(); }
  ptPaintHd(); ptPaintFrames(); ptPaintLayers(); ptPaintChrome(); ptPaintRp(); ptLayoutWorld();
}
function ptStateHtml(){
  const ia=window.protoIA;
  if(PT.gen && ia && typeof ia.genHtml==='function'){ try{ return `<div class="pt-state pt-genext">${ia.genHtml({ st:PT.gen.st, prompt:PT.gen.prompt, acts:PT.gen.acts, err:PT.gen.raw||PT.gen.err })}</div>`; }catch(e){ console.error('protoIA.genHtml', e); } }
  if(PT.gen && PT.gen.st==='loading') return `<div class="pt-state"><div class="pt-in"><div class="ill"><span class="pt-spin big"></span></div><h2>A IA está desenhando a 1ª versão…</h2><p>“${ptE(PT.gen.prompt)}” · usando os Padrões do time e as telas do projeto</p><div class="pt-skg"><div class="pt-skel" style="height:40px"></div><div class="pt-sk2"><div class="pt-skel" style="height:120px"></div><div class="pt-skel" style="height:120px"></div></div></div><button class="btn" data-pt="gencancel">Parar ${ptK('esc')}</button></div></div>`;
  if(PT.gen && PT.gen.st==='erro') return `<div class="pt-state err"><div class="pt-in"><div class="ill">${ptI('err',30)}</div><h2>Não deu pra gerar o protótipo</h2><p>${ptE(String(PT.gen.err).replace(/\.?\s*$/,'.'))} Nada foi perdido: o pedido está salvo.</p><div class="row"><button class="btn primary" data-pt="genretry">Tentar de novo</button><button class="btn" data-pt="engine">Usar outra IA</button><button class="btn" data-pt="genblank">Começar em branco</button></div></div></div>`;
  if(PT.loadErr) return `<div class="pt-state err"><div class="pt-in"><div class="ill">${ptI('err',30)}</div><h2>Não consegui abrir o protótipo</h2><p>${ptE(PT.loadErr)}</p><div class="row"><button class="btn primary" data-pt="reload">Tentar de novo</button><button class="btn" data-pt="golist">Ver todos os protótipos</button></div></div></div>`;
  return `<div class="pt-state"><div class="pt-in" style="width:min(520px,100%)"><div class="ill"><span class="pt-spin big"></span></div><h2>Abrindo o protótipo…</h2><div class="pt-skg"><div class="pt-skel" style="height:36px"></div><div class="pt-sk2"><div class="pt-skel" style="height:110px"></div><div class="pt-skel" style="height:110px"></div></div></div></div></div>`;
}
function ptWireState(pg){
  const ia=window.protoIA;
  if(PT.gen && ia && typeof ia.genWire==='function'){ try{ ia.genWire(pg, { onStop:ptGenCancel, onRetry:()=>{ const g=PT.gen; PT.gen=null; if(g) ptGenerate(g.id, g.prompt); }, onBlank:()=>{ PT.gen=null; PT.tool='R'; ptRender(); toast('Tela em branco · R desenha caixas, K põe componentes','info'); } }); }catch(e){ console.error('protoIA.genWire', e); } }
  pg.querySelectorAll('[data-pt]').forEach(b=>b.onclick=()=>{ const a=b.dataset.pt;
    if(a==='gencancel') ptGenCancel();
    else if(a==='genretry' && PT.gen){ const g=PT.gen; PT.gen=null; ptGenerate(g.id, g.prompt); }
    else if(a==='genblank'){ PT.gen=null; PT.tool='R'; ptRender(); toast('Tela em branco · R desenha caixas, K põe componentes','info'); }
    else if(a==='engine'){ if(typeof ajustesOpen==='function') ajustesOpen('motores'); else openTab('cfg'); }
    else if(a==='reload'){ const t=tabById(activeTab); PT.cur=null; ptOpenInner(t); }
    else if(a==='golist') openPrototipos(); });
}
function ptPaintHd(){
  const h=$id('ptHd'); if(!h) return; const p=PT.cur; const n=ptOpenPins(p);
  const last=(p.history||[]).slice(-1)[0]; const who=[...new Set((p.history||[]).slice(-4).map(x=>x.by).filter(Boolean))].slice(0,3);
  const repo=(typeof state!=='undefined'&&state.repo&&typeof pathBase==='function')?pathBase(state.repo):'';
  const sub=['protótipo', repo, 'v'+(p.version||1), last?`editado por ${last.by} ${ptAgoTx(p.updatedAt||last.at)}`:`criado por ${p.createdBy||'você'}`].filter(Boolean).join(' · ');
  const html=`<button class="pt-title" data-pt="rename" title="Renomear">${ptE(p.title)}</button><span class="pt-sub">${ptE(sub)}</span><span class="pt-avs">${(who.length?who:[p.createdBy||ptMe()]).map(ptAv).join('')}</span><span class="pt-sp"></span>
    <button class="btn" data-pt="askai" title="A IA lê os comentários e propõe correções">${ptI('spark',14)} Pedir pra IA olhar ${ptK('⌘↵')}</button><button class="btn primary" data-pt="demanda" title="${n?`${n} comentário${n>1?'s':''} aberto${n>1?'s':''} vão junto como pendência`:'Vira uma demanda com o protótipo como referência'}">Transformar em demanda</button>`;
  if(h.__html===html) return; h.__html=html; h.innerHTML=html;
  h.querySelectorAll('[data-pt]').forEach(b=>b.onclick=()=>ptAct(b.dataset.pt, b));
}
function ptPaintFrames(){
  const w=$id('ptWorld'); if(!w) return; const L=ptLayout(PT.cur.screens);
  for(const a of L){
    let ab=w.querySelector(`.pt-ab[data-ab="${CSS.escape(a.id)}"]`);
    if(!ab){ ab=document.createElement('div'); ab.className='pt-ab'+(a.ref?' ref':''); ab.dataset.ab=a.id;
      ab.innerHTML=`<div class="pt-ab-name"></div>${a.ref?'':`<iframe class="pt-frame" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true" title="${ptE(a.name)}"></iframe><div class="pt-ab-empty" hidden>Tela em branco.<br>Use ${ptK('R')} ${ptK('T')}, componentes (${ptK('K')}) ou cole um print.</div>`}<div class="pt-layer"></div><div class="pt-pins"></div>`;
      w.appendChild(ab);
      const f=ab.querySelector('iframe'); if(f) f.addEventListener('load', ptFrameMarks); }
    Object.assign(ab.style, { left:a.x+'px', top:a.y+'px', width:a.w+'px', height:a.h+'px' });
    if(!a.ref){ const s=ptScreen(a.id); const f=ab.querySelector('iframe'); const doc=ptSrcdoc(s);
      if(f.__doc!==doc){ f.__doc=doc; f.width=a.w; f.height=a.h; f.style.width=a.w+'px'; f.style.height=a.h+'px'; f.srcdoc=doc; }
      const em=ab.querySelector('.pt-ab-empty'); if(em) em.hidden=!!String(s.html||'').trim() || PT.cur.els.some(e=>e.screen===a.id); }
  }
  w.querySelectorAll('.pt-ab').forEach(ab=>{ if(!L.some(a=>a.id===ab.dataset.ab)) ab.remove(); });
  ptFrameMarks();
}
function ptElHtml(e){
  const sel=PT.sel==='el:'+e.id, crop=sel&&PT.crop&&e.type==='img';
  const st=`left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;${e.type==='img'&&e.crop?`clip-path:inset(${e.crop.t}px ${e.crop.r}px ${e.crop.b}px ${e.crop.l}px);`:''}`;
  let inner='';
  if(e.type==='img'){ const u=ptSrc(e); inner=u?`<img src="${ptE(u)}" alt="${ptE(e.name)}" draggable="false">`:`<span class="pt-imgload">carregando imagem…</span>`; }
  else if(e.type==='text') inner=ptE(e.text||'');
  else if(e.type==='comp'||e.type==='box') inner=ptSanitize(e.html||'');
  else if(e.type==='pen') inner=`<svg width="100%" height="100%" viewBox="0 0 ${e.w} ${e.h}" preserveAspectRatio="none" style="overflow:visible"><path d="${ptE(e.d||'')}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  const hs=sel?`<i class="pt-h nw" data-h="nw"></i><i class="pt-h ne" data-h="ne"></i><i class="pt-h sw" data-h="sw"></i><i class="pt-h se" data-h="se"></i><span class="pt-tag">${ptE(e.name)}${crop?' · recortando':''}</span>`:'';
  return `<div class="pt-el ${e.type} ${sel?'sel':''} ${crop?'crop':''} ${e.hidden?'hid':''}" data-el="${e.id}" style="${st}"${e.type==='text'?` contenteditable="${sel?'true':'false'}" spellcheck="false"`:''}>${inner}${hs}</div>`;
}
function ptPaintLayers(){
  const w=$id('ptWorld'); if(!w||!PT.cur) return;
  w.querySelectorAll('.pt-ab').forEach(ab=>{ const k=ab.dataset.ab;
    const s=ptAbDims(k); const nm=ab.querySelector('.pt-ab-name'); const open=PT.cur.pins.filter(p=>p.screen===k && !p.resolved && String(p.text||'').trim()).length;
    const nmh=`${ptE(s?s.name:k)}${k!=='ref'?` <span class="pt-dim">· ${open} coment.</span>`:''}`; if(nm.__h!==nmh){ nm.__h=nmh; nm.innerHTML=nmh; }
    const ly=ab.querySelector('.pt-layer'); const lh=PT.cur.els.filter(e=>e.screen===k).map(ptElHtml).join('');
    const ae=document.activeElement; const editing=ae && ae.closest && ae.closest('.pt-el.text') && ly.contains(ae);
    if(ly.__h!==lh && !editing){ ly.__h=lh; ly.innerHTML=lh; }
    const pn=ab.querySelector('.pt-pins'); const ph=PT.cur.pins.filter(p=>p.screen===k).map(p=>`<button class="pt-pin ${p.resolved?'res':''} ${PT.openPin===p.id?'open':''}" data-pin="${p.id}" style="left:${p.x}px;top:${p.y}px" aria-label="Comentário ${p.n}${p.target?' em '+ptE(p.target):''}${p.resolved?' (resolvido)':''}">${p.resolved?'✓':p.n}</button>`).join('');
    if(pn.__h!==ph){ pn.__h=ph; pn.innerHTML=ph; } });
  ptPaintPop();
}
// @cor-dado-inicio — componentes prontos e cartão de URL são CONTEÚDO da tela do usuário (fundo branco da página), nunca tema do app
const PT_COMPS={ btn:['Botão','<button style="background:#1f7a4d;color:#fff;border:0;border-radius:8px;width:100%;height:100%;font:600 14px system-ui">Botão</button>',140,44],
  campo:['Campo','<div style="display:grid;gap:4px;height:100%;font:13px system-ui"><span style="color:#666">Rótulo</span><span style="border:1px solid #bbb;border-radius:8px;background:#fff;padding:8px 10px;color:#999">digite…</span></div>',220,64],
  card:['Card','<div style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.14);height:100%;padding:12px;font:13px system-ui;color:#222"><b>Título</b><div style="color:#666">Texto do card</div></div>',220,96],
  lista:['Lista','<div style="background:#fff;border-radius:8px;height:100%;font:13px system-ui;color:#222"><div style="padding:8px 12px;border-bottom:1px solid #eee">Item 1</div><div style="padding:8px 12px;border-bottom:1px solid #eee">Item 2</div><div style="padding:8px 12px">Item 3</div></div>',200,110] };
function ptUrlCard(host, v){ return `<div style="background:#fff;border:1px solid #d6dbe0;border-radius:10px;height:100%;padding:12px;font:13px system-ui;color:#222;display:grid;gap:4px"><b>${ptE(host)}</b><span style="color:#666;word-break:break-all">${ptE(v.slice(0,90))}</span><span style="color:#777;font-size:12px">Abra no Navegador e cole o print (⌘V) aqui.</span></div>`; }
// @cor-dado-fim
const PT_TOOLS=[['V','Selecionar'],['R','Caixa'],['T','Texto'],['P','Caneta'],['I','Imagem']];
function ptHint(){ return ({ V:'V selecionar · [ ] percorre blocos · C comenta a seleção · ? atalhos', R:'R caixa · arraste pra desenhar', T:'T texto · clique onde quer escrever', P:'P caneta · rabisque por cima', C:'C comentar · clique num ponto ou elemento', I:'I imagem · cole (⌘V), solte um arquivo ou clique pra escolher' })[PT.tool]||''; }
function ptPaintChrome(){
  const c=$id('ptChrome'); if(!c) return;
  const t=([k,l])=>`<button class="pt-tb" data-tool="${k}" aria-pressed="${PT.tool===k}" aria-label="${l} (${k})" title="${l} (${k})">${ptI(k,17)}<span class="k">${k}</span></button>`;
  const html=`<div class="pt-tools" role="toolbar" aria-label="Ferramentas" aria-orientation="vertical">${PT_TOOLS.map(t).join('')}<button class="pt-tb" data-pt="comp" aria-expanded="${PT.compMenu}" aria-label="Componentes prontos (K)" title="Componentes prontos (K)">${ptI('K',17)}<span class="k">K</span></button><span class="pt-tsep"></span>${t(['C','Comentar'])}</div>
    ${PT.compMenu?`<div class="pt-compm" role="menu" aria-label="Componentes">${Object.entries(PT_COMPS).map(([k,c])=>`<button role="menuitem" data-comp="${k}">${c[0]}<kbd class="ptkbd">${c[2]}×${c[3]}</kbd></button>`).join('')}<button role="menuitem" data-pt="compclose" class="pt-dim">Fechar ${ptK('esc')}</button></div>`:''}
    <div class="pt-hint">${ptE(ptHint())}</div>
    <div class="pt-zoom"><button data-z="-" aria-label="Diminuir zoom">−</button><span id="ptZv">100%</span><button data-z="+" aria-label="Aumentar zoom">+</button><button data-z="fit">Ajustar</button></div>`;
  if(c.__h!==html){ c.__h=html; c.innerHTML=html;
    c.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>ptTool(b.dataset.tool));
    c.querySelectorAll('[data-comp]').forEach(b=>b.onclick=()=>ptAddComp(b.dataset.comp));
    c.querySelectorAll('[data-pt]').forEach(b=>b.onclick=()=>ptAct(b.dataset.pt, b));
    c.querySelectorAll('[data-z]').forEach(b=>b.onclick=()=>{ const z=b.dataset.z; const h=$id('ptBoard'); PT.zoom=z==='fit'?null:Math.min(2.5, Math.max(.08, ((h&&h._s)||1)*(z==='+'?1.2:.83))); if(z==='fit'){ PT.panX=PT.panY=0; } ptLayoutWorld(); }); }
  const zv=$id('ptZv'), h=$id('ptBoard'); if(zv&&h&&h._s) zv.textContent=Math.round(h._s*100)+'%';
  if(h){ [...h.classList].filter(c=>/^tool-/.test(c)).forEach(c=>h.classList.remove(c)); h.classList.add('tool-'+PT.tool); }
}
function ptLayoutWorld(){
  const h=$id('ptBoard'), w=$id('ptWorld'); if(!h||!w||!PT.cur) return;
  const L=ptLayout(PT.cur.screens); const withRef=PT.cur.els.some(e=>e.screen==='ref'); const fit=ptFit(L, h.clientWidth||800, h.clientHeight||600, withRef);
  const s=PT.zoom||fit; const T=L.filter(a=>withRef||!a.ref); const last=T[T.length-1]||L[0]; const W=last.x+last.w, H=Math.max(...T.map(a=>a.h))+30;
  const x=Math.max(56, ((h.clientWidth||800)-W*s)/2+20)+PT.panX, y=Math.max(34, ((h.clientHeight||600)-H*s)/2+12)+PT.panY;
  w.style.transform=`translate(${x}px,${y}px) scale(${s})`; h._s=s; w.style.setProperty('--ptk', String(1/s));
  w.querySelectorAll('.pt-ab iframe').forEach(f=>{ try{ const d=f.contentDocument; if(d&&d.documentElement) d.documentElement.style.setProperty('--sfk', String(1/s)); }catch(_){ } });
  const zv=$id('ptZv'); if(zv) zv.textContent=Math.round(s*100)+'%';
  ptPlacePop();
}
window.addEventListener('resize', ()=>{ if(ptActive()) ptLayoutWorld(); if(ptTabOn('prototipos')) ptThumbScale(); });

// ---------------------------------------------------------------- comentário aberto (popover no quadro)
function ptCurPin(){ return PT.cur && PT.cur.pins.find(p=>p.id===PT.openPin); }
function ptThread(p){
  const isNew=!String(p.text||'').trim(); const names=ptTeamNames();
  return `<div class="pt-pop-top"><span class="pt-pn">${p.n}</span>${ptAv(p.who)}<b>${ptE(p.who)}</b><span class="pt-dim pt-where">em ${ptE(p.target||'ponto livre')}</span></div>
  ${isNew?'':`<div class="pt-ctx">${ptMent(p.text)}</div>${(p.replies||[]).map(r=>`<div class="pt-rep"><b>${ptE(r.who)}:</b> ${ptMent(r.text)}</div>`).join('')}`}
  <textarea class="pt-inp" id="ptDraft" placeholder="${isNew?(names.length?'O que mudar aqui? Use @ pra chamar alguém do time':'O que mudar aqui?'):'Responder…'}" aria-label="Texto do comentário">${ptE(PT.draft)}</textarea>
  ${names.length?`<div class="pt-ments" aria-label="Mencionar">${names.map(n=>`<button data-ment="${ptE(n)}">@${ptE(n)}</button>`).join('')}</div>`:''}
  <div class="pt-pop-acts">${isNew?`<button class="btn sm" data-pt="pincancel">Cancelar ${ptK('esc')}</button>`:`<button class="btn sm" data-pt="resolve" data-id="${p.id}">${p.resolved?'Reabrir':'Resolver'}</button>`}<button class="btn sm primary" data-pt="pinsave" data-id="${p.id}">${isNew?'Comentar':'Responder'} ${ptK('⌘↵')}</button></div>`;
}
function ptPaintPop(){
  const host=$id('ptBoard'); if(!host) return; let pop=$id('ptPop'); const p=ptCurPin();
  if(!p){ if(pop) pop.remove(); return; }
  const html=ptThread(p);
  if(!pop){ pop=document.createElement('div'); pop.id='ptPop'; pop.className='pt-pop'; pop.setAttribute('role','dialog'); host.appendChild(pop); }
  pop.setAttribute('aria-label','Comentário '+p.n);
  if(pop.__h!==html){ pop.__h=html; pop.innerHTML=html;
    pop.querySelectorAll('[data-pt]').forEach(b=>b.onclick=()=>ptAct(b.dataset.pt, b));
    pop.querySelectorAll('[data-ment]').forEach(b=>b.onclick=()=>{ const ta=$id('ptDraft'); if(!ta) return; ta.value=(ta.value.replace(/\s*$/,'')+' @'+b.dataset.ment+' ').trimStart(); PT.draft=ta.value; ta.focus(); });
    const ta=$id('ptDraft'); if(ta) ta.oninput=()=>{ PT.draft=ta.value; }; }
  ptPlacePop();
  if(PT.focusDraft){ PT.focusDraft=false; const d=$id('ptDraft'); if(d){ d.focus(); d.setSelectionRange(d.value.length, d.value.length); } }
}
function ptPlacePop(){
  const host=$id('ptBoard'), pop=$id('ptPop'); if(!host||!pop) return;
  const pin=host.querySelector(`.pt-pin[data-pin="${PT.openPin}"]`); if(!pin) return;
  const hr=host.getBoundingClientRect(), pr=pin.getBoundingClientRect(); let L=pr.right-hr.left+10, T=pr.top-hr.top-6;
  if(L+290>hr.width) L=pr.left-hr.left-292; if(L<8) L=8; T=Math.min(Math.max(8,T), hr.height-pop.offsetHeight-8);
  pop.style.left=L+'px'; pop.style.top=T+'px';
}

// ---------------------------------------------------------------- painel direito
function ptSelInfo(){ if(!PT.sel||!PT.cur) return null; const i=PT.sel.indexOf(':'); const k=PT.sel.slice(0,i), id=PT.sel.slice(i+1);
  if(k==='el'){ const e=PT.cur.els.find(x=>String(x.id)===id); return e?{ k, e }:null; } return { k, id }; }
function ptKeysBox(){
  return `<div class="pt-lbl">Atalhos</div><div class="pt-keys">${ptK('V')}<span>selecionar e mover</span>${ptK('R')}<span>caixa</span>${ptK('T')}<span>texto</span>${ptK('P')}<span>caneta livre</span>${ptK('I')}<span>imagem / colagem</span>${ptK('K')}<span>componente pronto</span>${ptK('C')}<span>comentar (com algo selecionado: comenta nele)</span>${ptK('[ ]')}<span>percorrer blocos sem mouse</span>${ptK('⌘↵')}<span>pedir pra IA olhar</span>${ptK('⌘V')}<span>colar print</span>${ptK('⌘Z')}<span>desfazer</span>${ptK('espaço')}<span>arrastar o quadro</span>${ptK('⌘ roda')}<span>zoom</span>${ptK('⌫')}<span>apagar seleção</span>${ptK('setas')}<span>mover (⇧ = 10px)</span>${ptK('?')}<span>mostrar atalhos</span></div>`;
}
function ptPropsPanel(){
  const s=ptSelInfo();
  if(!s){
    const scr=PT.cur.screens.map(x=>`<div class="pt-lay"><span class="pt-ico">▭</span><span class="pt-nm">${ptE(x.name)} <small class="pt-dim">${x.w}×${x.h}</small></span>${PT.cur.screens.length>1?`<button data-pt="scrdel" data-id="${ptE(x.id)}" aria-label="Tirar a tela ${ptE(x.name)}">✕</button>`:''}</div>`).join('');
    const faltam=Object.keys(PT_TELAS).filter(k=>!ptScreen(k));
    return `<div class="pt-lbl">Nada selecionado</div><p class="pt-p">Clique num bloco da tela ou num elemento. Com um bloco selecionado dá pra editar o HTML e o CSS dele aqui.</p>
      <div class="pt-lbl">Telas</div>${scr}${faltam.length?`<div class="pt-row">${faltam.map(k=>`<button class="btn sm" data-pt="scradd" data-id="${k}">+ ${ptE(PT_TELAS[k].name)}</button>`).join('')}</div>`:''}
      ${PT.keysOpen?ptKeysBox():`<button class="btn sm pt-quiet" data-pt="keys">Atalhos ${ptK('?')}</button>`}`;
  }
  if(s.k==='blk'){
    const b=ptBlkGet(s.id)||{ html:'', style:'' }; const em=PT.cur.screens.filter(x=>ptBlocks(x.id).includes(s.id)).map(x=>x.name.split(' ')[0]);
    return `<div class="pt-lbl">Bloco da tela</div><div class="pt-row"><span class="pt-chip">[data-blk="${ptE(s.id)}"]</span><span class="pt-dim">vale em ${ptE(em.join(' e ')||'nenhuma tela')}</span></div>
      <details class="pt-det" ${PT.htmlOpen?'open':''}><summary data-pt="htmltgl">Editar HTML ▸</summary>
        <div class="pt-field"><label class="pt-lbl" for="ptBlkHtml">HTML</label><textarea class="pt-inp code" id="ptBlkHtml" spellcheck="false">${ptE(b.html)}</textarea></div>
        <div class="pt-field"><label class="pt-lbl" for="ptBlkCss">CSS deste bloco</label><textarea class="pt-inp code" id="ptBlkCss" spellcheck="false" style="min-height:52px" placeholder="ex.: border-radius:16px; height:52px">${ptE(b.style)}</textarea></div>
        <div class="pt-row"><button class="btn sm primary" data-pt="blkapply">Aplicar</button>${PT.orig[s.id]?'<button class="btn sm" data-pt="blkreset">Voltar ao original</button>':''}</div></details>
      <div class="pt-row"><button class="btn sm" data-pt="pinsel">Comentar aqui ${ptK('C')}</button><button class="btn sm pt-quiet" data-pt="askblk">Pedir pra IA mexer só aqui</button></div>`;
  }
  const e=s.e; const tipo={ img:'Imagem', text:'Texto', pen:'Rabisco', box:'Caixa', comp:'Componente' }[e.type]||'Elemento';
  return `<div class="pt-lbl">${tipo}</div>
    <div class="pt-field"><label class="pt-lbl" for="ptElName">Nome</label><input class="pt-inp" id="ptElName" value="${ptE(e.name)}"></div>
    <div class="pt-grid4">${['x','y','w','h'].map(k=>`<label class="pt-field"><span class="pt-lbl">${k}</span><input class="pt-inp" type="number" data-geo="${k}" value="${Math.round(e[k])}"></label>`).join('')}</div>
    ${e.type==='img'?`<div class="pt-row"><button class="btn sm ${PT.crop?'primary':''}" data-pt="crop" aria-pressed="${PT.crop}">${PT.crop?'Concluir recorte':'Recortar'}</button>${e.crop?'<button class="btn sm" data-pt="cropreset">Sem recorte</button>':''}<button class="btn sm" data-pt="front">Pra frente</button><button class="btn sm" data-pt="back">Pra trás</button></div><p class="pt-p pt-dim">⇧ ao redimensionar mantém a proporção.</p>`:''}
    ${e.type==='comp'||e.type==='box'?`<details class="pt-det" ${PT.htmlOpen?'open':''}><summary data-pt="htmltgl">Editar HTML ▸</summary><div class="pt-field"><label class="pt-lbl" for="ptElHtml">HTML</label><textarea class="pt-inp code" id="ptElHtml" spellcheck="false">${ptE(e.html||'')}</textarea></div><button class="btn sm primary" data-pt="elapply">Aplicar HTML</button></details>`:''}
    <div class="pt-row"><button class="btn sm" data-pt="dup">Duplicar</button><button class="btn sm" data-pt="pinsel">Comentar ${ptK('C')}</button><button class="btn sm danger" data-pt="del">Apagar ${ptK('⌫')}</button></div>`;
}
function ptLayersPanel(){
  const L=[...PT.cur.els].reverse(); const nmOf=k=>k==='ref'?'Ref.':((ptScreen(k)||{}).name||k).split(' ')[0];
  const imgs=[]; const seen=new Set(); for(const e of PT.cur.els){ if(e.type==='img' && e.src && !seen.has(e.src)){ seen.add(e.src); imgs.push(e); } }
  const blocks=PT.cur.screens.map(s=>[s, ptBlocks(s.id)]).filter(x=>x[1].length);
  return `<div class="pt-lbl">Camadas · ${PT.cur.els.length}</div>
   ${L.map(e=>`<div class="pt-lay ${PT.sel==='el:'+e.id?'on':''}"><span class="pt-ico">${e.type==='img'?'▣':e.type==='text'?'T':e.type==='pen'?'✎':'□'}</span><button class="pt-nm" data-pick="${e.id}" title="${ptE(e.name)}">${ptE(e.name)} <small class="pt-dim">${ptE(nmOf(e.screen))}</small></button><button data-pt="up" data-id="${e.id}" aria-label="Subir camada">↑</button><button data-pt="down" data-id="${e.id}" aria-label="Descer camada">↓</button><button data-pt="hide" data-id="${e.id}" aria-label="${e.hidden?'Mostrar':'Esconder'} ${ptE(e.name)}" aria-pressed="${!!e.hidden}">${e.hidden?'◌':'◉'}</button></div>`).join('')}
   ${blocks.map(([s,b])=>`<div class="pt-lay"><span class="pt-ico">⌂</span><span class="pt-nm pt-dim">${ptE(s.name.split(' ')[0])} · ${b.length} bloco${b.length>1?'s':''} (${ptE(b.slice(0,6).join(', '))}${b.length>6?'…':''})</span></div>`).join('')}
   <div class="pt-lbl">Bandeja de colagem</div>
   ${imgs.length?`<div class="pt-tray">${imgs.map(e=>{ const u=ptSrc(e); return `<button class="pt-tri" draggable="true" data-tray="${e.id}" title="Arraste pro quadro ou clique pra pôr de novo">${u?`<img src="${ptE(u)}" alt="">`:'<span class="pt-skel" style="height:58px"></span>'}<span>${ptE(e.name)}</span></button>`; }).join('')}</div>`:'<p class="pt-p pt-dim">As imagens que você colar aqui ficam na bandeja pra usar de novo.</p>'}
   <div class="pt-drop" id="ptDrop">Solte um arquivo aqui, cole com ${ptK('⌘V')} ou <button class="btn sm" data-pt="file">escolher imagem</button>
     <label class="pt-lbl" for="ptUrlIn" style="margin-top:6px">URL de referência</label><input class="pt-inp" id="ptUrlIn" placeholder="https://… (↵ guarda nas Referências)"></div>`;
}
function ptCommentsPanel(){
  const open=PT.cur.pins.filter(p=>!p.resolved&&String(p.text||'').trim()), res=PT.cur.pins.filter(p=>p.resolved);
  const card=p=>`<div class="pt-cm ${PT.openPin===p.id?'open':''} ${p.resolved?'res':''}"><div class="pt-cm-top"><span class="pt-pn">${p.resolved?'✓':p.n}</span>${ptAv(p.who)}<b>${ptE(p.who)}</b><span class="pt-where" title="${ptE(p.target)}">${ptE(p.target||'ponto livre')} · ${ptE(p.screen==='ref'?'Ref.':((ptScreen(p.screen)||{}).name||'').split(' ')[0])}</span></div><div>${ptMent(p.text)}</div>${(p.replies||[]).map(r=>`<div class="pt-rep"><b>${ptE(r.who)}:</b> ${ptMent(r.text)}</div>`).join('')}<div class="pt-row"><button class="btn sm" data-pt="openpin" data-id="${p.id}">${PT.openPin===p.id?'Aberto no quadro':'Responder'}</button><button class="btn sm pt-quiet" data-pt="resolve" data-id="${p.id}">${p.resolved?'Reabrir':'Resolver'}</button></div></div>`;
  return `<div class="pt-row" style="justify-content:space-between"><div class="pt-lbl">Abertos · ${open.length}</div><span class="pt-dim">${ptK('C')} e clique pra comentar</span></div>
    ${open.length?open.map(card).join(''):`<p class="pt-p">Nenhum comentário aberto. Aperte ${ptK('C')} e clique num ponto da tela — ou selecione um bloco e aperte ${ptK('C')}.</p>`}
    ${res.length?`<div class="pt-lbl">Resolvidos · ${res.length}</div>${res.map(card).join('')}`:''}
    ${ptTeamNames().length?'':'<p class="pt-p pt-dim">Menções (@) aparecem quando você está num time.</p>'}`;
}
function ptIaPanel(){
  const ia=window.protoIA;
  if(ia && typeof ia.panelHtml==='function'){ try{ return ia.panelHtml(PT.cur)||''; }catch(e){ console.error('protoIA.panelHtml', e); } }
  const n=ptOpenPins(PT.cur);
  return `<div class="pt-ai"><h4>${ptAv('IA')} Pedir pra IA olhar <span class="pt-soon">em breve</span></h4><p>Ela vai ler cada comentário com a posição, o elemento e um recorte da tela, e propor uma correção por comentário — você aceita ou recusa uma por uma. Nada muda sem o seu aceite.</p><p class="pt-dim">${n?`${n} comentário${n>1?'s':''} aberto${n>1?'s':''} esperando.`:'Comente algo com C pra ela ter o que olhar.'}</p></div>`;
}
function ptPaintRp(){
  const rp=$id('ptRp'); if(!rp||!PT.cur) return;
  const n=ptOpenPins(PT.cur);
  const tabs=[['props',PT.sel?'Propriedades':'Tela'],['camadas','Colagem'],['coment',`Coment. · ${n}`],['ia','IA']];
  const body={ props:ptPropsPanel, camadas:ptLayersPanel, coment:ptCommentsPanel, ia:ptIaPanel }[PT.panel]();
  const html=`<div class="pt-rtabs" role="tablist" aria-label="Painel">${tabs.map(([k,l])=>`<button role="tab" data-panel="${k}" aria-selected="${PT.panel===k}" tabindex="${PT.panel===k?0:-1}">${ptE(l)}</button>`).join('')}</div><div class="pt-rbody" id="ptRbody" role="tabpanel">${body}</div><div class="pt-rfoot" id="ptFoot"></div>`;
  if(rp.__h!==html){ const sc=($id('ptRbody')||{}).scrollTop||0; rp.__h=html; rp.innerHTML=html; const b=$id('ptRbody'); if(b) b.scrollTop=sc; ptWireRp(rp); }
  ptPaintFoot();
}
function ptPaintFoot(){
  const f=$id('ptFoot'); if(!f||!PT.cur) return; const st=PT.save.st;
  const h=st==='err'?`<span class="pt-err">Não salvou: ${ptE(PT.save.err)}</span><button class="btn sm" data-pt="saveretry">Tentar de novo</button>`
    : st==='saving'||st==='dirty'?`<span class="pt-dim"><span class="pt-spin"></span> Salvando…</span>`
    : `<span class="pt-dim">Salvo sozinho · <span class="pt-mono">v${PT.cur.version||1}</span></span>`;
  if(f.__h!==h){ f.__h=h; f.innerHTML=h; const b=f.querySelector('[data-pt]'); if(b) b.onclick=()=>ptSaveNow(); }
}
function ptWireRp(rp){
  rp.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>{ PT.panel=b.dataset.panel; ptPaintRp(); const nb=rp.querySelector(`[data-panel="${b.dataset.panel}"]`); if(nb) nb.focus(); });
  const tl=rp.querySelector('[role=tablist]'); if(tl) tl.onkeydown=e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; const K=['props','camadas','coment','ia']; const i=K.indexOf(PT.panel); PT.panel=K[(i+(e.key==='ArrowRight'?1:-1)+K.length)%K.length]; ptPaintRp(); const nb=rp.querySelector(`[data-panel="${PT.panel}"]`); if(nb) nb.focus(); e.preventDefault(); };
  rp.querySelectorAll('#ptRbody [data-pt]').forEach(b=>{ if(b.tagName==='SUMMARY'){ b.onclick=()=>{ PT.htmlOpen=!b.parentElement.open; }; return; } b.onclick=(e)=>{ e.preventDefault(); ptAct(b.dataset.pt, b); }; });
  rp.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{ PT.sel='el:'+b.dataset.pick; ptRender(); });
  rp.querySelectorAll('[data-tray]').forEach(b=>{ b.onclick=()=>{ const o=PT.cur.els.find(x=>String(x.id)===b.dataset.tray); if(o) ptAddImgEl(o.src, o.name, ptDefaultAb(), null, o.w, o.h); };
    b.ondragstart=e=>{ e.dataTransfer.setData('text/x-ptimg', b.dataset.tray); e.dataTransfer.effectAllowed='copy'; }; });
  rp.querySelectorAll('[data-geo]').forEach(i=>{ i.onfocus=()=>{ i.__snap=false; }; i.oninput=()=>{ const s=ptSelInfo(); if(!s||!s.e) return; if(!i.__snap){ ptSnap(); i.__snap=true; } s.e[i.dataset.geo]=Math.max(i.dataset.geo==='w'||i.dataset.geo==='h'?4:-99999, +i.value||0); ptPaintLayers(); ptChanged(); }; });
  const nm=$id('ptElName'); if(nm) nm.onchange=()=>{ const s=ptSelInfo(); if(s&&s.e){ ptSnap(); s.e.name=nm.value.trim()||s.e.name; ptPaintLayers(); ptChanged(); } };
  const u=$id('ptUrlIn'); if(u) u.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); ptAddUrl(u.value); u.value=''; } };
  const dz=$id('ptDrop'); if(dz){ dz.ondragover=e=>e.preventDefault(); dz.ondrop=e=>{ e.preventDefault(); ptDropFiles(e, ptDefaultAb(), null); }; }
  const ia=window.protoIA; if(PT.panel==='ia' && ia){ const fn=ia.wire||ia.bind||ia.mount; if(typeof fn==='function'){ try{ fn.call(ia, $id('ptRbody'), PT.cur); }catch(e){ console.error('protoIA.wire', e); } } }
}

// ---------------------------------------------------------------- ações
function ptTool(k){ PT.tool=k; PT.compMenu=false; if(k==='I'){ PT.panel='camadas'; ptPaintRp(); } if(k!=='V') PT.crop=false; ptPaintChrome(); ptPaintLayers(); }
function ptDefaultAb(){ return 'ref'; }
function ptNextId(){ return ++PT.seq; }
function ptAddEl(o){ ptSnap(); const e=Object.assign({ id:ptNextId(), hidden:false, crop:null }, o); PT.cur.els.push(e); PT.sel='el:'+e.id; PT.tool='V'; ptChanged(); ptRender(); ptReveal(e); return e; }
// o elemento novo (ex.: print colado nas Referências) fica fora da vista? traz o quadro até ele
function ptReveal(e){
  const h=$id('ptBoard'), n=h&&h.querySelector(`.pt-el[data-el="${e.id}"]`); if(!n) return;
  const hr=h.getBoundingClientRect(), r=n.getBoundingClientRect();
  if(r.left>=hr.left+50 && r.right<=hr.right-10 && r.top>=hr.top+10 && r.bottom<=hr.bottom-40) return;
  PT.panX+=(hr.left+hr.width/2)-(r.left+r.width/2); PT.panY+=(hr.top+hr.height/2)-(r.top+r.height/2); ptLayoutWorld();
}
function ptAddComp(k){ const c=PT_COMPS[k]; if(!c) return; const s=PT.cur.screens[0]; const ab=s?s.id:'ref'; ptAddEl({ type:'comp', screen:ab, x:40, y:Math.max(20,((s&&s.h)||400)-c[3]-60), w:c[2], h:c[3], name:c[0], html:c[1] }); PT.compMenu=false; PT.panel='props'; ptRender(); toast(c[0]+' adicionado · edite o HTML no painel','info'); }
function ptAddImgEl(src, name, ab, pt, w, h){ const d=ptAbDims(ab)||PT_REF; const W=Math.min(w||320, d.w-40), H=h&&w?Math.round(W*h/w):Math.round(W*.72);
  return ptAddEl({ type:'img', screen:ab, x:pt?Math.round(pt.x-W/2):30+(PT.cur.els.length%6)*14, y:pt?Math.round(pt.y-H/2):30+(PT.cur.els.length%6)*14, w:W, h:H, src, name:name||'Imagem colada' }); }
// arquivo/print → asset do protótipo (assets/<nome>) → elemento de imagem
async function ptAddImageFile(f, ab, pt){
  if(!f || !/^image\//.test(f.type||'')){ toast('Isso não é uma imagem','warn'); return; }
  if(f.size>15*1024*1024){ toast('Imagem grande demais (máx. 15 MB)','warn'); return; }
  const id=PT.cur&&PT.cur.id; if(!id) return;
  const url=await new Promise((ok,no)=>{ const r=new FileReader(); r.onload=()=>ok(r.result); r.onerror=()=>no(r.error); r.readAsDataURL(f); });
  const dims=await new Promise(ok=>{ const im=new Image(); im.onload=()=>ok([im.naturalWidth, im.naturalHeight]); im.onerror=()=>ok([320,230]); im.src=url; });
  const nm=ptAssetName(f.type, Date.now());
  let src;
  try{ src=await ptInv('proto_asset_put', { id, name:nm, base64:String(url) }); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Colar a imagem'); return; }
  PT.assets[id+'|'+src]=url;
  if(!PT.cur || PT.cur.id!==id) return;
  ptAddImgEl(src, f.name&&!/^image\.\w+$/.test(f.name)?f.name:'Print colado', ab||ptDefaultAb(), pt, Math.min(dims[0], 420), Math.min(dims[0], 420)*dims[1]/Math.max(1,dims[0]));
  toast('Imagem colada · arraste, redimensione (⇧ mantém a proporção) ou recorte','ok');
}
async function ptAddDataUrl(url, name, ab){ const blob=await (await fetch(url)).blob(); const f=new File([blob], name||'print.png', { type:blob.type||'image/png' }); return ptAddImageFile(f, ab); }
function ptDropFiles(e, ab, pt){ const k=e.dataTransfer && e.dataTransfer.getData('text/x-ptimg'); if(k){ const o=PT.cur.els.find(x=>String(x.id)===k); if(o) ptAddImgEl(o.src, o.name, ab, pt, o.w, o.h); return; }
  const f=[...((e.dataTransfer&&e.dataTransfer.files)||[])].find(x=>/^image\//.test(x.type)); if(f) ptAddImageFile(f, ab, pt); }
function ptPickFile(ab, pt){ const i=document.createElement('input'); i.type='file'; i.accept='image/*'; i.onchange=()=>{ const f=i.files&&i.files[0]; if(f) ptAddImageFile(f, ab, pt); }; i.click(); }
function ptAddUrl(v){ v=String(v||'').trim(); if(!v) return; if(!/^https?:\/\/[^\s]+$/i.test(v)){ toast('Cole um endereço que começa com http:// ou https://','warn'); return; }
  const host=v.replace(/^https?:\/\//i,'').split('/')[0];
  ptAddEl({ type:'comp', screen:'ref', x:30, y:30+(PT.cur.els.length%6)*20, w:300, h:92, name:'Referência: '+host, html:ptUrlCard(host, v) });
  toast('URL guardada nas Referências · pra virar print, abra no Navegador e cole aqui','info');
}
function ptDelSel(){ const s=ptSelInfo(); if(s&&s.e){ ptSnap(); PT.cur.els=PT.cur.els.filter(x=>x!==s.e); PT.sel=null; PT.crop=false; ptChanged(); ptRender(); toast('Apagado · ⌘Z desfaz','info'); } }
function ptNewPin(ab, x, y, target, selector){
  const cur=ptCurPin(); if(cur && !String(cur.text||'').trim()) PT.cur.pins=PT.cur.pins.filter(p=>p!==cur);
  const id=ptNextId(); const n=Math.max(0, ...PT.cur.pins.map(p=>+p.n||0))+1;
  PT.cur.pins.push({ id, n, screen:ab, x:Math.round(x), y:Math.round(y), target:target||'ponto livre', selector:selector||null, who:ptMe(), text:'', replies:[], resolved:false, at:Date.now() });
  PT.openPin=id; PT.draft=''; PT.focusDraft=true; PT.panel='coment'; ptPaintLayers(); ptPaintRp();
}
function ptPinOnSel(){
  const s=ptSelInfo(); if(!s) return;
  if(s.k==='el'){ ptNewPin(s.e.screen, s.e.x+s.e.w-8, s.e.y+8, s.e.name, null); return; }
  const ab=(PT.cur.screens.find(x=>ptBlocks(x.id).includes(s.id))||{}).id; if(!ab) return;
  const d=ptFrameDoc(ab); const n=d&&d.querySelector(`[data-blk="${CSS.escape(s.id)}"]`); const r=n?n.getBoundingClientRect():{ right:200, top:40 };
  ptNewPin(ab, Math.max(8, r.right-14), r.top+14, ptBlkLabel(n), `[data-blk="${s.id}"]`);
}
function ptSavePin(id){
  const p=PT.cur.pins.find(x=>x.id===id); const ta=$id('ptDraft'); const t=String((ta&&ta.value)||'').trim(); if(!p) return;
  if(!t){ toast('Escreva o comentário primeiro','warn'); if(ta) ta.focus(); return; }
  ptSnap(); const me=ptMe(); const ms=ptMentionsIn(t, ptTeamNames());
  if(!String(p.text||'').trim()){ p.text=t; p.at=Date.now(); toast(`Comentário ${p.n} salvo${ms.length?' · '+ms.map(m=>'@'+m).join(', ')+' vai ver em Meu trabalho':''}`,'ok'); }
  else { (p.replies=p.replies||[]).push({ who:me, text:t, at:Date.now() }); toast('Resposta salva','ok'); }
  PT.draft=''; PT.openPin=null; ptChanged(); ptRender();
}
function ptCycle(d){
  const ab=(()=>{ const s=ptSelInfo(); if(s&&s.e) return s.e.screen; if(s&&s.k==='blk') return (PT.cur.screens.find(x=>ptBlocks(x.id).includes(s.id))||PT.cur.screens[0]||{}).id; return (PT.cur.screens[0]||{}).id; })();
  const list=[...ptBlocks(ab).map(b=>'blk:'+b), ...PT.cur.els.filter(x=>x.screen===ab).map(x=>'el:'+x.id)];
  if(!list.length){ toast('Esta tela ainda não tem blocos nem elementos','info'); return; }
  let i=list.indexOf(PT.sel); i=(i+d+list.length)%list.length; PT.sel=list[i]; PT.panel='props'; PT.crop=false; ptRender();
  const s=ptSelInfo(); toast('Selecionado: '+(s.k==='blk'?s.id:s.e.name)+' · C comenta aqui','info');
}
async function ptRename(anchor){
  const v=typeof sheetAsk==='function' ? await sheetAsk({ anchor, title:'Nome do protótipo', text:'Aparece na aba, na lista e na pasta quando virar demanda.', field:{ value:PT.cur.title, placeholder:'ex.: Checkout com cupom' }, ok:'salvar' }) : prompt('Nome do protótipo', PT.cur.title);
  const t=String(v==null?'':v).trim(); if(!t||t===PT.cur.title) return;
  PT.cur.title=t.slice(0,80); ptChanged(); ptTabTitle(); ptPaintHd();
}
function ptAskAI(){
  const ia=window.protoIA; PT.panel='ia'; ptPaintRp();
  const fn=ia && (typeof ia.ask==='function'?ia.ask:typeof ia.olhar==='function'?ia.olhar:null);
  if(fn){ ptFlush().then(()=>{ try{ fn.call(ia, PT.cur); }catch(e){ console.error('protoIA.ask', e); } }); return; }
  toast('A IA que olha os comentários chega em breve','info');
}
// ⌘Z: a última correção aplicada pela IA (se houver) desfaz pela IA — ela também reabre os comentários; senão, o histórico daqui
function ptUndoAny(){
  const ia=window.protoIA; let s=null; try{ s=ia&&typeof ia.state==='function'?ia.state(PT.cur.id):null; }catch(_){ }
  if(ia && typeof ia.undo==='function' && s && s.undo){ ptFlush().then(()=>ia.undo(PT.cur)); return; }
  ptUndo();
}
async function ptParaDemanda(){
  await ptFlush();
  if(typeof window.protoParaDemanda==='function'){ try{ await window.protoParaDemanda(PT.cur.id); }catch(e){ if(typeof showErr==='function') showErr(e, 'Transformar em demanda'); } return; }
  toast('“Transformar em demanda” chega em breve · o protótipo fica salvo aqui','info');
}
function ptAct(a, b){
  const d=(b&&b.dataset)||{}; const s=ptSelInfo();
  switch(a){
    case 'rename': ptRename(b); break;
    case 'askai': ptAskAI(); break;
    case 'demanda': ptParaDemanda(); break;
    case 'comp': PT.compMenu=!PT.compMenu; ptPaintChrome(); if(PT.compMenu){ const m=document.querySelector('.pt-compm button'); if(m) m.focus(); } break;
    case 'compclose': PT.compMenu=false; ptPaintChrome(); break;
    case 'keys': PT.keysOpen=!PT.keysOpen; ptPaintRp(); break;
    case 'pinsave': ptSavePin(+d.id); break;
    case 'pincancel': PT.cur.pins=PT.cur.pins.filter(p=>p.id!==PT.openPin); PT.openPin=null; ptRender(); break;
    case 'openpin': ptOpenPin(+d.id); break;
    case 'resolve': { const p=PT.cur.pins.find(x=>x.id===+d.id); if(p){ ptSnap(); p.resolved=!p.resolved; if(PT.openPin===p.id) PT.openPin=null; ptChanged(); ptRender(); toast(p.resolved?`Comentário ${p.n} resolvido`:`Comentário ${p.n} reaberto`,'ok'); } break; }
    case 'pinsel': ptPinOnSel(); break;
    case 'askblk': { ptPinOnSel(); PT.draft='IA, mexe só aqui: '; const ta=$id('ptDraft'); if(ta){ ta.value=PT.draft; ta.focus(); } break; }
    case 'blkapply': if(s&&s.k==='blk'){ const h=$id('ptBlkHtml'), c=$id('ptBlkCss'); if(!PT.orig[s.id]) PT.orig[s.id]=JSON.stringify(PT.cur.screens.map(x=>x.html)); ptSnap(); const n=ptBlkSet(s.id, h?h.value:null, c?c.value:null); ptChanged(); ptRender(); toast(n>1?'Bloco atualizado nas telas':'Bloco atualizado','ok'); } break;
    case 'blkreset': if(s&&s.k==='blk'&&PT.orig[s.id]){ ptSnap(); const o=JSON.parse(PT.orig[s.id]); PT.cur.screens.forEach((x,i)=>{ if(o[i]!=null) x.html=o[i]; }); delete PT.orig[s.id]; ptChanged(); ptRender(); } break;
    case 'elapply': if(s&&s.e){ ptSnap(); s.e.html=($id('ptElHtml')||{}).value||''; ptChanged(); ptRender(); } break;
    case 'htmltgl': break;
    case 'crop': PT.crop=!PT.crop; ptRender(); break;
    case 'cropreset': if(s&&s.e){ ptSnap(); s.e.crop=null; ptChanged(); ptRender(); } break;
    case 'front': case 'back': if(s&&s.e){ ptSnap(); PT.cur.els=PT.cur.els.filter(x=>x!==s.e); a==='front'?PT.cur.els.push(s.e):PT.cur.els.unshift(s.e); ptChanged(); ptRender(); } break;
    case 'up': case 'down': { const i=PT.cur.els.findIndex(x=>String(x.id)===String(d.id)); const j=a==='up'?i+1:i-1; if(i>=0&&j>=0&&j<PT.cur.els.length){ ptSnap(); [PT.cur.els[i],PT.cur.els[j]]=[PT.cur.els[j],PT.cur.els[i]]; ptChanged(); ptRender(); } break; }
    case 'hide': { const x=PT.cur.els.find(k=>String(k.id)===String(d.id)); if(x){ ptSnap(); x.hidden=!x.hidden; ptChanged(); ptRender(); } break; }
    case 'dup': if(s&&s.e){ ptSnap(); const c=Object.assign(JSON.parse(JSON.stringify(s.e)), { id:ptNextId(), x:s.e.x+16, y:s.e.y+16, name:s.e.name+' cópia' }); PT.cur.els.push(c); PT.sel='el:'+c.id; ptChanged(); ptRender(); } break;
    case 'del': ptDelSel(); break;
    case 'file': ptPickFile(ptDefaultAb(), null); break;
    case 'scradd': if(PT_TELAS[d.id] && !ptScreen(d.id)){ ptSnap(); PT.cur.screens.push(ptTela(d.id)); ptChanged(); PT.zoom=null; PT.panX=PT.panY=0; ptRender(); toast(PT_TELAS[d.id].name+' adicionada','ok'); } break;
    case 'scrdel': (async()=>{ const x=ptScreen(d.id); if(!x||PT.cur.screens.length<2) return; if(String(x.html||'').trim() && !await askYes(`Tirar a tela ${x.name}? O HTML dela sai do protótipo (⌘Z desfaz).`)) return;
      ptSnap(); PT.cur.screens=PT.cur.screens.filter(k=>k!==x); PT.cur.els=PT.cur.els.filter(e=>e.screen!==x.id); PT.cur.pins=PT.cur.pins.filter(p=>p.screen!==x.id); PT.sel=null; ptChanged(); PT.zoom=null; ptRender(); })(); break;
    case 'saveretry': ptSaveNow(); break;
  }
}
function ptOpenPin(id){ const p=PT.cur.pins.find(x=>x.id===id); if(!p) return; const cur=ptCurPin(); if(cur&&cur.id!==id&&!String(cur.text||'').trim()) PT.cur.pins=PT.cur.pins.filter(x=>x!==cur); PT.openPin=id; PT.draft=''; PT.focusDraft=true; PT.panel='coment'; ptPaintLayers(); ptPaintRp(); }

// ---------------------------------------------------------------- quadro: ponteiro, roda, soltar
function ptAbPoint(ab, e){ const r=ab.getBoundingClientRect(); const d=ptAbDims(ab.dataset.ab)||PT_REF; const s=r.width/d.w; return { x:(e.clientX-r.left)/s, y:(e.clientY-r.top)/s, s }; }
function ptWireBoard(){
  const host=$id('ptBoard'); if(!host) return;
  host.addEventListener('pointerdown', ptDown);
  host.addEventListener('pointermove', ptHover);
  host.addEventListener('wheel', e=>{ if(e.target.closest('.pt-pop,.pt-compm')) return; e.preventDefault();
    if(e.ctrlKey||e.metaKey){ const s0=host._s||1; const s1=Math.min(2.5, Math.max(.08, s0*(e.deltaY<0?1.08:.92))); const hr=host.getBoundingClientRect(); const w=$id('ptWorld'); const m=(w.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)||[0,0,0]);
      const mx=e.clientX-hr.left, my=e.clientY-hr.top, tx=+m[1], ty=+m[2]; const nx=mx-(mx-tx)*s1/s0, ny=my-(my-ty)*s1/s0; PT.zoom=s1; ptLayoutWorld(); const m2=(w.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)||[0,0,0]); PT.panX+=nx-(+m2[1]); PT.panY+=ny-(+m2[2]); ptLayoutWorld(); }
    else { PT.panX-=e.deltaX; PT.panY-=e.deltaY; ptLayoutWorld(); } }, { passive:false });
  host.addEventListener('dragover', e=>{ e.preventDefault(); });
  host.addEventListener('drop', e=>{ e.preventDefault(); const ab=e.target.closest('.pt-ab')||host.querySelector('.pt-ab[data-ab="ref"]'); if(!ab) return; ptDropFiles(e, ab.dataset.ab, ptAbPoint(ab, e)); });
  host.addEventListener('focusout', e=>{ const n=e.target.closest&&e.target.closest('.pt-el.text'); if(!n) return; const el=PT.cur.els.find(x=>String(x.id)===n.dataset.el); if(el && el.text!==n.innerText){ ptSnap(); el.text=n.innerText; ptChanged(); } });
  host.addEventListener('dblclick', e=>{ const n=e.target.closest('.pt-el.text'); if(n){ PT.sel='el:'+n.dataset.el; ptPaintLayers(); const m=host.querySelector(`.pt-el[data-el="${n.dataset.el}"]`); if(m){ m.focus(); } } });
}
function ptHover(e){
  if(PT.drag || PT.tool!=='V' && PT.tool!=='C') return;
  const ab=e.target.closest('.pt-ab'); let n=null;
  if(ab && ab.dataset.ab!=='ref' && !e.target.closest('.pt-el,.pt-pin')){ const pt=ptAbPoint(ab, e); n=ptBlkAt(ab.dataset.ab, pt.x, pt.y); }
  if(PT.hov===n) return; if(PT.hov){ try{ PT.hov.classList.remove('sf-hov'); }catch(_){ } } PT.hov=n; if(n) n.classList.add('sf-hov');
}
function ptDown(e){
  if(!PT.cur) return; const host=$id('ptBoard');
  if(e.target.closest('.pt-tools,.pt-zoom,.pt-compm,.pt-pop,.pt-hint')) return;
  const pin=e.target.closest('.pt-pin'); if(pin){ e.preventDefault(); ptOpenPin(+pin.dataset.pin); return; }
  const ab=e.target.closest('.pt-ab');
  if(e.button===1 || PT.space || !ab){
    if(!ab && !PT.space && e.button!==1 && (PT.sel || PT.openPin!=null)){ PT.sel=null; PT.crop=false; const c=ptCurPin(); if(c&&!String(c.text||'').trim()) PT.cur.pins=PT.cur.pins.filter(p=>p!==c); PT.openPin=null; ptRender(); }
    PT.drag={ k:'pan', x:e.clientX, y:e.clientY, px:PT.panX, py:PT.panY }; host.setPointerCapture(e.pointerId); host.classList.add('panning'); return; }
  const pt=ptAbPoint(ab, e), abk=ab.dataset.ab, T=PT.tool;
  if(T==='V'){
    const h=e.target.closest('.pt-h'), elN=e.target.closest('.pt-el');
    if(h&&elN){ e.preventDefault(); const el=PT.cur.els.find(x=>String(x.id)===elN.dataset.el); ptSnap(); PT.drag={ k:PT.crop&&el.type==='img'?'crop':'rs', h:h.dataset.h, el, sx:pt.x, sy:pt.y, o:Object.assign({}, el, { crop:Object.assign({ t:0,r:0,b:0,l:0 }, el.crop||{}) }), n:elN, ab }; host.setPointerCapture(e.pointerId); return; }
    if(elN){ const el=PT.cur.els.find(x=>String(x.id)===elN.dataset.el); if(!el) return;
      if(el.type==='text' && PT.sel==='el:'+el.id) return; // editando o texto
      e.preventDefault();
      if(PT.sel!=='el:'+el.id){ PT.sel='el:'+el.id; PT.crop=false; if(PT.panel!=='camadas') PT.panel='props'; ptRender(); }
      ptSnap(); PT.drag={ k:'mv', el, sx:pt.x, sy:pt.y, o:{ x:el.x, y:el.y }, ab, moved:false }; host.setPointerCapture(e.pointerId); return; }
    if(abk!=='ref'){ const b=ptBlkAt(abk, pt.x, pt.y); if(b){ PT.sel='blk:'+b.getAttribute('data-blk'); PT.crop=false; PT.panel='props'; ptRender(); return; } }
    PT.sel=null; PT.crop=false; ptRender(); return;
  }
  e.preventDefault();
  if(T==='R'){ ptSnap(); const el={ id:ptNextId(), type:'box', screen:abk, x:pt.x, y:pt.y, w:1, h:1, name:'Caixa '+(PT.cur.els.filter(x=>x.type==='box').length+1), html:'', hidden:false, crop:null }; PT.cur.els.push(el); ptPaintLayers(); PT.drag={ k:'mk', el, sx:pt.x, sy:pt.y, ab }; host.setPointerCapture(e.pointerId); return; }
  if(T==='T'){ ptSnap(); const el={ id:ptNextId(), type:'text', screen:abk, x:Math.round(pt.x), y:Math.round(pt.y-12), w:200, h:28, name:'Texto', text:'Escreva aqui', hidden:false, crop:null }; PT.cur.els.push(el); PT.sel='el:'+el.id; PT.tool='V'; PT.panel='props'; ptChanged(); ptRender();
    const n=host.querySelector(`.pt-el[data-el="${el.id}"]`); if(n){ n.focus(); const r=document.createRange(); r.selectNodeContents(n); const sl=getSelection(); sl.removeAllRanges(); sl.addRange(r); } return; }
  if(T==='P'){ ptSnap(); const svgN=document.createElementNS('http://www.w3.org/2000/svg','svg'); svgN.setAttribute('class','pt-ink'); const p=document.createElementNS('http://www.w3.org/2000/svg','path'); svgN.appendChild(p); ab.appendChild(svgN); PT.drag={ k:'pen', pts:[[pt.x,pt.y]], p, svgN, ab:abk, abN:ab }; host.setPointerCapture(e.pointerId); return; }
  if(T==='C'){ let tg='ponto livre', sel=null; const elN=e.target.closest('.pt-el');
    if(elN){ const x=PT.cur.els.find(k=>String(k.id)===elN.dataset.el); tg=x?x.name:'elemento'; }
    else if(abk!=='ref'){ const b=ptBlkAt(abk, pt.x, pt.y); if(b){ tg=ptBlkLabel(b); sel=`[data-blk="${b.getAttribute('data-blk')}"]`; } }
    ptNewPin(abk, pt.x, pt.y, tg, sel); return; }
  if(T==='I'){ ptPickFile(abk, pt); }
}
document.addEventListener('pointermove', e=>{
  const d=PT.drag; if(!d) return;
  if(d.k==='pan'){ PT.panX=d.px+e.clientX-d.x; PT.panY=d.py+e.clientY-d.y; ptLayoutWorld(); return; }
  const abN=d.abN||document.querySelector(`#ptBoard .pt-ab[data-ab="${CSS.escape(d.el?d.el.screen:d.ab)}"]`); if(!abN) return;
  const pt=ptAbPoint(abN, e); const node=()=>d.n&&d.n.isConnected?d.n:(d.n=document.querySelector(`#ptBoard .pt-el[data-el="${d.el.id}"]`));
  if(d.k==='mv'){ const dx=pt.x-d.sx, dy=pt.y-d.sy; if(Math.abs(dx)+Math.abs(dy)>1) d.moved=true; d.el.x=Math.round(d.o.x+dx); d.el.y=Math.round(d.o.y+dy); const n=node(); if(n){ n.style.left=d.el.x+'px'; n.style.top=d.el.y+'px'; } }
  else if(d.k==='mk'){ const el=d.el; el.x=Math.round(Math.min(pt.x,d.sx)); el.y=Math.round(Math.min(pt.y,d.sy)); el.w=Math.round(Math.abs(pt.x-d.sx)); el.h=Math.round(Math.abs(pt.y-d.sy)); const n=node(); if(n) Object.assign(n.style, { left:el.x+'px', top:el.y+'px', width:el.w+'px', height:el.h+'px' }); }
  else if(d.k==='rs'){ const el=d.el, o=d.o, dx=pt.x-d.sx, dy=pt.y-d.sy, h=d.h;
    if(h.includes('e')) el.w=Math.max(16, o.w+dx); if(h.includes('s')) el.h=Math.max(12, o.h+dy);
    if(h.includes('w')){ el.w=Math.max(16, o.w-dx); } if(h.includes('n')){ el.h=Math.max(12, o.h-dy); }
    if(e.shiftKey && o.w>0){ el.h=el.w*o.h/o.w; }
    if(h.includes('w')) el.x=o.x+o.w-el.w; if(h.includes('n')) el.y=o.y+o.h-el.h;
    el.w=Math.round(el.w); el.h=Math.round(el.h); el.x=Math.round(el.x); el.y=Math.round(el.y);
    const n=node(); if(n) Object.assign(n.style, { left:el.x+'px', top:el.y+'px', width:el.w+'px', height:el.h+'px' }); }
  else if(d.k==='crop'){ const el=d.el, o=d.o.crop, dx=pt.x-d.sx, dy=pt.y-d.sy, cr=Object.assign({}, o);
    if(d.h==='nw') cr.t=Math.max(0, Math.min(el.h-20, o.t+dy)); if(d.h==='se') cr.b=Math.max(0, Math.min(el.h-20, o.b-dy));
    if(d.h==='sw') cr.l=Math.max(0, Math.min(el.w-20, o.l+dx)); if(d.h==='ne') cr.r=Math.max(0, Math.min(el.w-20, o.r-dx));
    Object.keys(cr).forEach(k=>cr[k]=Math.round(cr[k])); el.crop=cr; const n=node(); if(n) n.style.clipPath=`inset(${cr.t}px ${cr.r}px ${cr.b}px ${cr.l}px)`; }
  else if(d.k==='pen'){ d.pts.push([pt.x,pt.y]); d.p.setAttribute('d','M'+d.pts.map(p=>p.map(Math.round).join(' ')).join(' L')); }
});
document.addEventListener('pointerup', ()=>{
  const d=PT.drag; if(!d) return; PT.drag=null; const host=$id('ptBoard'); if(host) host.classList.remove('panning');
  if(d.k==='pan') return;
  if(d.k==='mv' && !d.moved){ PT.hist.pop(); return; }
  if(d.k==='mk'){ if(d.el.w<8||d.el.h<8){ d.el.w=180; d.el.h=72; } PT.sel='el:'+d.el.id; PT.tool='V'; PT.panel='props'; }
  if(d.k==='pen'){ d.svgN.remove(); if(d.pts.length<2){ PT.hist.pop(); return; }
    const xs=d.pts.map(p=>p[0]), ys=d.pts.map(p=>p[1]); const x0=Math.min(...xs)-4, y0=Math.min(...ys)-4, w=Math.max(...xs)-x0+8, h=Math.max(...ys)-y0+8;
    PT.cur.els.push({ id:ptNextId(), type:'pen', screen:d.ab, x:Math.round(x0), y:Math.round(y0), w:Math.round(w), h:Math.round(h), name:'Rabisco '+(PT.cur.els.filter(x=>x.type==='pen').length+1), d:'M'+d.pts.map(p=>[Math.round(p[0]-x0), Math.round(p[1]-y0)].join(' ')).join(' L'), hidden:false, crop:null }); }
  ptChanged(); ptRender();
});

// ---------------------------------------------------------------- teclado (só na aba do protótipo; nunca dentro de campo nem do terminal)
function ptTyping(el){ if(!el||!el.tagName) return false; if(/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true; return !!(el.closest && el.closest('.xterm,[contenteditable="true"]')); }
function ptModal(){ try{ return typeof escBusy==='function' && escBusy({ target:document.body }); }catch(_){ return false; } }
function ptKey(e){
  if(ptTabOn('prototipos')){ if((e.metaKey||e.ctrlKey) && e.key==='Enter' && e.target && e.target.id==='ptGenIn'){ e.preventDefault(); e.stopImmediatePropagation(); ptListGen(); } return; }
  if(!ptTabOn('prototipo') || ptModal()) return;
  const typing=ptTyping(e.target); const stop=()=>{ e.preventDefault(); e.stopImmediatePropagation(); };
  if(PT.gen && PT.gen.st==='loading'){ if(e.key==='Escape'){ stop(); ptGenCancel(); } return; }
  if(!PT.cur) return;
  if((e.metaKey||e.ctrlKey) && e.key==='Enter'){ stop(); if(e.target && e.target.id==='ptDraft'){ if(PT.openPin!=null) ptSavePin(PT.openPin); return; } ptAskAI(); return; }
  if((e.metaKey||e.ctrlKey) && !e.shiftKey && (e.key||'').toLowerCase()==='z' && !typing){ stop(); ptUndoAny(); return; }
  if(e.key==='Escape'){
    if(typing){ e.target.blur(); }
    if(PT.compMenu){ stop(); PT.compMenu=false; ptPaintChrome(); return; }
    if(PT.openPin!=null){ stop(); const c=ptCurPin(); if(c&&!String(c.text||'').trim()) PT.cur.pins=PT.cur.pins.filter(p=>p!==c); PT.openPin=null; ptRender(); return; }
    if(PT.crop){ stop(); PT.crop=false; ptRender(); return; }
    if(PT.sel){ stop(); PT.sel=null; ptRender(); }
    return; }
  if(typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if(e.key===' '){ stop(); if(!PT.space){ PT.space=true; const h=$id('ptBoard'); if(h) h.classList.add('grab'); } return; }
  const k=e.key.length===1?e.key.toUpperCase():e.key;
  if(k==='?'){ stop(); PT.keysOpen=!PT.keysOpen; PT.sel=null; PT.panel='props'; ptRender(); return; }
  if(k==='C' && PT.sel){ stop(); ptPinOnSel(); return; }
  if(e.key===']'||e.key==='['){ stop(); ptCycle(e.key===']'?1:-1); return; }
  if('VRTPCI'.includes(k) && k.length===1){ stop(); ptTool(k); toast(({ V:'Selecionar', R:'Caixa', T:'Texto', P:'Caneta', C:'Comentar', I:'Imagem' })[k]+' ('+k+')','info'); return; }
  if(k==='K'){ stop(); ptAct('comp'); return; }
  if((e.key==='Backspace'||e.key==='Delete') && PT.sel){ stop(); ptDelSel(); return; }
  if(e.key.startsWith('Arrow') && PT.sel && PT.sel.startsWith('el:')){ stop(); const s=ptSelInfo(); if(!s) return; if(!e.repeat) ptSnap(); const st=e.shiftKey?10:1; s.e.x+=e.key==='ArrowLeft'?-st:e.key==='ArrowRight'?st:0; s.e.y+=e.key==='ArrowUp'?-st:e.key==='ArrowDown'?st:0; ptChanged(); ptPaintLayers(); }
}
// o "?" global (54-acessibilidade: kbdKey, captura na janela) abriria os atalhos do app por cima: dentro do protótipo o "?"
// é dele. Registra ANTES do kbdKey (mesma fase de captura, ordem de registro) — fora da aba, ptKey não faz nada.
if(typeof kbdKey==='function'){ window.removeEventListener('keydown', kbdKey, true); window.addEventListener('keydown', ptKey, true); window.addEventListener('keydown', kbdKey, true); }
else window.addEventListener('keydown', ptKey, true);
window.addEventListener('keyup', e=>{ if(e.key===' ' && PT.space){ PT.space=false; const h=$id('ptBoard'); if(h) h.classList.remove('grab'); } });
document.addEventListener('paste', e=>{
  if(ptTyping(e.target)) return;
  const it=[...((e.clipboardData&&e.clipboardData.items)||[])].find(i=>/^image\//.test(i.type)); if(!it) return;
  if(ptTabOn('prototipo') && PT.cur){ e.preventDefault(); ptAddImageFile(it.getAsFile(), ptDefaultAb()); return; }
  if(ptTabOn('prototipos')){ e.preventDefault(); ptNewFromFile(it.getAsFile()); }
});

// ---------------------------------------------------------------- página Protótipos (lista + criar)
function ptPreviaTasks(){ try{ return (state.tasks||[]).filter(t=>t && t.status!=='archived' && t.status!=='merged').slice(-3).reverse(); }catch(_){ return []; } }
function ptListHtml(){
  const repo=(typeof state!=='undefined'&&state.repo)||null; const nm=repo&&typeof pathBase==='function'?pathBase(repo):'';
  const head=typeof semHead==='function'?semHead('Protótipos'+(nm?' · '+nm:''), 'Rascunhe uma tela antes de pedir o código. Comente, peça pra IA corrigir e transforme em demanda.'):`<header class="semhead"><div><h1>Protótipos</h1></div></header>`;
  if(!repo) return `<div class="sempg">${head}<div class="pt-state inline"><div class="pt-in"><div class="ill">${ptI('proto',30)}</div><h2>Abra um projeto</h2><p>O protótipo mora dentro do projeto (fica em .cardume/prototipos, fora do git).</p><div class="row"><button class="btn primary" data-ptl="projetos">Ver projetos</button></div></div></div></div>`;
  if(PT.listErr && !PT.list) return `<div class="sempg">${head}<div class="pt-state inline err"><div class="pt-in"><div class="ill">${ptI('err',30)}</div><h2>Não consegui ler os protótipos</h2><p>${ptE(PT.listErr)}</p><div class="row"><button class="btn primary" data-ptl="relist">Tentar de novo</button></div></div></div></div>`;
  const L=PT.list;
  if(L && !L.length && !PT.listShowAll) return `<div class="sempg">${head}<div class="pt-state inline"><div class="pt-in"><div class="ill">${ptI('proto',30)}</div><h2>Nenhum protótipo ainda</h2><p>Rascunhe uma tela antes de pedir o código. Comece em branco, de uma tela que já existe ou peça pra IA.</p><div class="row"><button class="btn" data-ptl="branco">Em branco</button><button class="btn" data-ptl="mostrar">De uma tela existente</button><button class="btn primary" data-ptl="mostrar-ia">IA gera a 1ª versão</button></div><p class="pt-dim">Ou cole um print aqui com ${ptK('⌘V')}.</p></div></div></div>`;
  const ia=typeof window.protoGerarIA==='function';
  const tasks=ptPreviaTasks();
  const cards=`<div class="pt-lbl">Novo protótipo</div><div class="pt-ccards">
    <div class="pt-cc"><h3>${ptI('blank')} Em branco</h3><p>Tela vazia no tamanho certo. Desenhe com caixas, texto e componentes.</p><div class="pt-opts"><button class="pt-opt" data-ptl="branco">Desktop 1280 <small>+ celular</small></button><button class="pt-opt" data-ptl="branco-cel">Só celular 390</button></div></div>
    <div class="pt-cc"><h3>${ptI('I')} De uma tela que já existe</h3><p>Vira um print editável pra você recortar e rabiscar por cima.</p><div class="pt-opts">${tasks.map(t=>`<button class="pt-opt" data-ptprev="${ptE(t.id)}">${ptI('eye',15)} <span class="pt-optx">Prévia · ${ptE(String(t.title||'tarefa').slice(0,40))}</span></button>`).join('')}<button class="pt-opt" data-ptl="arquivo">Colar print <small>⌘V</small></button><input class="pt-inp" id="ptListUrl" placeholder="Ou cole uma URL (https://…) e ↵" aria-label="URL da tela"></div></div>
    <div class="pt-cc ${ia?'hi':''}"><h3>${ptI('spark')} IA gera a 1ª versão ${ia?'':'<span class="pt-soon">em breve</span>'}</h3><p>Descreva a tela. A IA usa os Padrões do time e as telas do projeto.</p><textarea class="pt-inp" id="ptGenIn" rows="2" aria-label="Descrição da tela" placeholder="ex.: tela de checkout com cupom">${ptE(PT.genPrompt)}</textarea><button class="btn ${ia?'primary':''}" data-ptl="gerar" ${ia?'':'aria-disabled="true"'}>Gerar ${ptK('⌘↵')}</button></div></div>`;
  let rec='';
  if(L===null || (PT.listLoading && !L)) rec=`<div class="pt-recent">${[0,1,2].map(()=>`<div class="pt-rc"><div class="pt-thumb pt-skel"></div><div class="pt-meta"><span class="pt-skel" style="height:12px;width:70%"></span></div></div>`).join('')}</div>`;
  else if(L.length) rec=`<div class="pt-recent">${L.map((p,i)=>`<div class="pt-rc"><button class="pt-rc-open" data-ptopen="${ptE(p.id)}" aria-label="Abrir ${ptE(p.title)}"><div class="pt-thumb">${p.thumb&&i<12&&String(p.thumb.html||'').trim()?`<iframe class="pt-thumbf" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true" data-w="${+p.thumb.w||1280}" style="width:${+p.thumb.w||1280}px;height:${+p.thumb.h||840}px" srcdoc="${ptE(ptSrcdoc(p.thumb))}"></iframe>`:`<span class="pt-thumb-ph">${ptI('proto',22)}</span>`}</div><div class="pt-meta"><b>${ptE(p.title)}</b><span>${ptE(ptMetaTx(p))}</span><span class="pt-dim">${ptE(ptAgoTx(p.updatedAt))}</span></div></button><button class="pt-rc-del" data-ptdel="${ptE(p.id)}" aria-label="Apagar ${ptE(p.title)}" title="Apagar">${ptI('trash',14)}</button></div>`).join('')}</div>`;
  else rec=`<p class="pt-p">Os protótipos que você criar aparecem aqui, o mais recente primeiro.</p>`;
  return `<div class="sempg">${head}${cards}<div class="pt-lbl">Recentes${L&&L.length?' · '+L.length:''}</div>${rec}</div>`;
}
function ptListPaint(force){
  const pg=$id('protoListPage'); if(!pg || (!force && !ptTabOn('prototipos'))) return;
  let html=''; try{ html=ptListHtml(); }catch(e){ console.error('protótipos', e); html=`<div class="sempg"><p>Não consegui montar a lista: ${ptE(String(e&&e.message||e))}</p></div>`; }
  if(pg.__html===html){ ptThumbScale(); return; }
  const ae=document.activeElement; const keepGen=ae&&ae.id==='ptGenIn'; const sc=pg.scrollTop;
  pg.__html=html; pg.innerHTML=html; pg.scrollTop=sc;
  if(keepGen){ const g=$id('ptGenIn'); if(g){ g.focus(); g.setSelectionRange(g.value.length, g.value.length); } }
  ptWireList(pg); ptThumbScale();
}
function ptThumbScale(){ document.querySelectorAll('#protoListPage .pt-thumbf').forEach(f=>{ const c=f.parentElement; const w=+f.dataset.w||1280; if(c&&c.clientWidth) f.style.transform=`scale(${c.clientWidth/w})`; }); }
function ptWireList(pg){
  pg.querySelectorAll('[data-ptl]').forEach(b=>b.onclick=()=>{ const a=b.dataset.ptl;
    if(a==='branco') protoNew({ source:'branco' });
    else if(a==='branco-cel') protoNew({ source:'branco', only:'cel' });
    else if(a==='arquivo'){ const i=document.createElement('input'); i.type='file'; i.accept='image/*'; i.onchange=()=>{ const f=i.files&&i.files[0]; if(f) ptNewFromFile(f); }; i.click(); }
    else if(a==='gerar') ptListGen();
    else if(a==='mostrar'||a==='mostrar-ia'){ PT.listShowAll=true; ptListPaint(true); const n=$id(a==='mostrar'?'ptListUrl':'ptGenIn'); if(n) n.focus(); }
    else if(a==='relist') ptListLoad(true);
    else if(a==='projetos') openTab('projetos'); });
  pg.querySelectorAll('[data-ptopen]').forEach(b=>b.onclick=()=>openPrototipo(b.dataset.ptopen));
  pg.querySelectorAll('[data-ptprev]').forEach(b=>b.onclick=()=>ptNewFromPrevia(b.dataset.ptprev, b));
  pg.querySelectorAll('[data-ptdel]').forEach(b=>b.onclick=async()=>{ const id=b.dataset.ptdel; const p=(PT.list||[]).find(x=>x.id===id); if(!p) return;
    if(!await askYes(`Apagar o protótipo “${p.title}”? As telas, as imagens coladas e os comentários saem deste computador.`)) return;
    try{ await ptInv('proto_delete', { id }); }catch(e){ if(typeof showErr==='function') showErr(e, 'Apagar o protótipo'); return; }
    if(PT.cur&&PT.cur.id===id){ clearTimeout(PT.save.timer); PT.save.timer=0; PT.cur=null; PT.id=null; }
    const t=tabById('prototipo:'+id); if(t) closeTab(t.id);
    PT.list=(PT.list||[]).filter(x=>x.id!==id); ptSideCount(); ptListPaint(true); toast('Protótipo apagado','ok'); });
  const g=$id('ptGenIn'); if(g) g.oninput=()=>{ PT.genPrompt=g.value; };
  const u=$id('ptListUrl'); if(u) u.onkeydown=async e=>{ if(e.key!=='Enter') return; e.preventDefault(); const v=u.value.trim(); if(!/^https?:\/\/\S+$/i.test(v)){ toast('Cole um endereço que começa com http:// ou https://','warn'); return; }
    const id=await protoNew({ source:'url', prompt:v, title:'Tela de '+v.replace(/^https?:\/\//i,'').split('/')[0] }); if(id) ptAddUrl(v); };
}
function ptListGen(){
  const v=String(($id('ptGenIn')||{}).value||PT.genPrompt||'').trim();
  if(typeof window.protoGerarIA!=='function'){ toast('A IA que desenha a 1ª versão chega em breve — comece em branco ou de uma tela que já existe.','info'); return; }
  if(!v){ toast('Descreva a tela primeiro','warn'); const g=$id('ptGenIn'); if(g) g.focus(); return; }
  PT.genPrompt=''; protoNew({ source:'ia', prompt:v });
}
async function ptNewFromFile(f){ const id=await protoNew({ source:'print', title:'Print '+new Date().toLocaleDateString('pt-BR') }); if(id) await ptAddImageFile(f, 'ref'); }
async function ptNewFromPrevia(taskId, btn){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  if(btn) btn.disabled=true;
  try{
    const arts=await invoke('list_artifacts', { taskId });
    const img=(arts||[]).filter(a=>a.kind==='image').sort((a,b)=>(b.created||0)-(a.created||0))[0];
    if(!img){ toast('Essa tarefa ainda não tem print da Prévia — abra a Prévia (⌘4), tire um print e volte aqui.','info'); return; }
    const c=await invoke('read_artifact', { taskId, name:img.name });
    if(!c || !c.dataUrl){ toast('Não consegui ler o print da Prévia','warn'); return; }
    const id=await protoNew({ source:'previa', title:'Tela da '+String(t.title||'tarefa').slice(0,40), taskId:null, prompt:'' });
    if(id){ await ptAddDataUrl(c.dataUrl, 'previa-'+img.name.replace(/[^a-z0-9.]+/gi,'-'), 'ref'); toast('A Prévia virou um print editável · recorte e rabisque','ok'); }
  }catch(e){ if(typeof showErr==='function') showErr(e, 'Partir da Prévia'); }
  finally{ if(btn) btn.disabled=false; }
}

// outra frente gravou (IA resolveu comentários, ligou à tarefa): o objeto é o mesmo (protoState) — só repinta
window.addEventListener('sf:proto-salvo', e=>{ const d=e&&e.detail; if(PT.selfSave || !d || !PT.cur || d.id!==PT.cur.id) return; if(d.version>(+PT.cur.version||1)) PT.cur.version=d.version; if(ptActive()){ ptPaintHd(); ptPaintLayers(); ptPaintRp(); } });

// ---------------------------------------------------------------- ganchos pras outras frentes
window.openPrototipos=openPrototipos; window.openPrototipo=openPrototipo; window.protoNew=protoNew; window.protoState=protoState;
window.protoApplyScreens=protoApplyScreens; window.protoSnapshot=protoSnapshot; window.protoRepaint=()=>{ if(ptActive()) ptRender(); };
