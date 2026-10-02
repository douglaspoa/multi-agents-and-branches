// Starfork — 58-canvas
// ===== Workspace como CANVAS (spec-canvas-workspace F2) =====
// A tela da demanda deixa de ser "um modo por vez + chat fixo": são até 3 COLUNAS FIXAS (sem split recursivo), cada uma
// com abas tipadas (Meu app, Conversa, Celular, Documento, Mudanças, Entrega, Código, PR, Site qualquer). "+" abre com
// nomes humanos; arrastar uma aba pra borda de uma coluna divide (mostrando onde cai), pro meio junta; o layout é salvo
// POR DEMANDA (JSON versionado; inválido → padrão; "voltar ao normal"). ⌘\ divide · ⌘1..3 foca coluna · ⌘K painéis.
// Cada painel mostra nome+cor da demanda. Desempenho: só a aba ATIVA de cada coluna monta conteúdo; iframe/stream só
// pelo gerente de recursos (19-canvas-puro); os modos antigos viram HOSTS que só mudam de lugar; nada de setInterval.

const CV={ layouts:{}, nCols:-1, menu:null, lastMode:null, docs:{}, logs:{}, panes:{}, home:null };
const CV_HOSTS={ conversa:'fwChatCol', codigo:'fwCols', diff:'cvHostDiff', entrega:'cvHostEntrega', pr:'cvHostPr', dispositivo:'fwDev' };
const CV_ICON={ app:'◉', conversa:'❝', dispositivo:'▯', documento:'▤', diff:'±', entrega:'✓', codigo:'</>', pr:'⇄', site:'◍', demanda:'◐', log:'≡' };

function cvTask(id){ return ((typeof state!=='undefined'&&state.tasks)||[]).find(t=>t.id===id)||null; }
// o que faz sentido NESTA demanda — pelo TIPO da entrega/projeto (veto: nada de "modo simples")
function cvCtxOf(t){
  if(!t) return {};
  const nonCode=!!((typeof fwArtOnly==='function' && fwArtOnly(t)) || (typeof entregaNonCode==='function' && entregaNonCode(t)));
  const plan=(typeof ENV!=='undefined' && ENV[t.id]) ? ENV[t.id].plan : undefined;
  const web=nonCode ? false : (plan==null ? null : !!plan.web);
  const info=(typeof DV!=='undefined') ? DV.info[t.id] : null;
  const mobile=!!(info && info.mobile && (info.platforms||[]).length);
  return { nonCode, web, mobile, doc:nonCode?cvMainDoc(t):null, hasPr:!!t.prUrl };
}
function cvMainDoc(t){ const arts=(typeof entregaArts==='function')?entregaArts(t):[]; if(!arts.length) return null; const n=(typeof enPvPick==='function')?enPvPick(t, arts):arts[0].name; return n?'art:'+n:null; }
function cvAllow(t, ctx){ return (type)=>{
  if(ctx.nonCode && ['app','diff','codigo','log'].includes(type)) return false;
  if(ctx.web===false && ['app','log'].includes(type) && !ctx.nonCode) return false;
  return true; }; }
// ---------- layout da demanda (memória → localStorage → padrão) ----------
function cvLayout(){
  const h=typeof fwTask!=='undefined'?fwTask:null; if(!h) return null;
  if(CV.layouts[h]) return CV.layouts[h];
  const t=cvTask(h), ctx=cvCtxOf(t);
  let raw=null; try{ raw=localStorage.getItem('cv:l:'+h); }catch(_){ }
  let l=raw?cvValidate(raw, { homeId:h, taskIds:(state.tasks||[]).map(x=>x.id), allow:cvAllow(t, ctx) }):null;
  if(!l) l=cvDefaultLayout(h, ctx);
  CV.layouts[h]=l; return l;
}
function cvSave(l){ const h=fwTask; if(!h) return; CV.layouts[h]=l; try{ localStorage.setItem('cv:l:'+h, cvSerialize(l)); }catch(_){ } }
function cvSet(l, noRender){
  const h=fwTask; if(!h) return;
  if(!l) l=cvDefaultLayout(h, cvCtxOf(cvTask(h)));
  cvSave(l); cvSyncMode(l);
  if(!noRender && typeof renderWorkspace==='function') renderWorkspace();
}
function cvReset(){ const h=fwTask; if(!h) return; try{ localStorage.removeItem('cv:l:'+h); }catch(_){ } delete CV.layouts[h]; cvSet(null); toast('painéis de volta ao normal','ok'); }
function cvApplyPreset(name){ const h=fwTask; if(!h) return; cvSet(cvPreset(name, h, cvCtxOf(cvTask(h)))); }
// tipo da aba visível da demanda-casa
function cvShows(type){ const l=cvLayout(); if(!l) return false; return cvVisible(l).some(t=>t.type===type && cvPaneTask(t, fwTask)===fwTask); }
// legado: os modos antigos continuam funcionando (fwMode='entrega' + renderWorkspace() abre a aba Entrega)
function cvSyncMode(l){ const c=l&&l.cols[l.focus|0]; const a=c&&c.tabs.find(x=>x.id===c.active); const m=a&&CV_TYPE2MODE[a.type]; if(m){ fwMode=m; } CV.lastMode=fwMode; }
// abre (ou foca) uma aba. col: índice, 'new', ou automático (a coluna em foco — mas sem cobrir a Conversa)
function cvOpenType(type, col, extra, noRender){
  const h=fwTask; const l=cvLayout(); if(!h||!l) return false;
  const who=(CV_TYPES[type]||{}).who;
  const tab=cvMkTab(type, who==='free'?null:((extra&&extra.taskId)||h), extra);
  if(col===undefined){
    const ex=cvFindTab(l, tab.id);
    if(!ex){ const f=l.focus|0, fc=l.cols[f]; const act=fc&&fc.tabs.find(x=>x.id===fc.active);
      if(act && act.type==='conversa' && type!=='conversa'){ const other=l.cols.findIndex((c,i)=>i!==f && !c.tabs.some(x=>x.id===c.active && x.type==='conversa')); col=other>=0?other:(l.cols.length<CV_MAX_COLS?'new':f); } }
  }
  const n=cvAddTab(l, tab, col);
  if(!n){ toast(`no máximo ${CV_MAX_TASKS} demandas lado a lado por enquanto`,'warn'); return false; }
  cvSet(n, noRender); return true;
}
function cvCloseTabId(id){ const l=cvLayout(); if(!l) return; const f=cvFindTab(l, id); if(f) cvOnPaneGone(f.tab); cvSet(cvCloseTab(l, id)); }
// ---------- hosts (os modos antigos) e painéis novos ----------
function cvHostEl(type){ const id=CV_HOSTS[type]; if(!id) return null; let el=$id(id); if(!el){ el=document.createElement('div'); el.id=id; el.className='cvhost cvhost-'+type; const pk=$id('cvPark'); if(pk) pk.appendChild(el); } el.dataset.cvhost=type; return el; }
function cvPaneEl(tab){ let el=CV.panes[tab.id]; if(!el){ el=document.createElement('div'); el.className='cvpane cvpane-'+tab.type; el.dataset.cvpane=tab.id; CV.panes[tab.id]=el; } return el; }
function cvElFor(tab){
  const home=cvPaneTask(tab, fwTask)===fwTask;
  if(home && CV_HOSTS[tab.type]){
    if(tab.type==='dispositivo'){ const t=cvTask(fwTask), c=cvCtxOf(t); if(!c.mobile) return cvPaneEl(tab); }
    return cvHostEl(tab.type);
  }
  return cvPaneEl(tab);
}
// saiu da tela: host volta pro estacionamento (mantém estado); painel pesado solta o recurso NA HORA
function cvUnplace(el){
  if(el.dataset.cvhost){ const pk=$id('cvPark'); if(pk) pk.appendChild(el); return; }
  cvPaneHidden(el); el.remove();
}
function cvPaneHidden(el){
  const app=el.querySelector('[data-envtask]'); if(app && typeof nvUnmount==='function'){ const st=(typeof nvState!=='undefined')?nvState[app.dataset.envtask]:null; if(st && st.frame) nvUnmount(app.dataset.envtask); }
  if(el.classList.contains('cvpane-site')) cvSiteUnmount(el);
}
function cvOnPaneGone(tab){ const el=CV.panes[tab.id]; if(el){ cvPaneHidden(el); el.remove(); delete CV.panes[tab.id]; } }
function cvPlace(body, el){
  if(body.childElementCount===1 && body.firstElementChild===el) return false;
  [...body.children].forEach(c=>cvUnplace(c));
  body.appendChild(el); return true;
}
// ---------- render ----------
function cvTabLabel(tab){
  const t=tab.taskId?cvTask(tab.taskId):null;
  if(tab.type==='documento' && tab.ref) return String(tab.ref).slice(String(tab.ref).indexOf(':')+1).split('/').pop();
  if(tab.type==='site'){ const s=cvSiteUrl(tab.url); return s?(s.video?'vídeo · ':'')+s.host:'site'; }
  if(tab.type==='demanda') return t?t.title:'demanda';
  if(tab.taskId && tab.taskId!==fwTask && t) return CV_TYPES[tab.type].label+' · '+t.title;
  return CV_TYPES[tab.type].label;
}
function cvTabsHtml(l, ci){
  const c=l.cols[ci];
  return c.tabs.map(tab=>{ const on=tab.id===c.active, other=tab.taskId&&tab.taskId!==fwTask;
    const lab=cvTabLabel(tab);
    return `<div class="cvtab${on?' on':''}${other?' other':''}" role="tab" tabindex="${on?0:-1}" aria-selected="${on}" draggable="true" data-cvtab="${tab.id}" title="${escA(lab+' — arraste pra outra coluna ou pra borda pra dividir')}">${other?`<span class="cvtdot" style="background:${cvTaskColor(tab.taskId, fwTask)}"></span>`:`<span class="cvtic" aria-hidden="true">${esc(CV_ICON[tab.type]||'')}</span>`}<span class="cvtl">${esc(String(lab).slice(0,40))}</span><button type="button" class="cvtx" data-cvclose="${tab.id}" aria-label="${escA('fechar '+lab)}" title="fechar">×</button></div>`; }).join('');
}
// cabeçalho do painel: nome + cor da demanda DONA dele (+ botões de prova, F4)
function cvHeadHtml(tab){
  const tid=cvPaneTask(tab, fwTask), t=cvTask(tid);
  const isSite=tab.type==='site';
  const name=isSite?((cvSiteUrl(tab.url)||{}).host||'site'):(t?t.title:'demanda');
  return `<span class="cvdot" style="background:${isSite?'var(--muted)':cvTaskColor(tid, fwTask)}" aria-hidden="true"></span><span class="cvhn" title="${escA(isSite?'site externo (fora da demanda)':'demanda: '+name)}">${esc(name)}</span><span class="cvht">· ${esc(CV_TYPES[tab.type].label)}${isSite?' · fora da demanda':''}</span><span class="cvhsp"></span>${typeof cvProofBtnsHtml==='function'?cvProofBtnsHtml(tab):''}`;
}
function cvColStyle(l, ci, n){
  const w=Array.isArray(l.w)?l.w[ci]:null;
  if(w) return `flex:${w} 1 0`;
  const c=l.cols[ci], a=c.tabs.find(x=>x.id===c.active);
  if(n>1 && a && a.type==='conversa') return 'flex:0 0 clamp(300px, 30%, 420px)'; // a conversa ao lado, como antes
  return 'flex:1 1 0';
}
function cvSkeleton(root, n){
  [...root.querySelectorAll('.cvbody')].forEach(b=>[...b.children].forEach(c=>cvUnplace(c)));
  let h='';
  for(let i=0;i<n;i++){
    if(i) h+=`<div class="cvsplit" data-cvsplit="${i-1}" role="separator" aria-orientation="vertical" aria-label="arrastar pra mudar a largura das colunas" tabindex="-1"></div>`;
    h+=`<section class="cvcol" data-col="${i}" aria-label="coluna ${i+1}"><div class="cvbar"><div class="cvtabs" role="tablist" aria-label="abas da coluna ${i+1}"></div><button type="button" class="cvplus" data-cvplus="${i}" aria-label="abrir outro painel nesta coluna" title="abrir outro painel (⌘K)">+</button></div><div class="cvhead" data-cvhead="${i}"></div><div class="cvbody" data-cvbody="${i}" role="tabpanel"></div><div class="cvdrop" hidden></div></section>`;
  }
  root.innerHTML=h; CV.nCols=n;
}
function cvRender(t){
  const root=$id('cvCanvas'); if(!root||!t) return;
  let l=cvLayout(); if(!l) return;
  // pedido do jeito antigo (fwMode='entrega' + renderWorkspace) → abre a aba
  if(fwMode!==CV.lastMode){ const ty=CV_MODE2TYPE[fwMode]; CV.lastMode=fwMode; if(ty && !cvShows(ty)){ cvOpenType(ty, undefined, null, true); l=cvLayout(); } }
  // como ligar o projeto (1 detecção por demanda): decide se "Meu app" faz sentido no "+" e no layout automático
  if(typeof envPlanEnsure==='function' && !cvCtxOf(t).nonCode) envPlanEnsure(t.id);
  l=cvAdapt(t, l);
  if(CV.home!==fwTask){ CV.home=fwTask; CV.nCols=-1; }
  const n=l.cols.length;
  if(CV.nCols!==n || root.childElementCount!==n*2-1) cvSkeleton(root, n);
  root.dataset.n=n;
  l.cols.forEach((c,ci)=>{
    const col=root.querySelector(`.cvcol[data-col="${ci}"]`); if(!col) return;
    col.classList.toggle('focus', (l.focus|0)===ci && n>1);
    col.setAttribute('style', cvColStyle(l, ci, n));
    const tabs=col.querySelector('.cvtabs'); const th=cvTabsHtml(l, ci); if(tabs.__html!==th){ tabs.__html=th; tabs.innerHTML=th; }
    const tab=c.tabs.find(x=>x.id===c.active)||c.tabs[0];
    const head=col.querySelector('.cvhead'); const hh=cvHeadHtml(tab); if(head.__html!==hh){ head.__html=hh; head.innerHTML=hh; }
    const body=col.querySelector('.cvbody'); body.setAttribute('aria-label', cvTabLabel(tab));
    const el=cvElFor(tab); cvPlace(body, el);
    cvRenderPane(tab, el, t);
  });
  // o que não está visível volta pro estacionamento (hosts ficam vivos; painéis soltos saem)
  const vis=new Set(cvVisible(l).map(x=>cvElFor(x)));
  Object.keys(CV.panes).forEach(id=>{ if(!cvFindTab(l, id)){ cvOnPaneGone({ id }); } else { const el=CV.panes[id]; if(!vis.has(el) && el.isConnected && !el.closest('#cvPark')){ cvUnplace(el); } } });
  // Celular: só quando a aba dele está na tela (o stream respeita o teto de 1)
  if(typeof dvSync==='function') dvSync(t);
  cvWireOnce(root);
}
// adaptação do layout AUTOMÁTICO (ninguém mexeu): o que a demanda tem de verdade chegou depois (detecção, provas)
function cvAdapt(t, l){
  const ctx=cvCtxOf(t); let n=l, changed=false;
  if(l.auto){
    for(const c of n.cols) for(const tab of c.tabs){
      if(tab.type==='app' && tab.taskId===t.id && ctx.web===false){ const rep=ctx.nonCode?cvMkTab('documento', t.id, ctx.doc?{ ref:ctx.doc }:null):ctx.mobile?cvMkTab('dispositivo', t.id):cvMkTab('entrega', t.id); n=cvReplaceTab(n, tab.id, rep); n.auto=true; changed=true; break; }
      if(tab.type==='documento' && !tab.ref && tab.taskId===t.id && ctx.doc){ n=cvReplaceTab(n, tab.id, cvMkTab('documento', t.id, { ref:ctx.doc })); n.auto=true; changed=true; break; }
    }
  }
  // P9 — terminou: o entregável abre sozinho (uma vez por demanda)
  const fin=['review','delivered'].includes(t.status) || (typeof taskIsDone==='function' && taskIsDone(t));
  if(fin && !(n.opened||[]).includes('fim')){
    const tab=ctx.nonCode?cvMkTab('documento', t.id, ctx.doc?{ ref:ctx.doc }:null):cvMkTab('entrega', t.id);
    if(!ctx.nonCode || ctx.doc){
      const keepAuto=n.auto;
      const at=n.cols.findIndex(c=>!c.tabs.some(x=>x.id===c.active && x.type==='conversa'));
      const m=cvAddTab(n, tab, at>=0?at:undefined)||n; m.auto=keepAuto; m.opened=[...(n.opened||[]), 'fim'];
      n=m; changed=true;
    }
  }
  if(changed){ cvSave(n); cvSyncMode(n); }
  return n;
}
function cvRenderPane(tab, el, home){
  const tid=cvPaneTask(tab, fwTask), t=cvTask(tid);
  try{
    if(tab.type==='app') return (typeof appRender==='function') ? appRender(tid, el) : null;
    if(tab.type==='diff') return cvDiffRender(home, el);
    if(tab.type==='entrega') return fwRenderEntrega(home, el);
    if(tab.type==='pr') return fwRenderPrPage(home, el);
    if(tab.type==='documento') return cvDocRender(tab, el, t);
    if(tab.type==='site') return cvSiteRender(tab, el);
    if(tab.type==='log') return cvLogRender(tab, el);
    if(tab.type==='demanda') return (typeof cvDemandaRender==='function') ? cvDemandaRender(tab, el, t) : null;
    if(tab.type==='dispositivo' && el.classList.contains('cvpane')) return cvPaint(el, `<div class="cvempty"><b>Este projeto não é de celular</b><span>O painel Celular mostra o Simulador iOS ou o emulador Android quando a demanda é um app de celular. Pelo <b>+</b> dá pra abrir o app no navegador, um documento ou um site.</span></div>`);
    // conversa / código: o renderWorkspace pinta (guarda própria)
  }catch(e){ console.error('painel '+tab.type, e); }
}
function cvPaint(el, html){ if(el.__html!==html){ el.__html=html; el.innerHTML=html; return true; } return false; }
// ---------- Mudanças (diff): lista de arquivos + o diff do escolhido (o renderer de sempre) ----------
function cvDiffRender(t, el){
  if(!el.querySelector('.cvdiffmain')) el.innerHTML='<div class="cvdiff"><div class="cvdifffiles" role="listbox" aria-label="arquivos alterados"></div><div class="cvdiffmain fwmain"></div></div>';
  const files=(fwFiles||[]).filter(f=>!f.doc);
  const list=el.querySelector('.cvdifffiles');
  const lh=files.length?files.map(f=>`<button type="button" class="cvdf${f.path===fwPath?' on':''}" role="option" aria-selected="${f.path===fwPath}" data-cvdf="${escA(f.path)}" title="${escA(f.path)}"><span class="cvdfn mono">${esc(f.path.split('/').pop())}</span><span class="cvdfa">+${f.add} <span style="color:var(--crit)">−${f.del}</span></span></button>`).join(''):`<div class="dim" style="padding:8px;font-size:11.5px">${fwFilesLoading?'carregando…':'nenhum arquivo alterado ainda'}</div>`;
  if(list.__html!==lh){ list.__html=lh; list.innerHTML=lh; list.querySelectorAll('[data-cvdf]').forEach(b=>b.onclick=()=>{ fwPath=b.dataset.cvdf; fwEditing=false; if(typeof fwLoadFile==='function') fwLoadFile(); renderWorkspace(); }); }
  if(typeof fwRenderDiff==='function') fwRenderDiff(t, el.querySelector('.cvdiffmain'));
}
// ---------- Documento (README, arquivo, entregável) — leitura, com os visualizadores da Entrega ----------
function cvDocChoices(t){
  const out=[], seen=new Set(); const add=(ref, label, hint)=>{ if(seen.has(ref)) return; seen.add(ref); out.push({ ref, label, hint }); };
  ((typeof entregaArts==='function')?entregaArts(t):[]).forEach(a=>add('art:'+a.name, a.name, 'entregue pelo agente'));
  add('file:README.md', 'README.md', 'o leia-me do projeto');
  if(t && t.id===fwTask) (fwFiles||[]).filter(f=>/\.(md|markdown|pdf|csv|tsv|txt)$/i.test(f.path)).slice(0,12).forEach(f=>add('file:'+f.path, f.path.split('/').pop(), f.doc?'anexo':'alterado nesta demanda'));
  (Array.isArray(t&&t.refs)?t.refs:[]).slice(0,8).forEach(r=>{ const rel=String(r); add('ref:'+(rel.includes('/')?rel:'.cardume/refs/'+rel), rel.split('/').pop(), 'anexo da demanda'); });
  return out;
}
function cvDocRender(tab, el, t){
  if(!t) return cvPaint(el, '<div class="cvempty"><b>Esta demanda não existe mais</b></div>');
  if(!tab.ref){
    if(typeof fwArtsEnsure==='function' && t.id===fwTask) fwArtsEnsure(t);
    const ch=cvDocChoices(t);
    const h=`<div class="cvempty cvchooser"><b>Qual documento abrir?</b><span>Escolha um arquivo pra ler aqui, ao lado da demanda.</span><div class="cvcards">${ch.map(c=>`<button type="button" class="cvcard" data-cvdoc="${escA(c.ref)}"><span class="cvcic">${esc(({ pdf:'PDF', md:'MD', csv:'CSV', image:'IMG', text:'TXT', html:'HTML' }[pvKind(c.label)]||'ARQ'))}</span><span><b>${esc(c.label)}</b><span class="dim">${esc(c.hint)}</span></span></button>`).join('')}</div><span class="dim">Também dá pra arrastar um PDF ou um link pra cá.</span></div>`;
    if(cvPaint(el, h)) el.querySelectorAll('[data-cvdoc]').forEach(b=>b.onclick=()=>{ const l=cvLayout(); cvSet(cvReplaceTab(l, tab.id, cvMkTab('documento', t.id, { ref:b.dataset.cvdoc }))); });
    return;
  }
  const ref=String(tab.ref), kind=ref.slice(0, ref.indexOf(':')), name=ref.slice(ref.indexOf(':')+1);
  const k=t.id+'|'+ref; let c=CV.docs[k];
  if(c===undefined){ CV.docs[k]=null; c=null;
    invoke('read_artifact',{ taskId:t.id, name }).then(v=>{ CV.docs[k]=v||{ err:'arquivo vazio' }; }).catch(e=>{ CV.docs[k]={ err:(typeof humanErr==='function'?humanErr(e,'Não consegui abrir o documento').msg:String(e&&e.message||e)) }; })
      .finally(()=>{ const e2=CV.panes[tab.id]; if(e2 && e2.isConnected) cvDocRender(tab, e2, cvTask(t.id)); }); }
  const pk=pvKind(name);
  const h=`<div class="cvdoc"><div class="cvdocbar"><span class="en-dic">${esc(({ pdf:'PDF', md:'MD', csv:'CSV', image:'IMG', text:'TXT', html:'HTML', video:'VÍDEO' }[pk]||'ARQ'))}</span><b class="cvdocn" title="${escA(name)}">${esc(name)}</b><span class="dim">· ${esc(kind==='art'?'entregue':kind==='ref'?'anexo':'do projeto')}</span><span style="flex:1"></span><button type="button" class="btn sm ghost" data-cvdocx="choose">trocar</button>${kind==='art'?`<button type="button" class="btn sm" data-cvdocx="open" title="abre no programa padrão do computador">${IC.extlink||'↗'} abrir no app padrão</button>`:''}</div><div class="pv-body pv-${pk} cvdocbody">${artPreviewHtml(name, c, t.id)}</div></div>`;
  if(cvPaint(el, h)) el.querySelectorAll('[data-cvdocx]').forEach(b=>b.onclick=()=>{
    if(b.dataset.cvdocx==='open') invoke('open_artifact',{ taskId:t.id, name }).catch(e=>showErr(e, 'Não abriu'));
    else { const l=cvLayout(); cvSet(cvReplaceTab(l, tab.id, cvMkTab('documento', t.id))); } });
}
// ---------- Site qualquer: iframe SEM proxy, SEM mira, SEM ponte; "abrir fora" sempre à mão ----------
function cvSiteRender(tab, el){
  const s=cvSiteUrl(tab.url); if(!s) return cvPaint(el, '<div class="cvempty"><b>Endereço inválido</b><span>Só endereços http(s).</span></div>');
  const key='site:'+tab.id;
  if(el.dataset.site!==tab.url || !el.querySelector('.cvsitestage')){
    el.dataset.site=tab.url; el.__html='';
    el.innerHTML=`<div class="cvsite"><div class="cvsitebar"><span class="cvsitehost mono" title="${escA(s.url)}">${esc(s.url.replace(/^https?:\/\//,'').slice(0,80))}</span><span style="flex:1"></span><button type="button" class="btn sm ghost" data-cvs="reload" title="recarregar">${IC.refresh||'↻'}</button><button type="button" class="btn sm" data-cvs="ext">${IC.extlink||'↗'} abrir fora</button></div><div class="cvsitestage"></div><div class="cvsitefoot">não apareceu? alguns sites não deixam abrir dentro de outro app — <button type="button" class="lnk" data-cvs="ext">abrir fora</button></div></div>`;
    el.querySelectorAll('[data-cvs]').forEach(b=>b.onclick=()=>{ if(b.dataset.cvs==='ext') openExternal(s.url); else { cvSiteUnmount(el); el.__frozen=false; cvSiteRender(tab, el); } });
  }
  const stage=el.querySelector('.cvsitestage');
  if(s.blocked){ cvPaint(stage, `<div class="cvempty"><b>Este site não deixa abrir dentro de outro app</b><span>${esc(s.host)} bloqueia isso por segurança. Abra no seu navegador — a demanda continua aqui.</span><button type="button" class="btn primary" data-cvsx="1">${IC.extlink||'↗'} abrir ${esc(s.host)} fora</button></div>`); const b=stage.querySelector('[data-cvsx]'); if(b) b.onclick=()=>openExternal(s.url); return; }
  if(el.__frozen){ cvPaint(stage, '<div class="cvempty"><b>Site pausado</b><span>Pra o Mac não esquentar, ficam no máximo 2 páginas vivas ao mesmo tempo.</span><button type="button" class="btn sm primary" data-cvres="1">continuar daqui</button></div>'); const b=stage.querySelector('[data-cvres]'); if(b) b.onclick=()=>{ el.__frozen=false; stage.__html=''; stage.innerHTML=''; cvSiteRender(tab, el); }; return; }
  if(stage.querySelector('iframe')) return;
  stage.__html=''; stage.innerHTML='';
  cvRmTake('web', key, ()=>{ cvSiteUnmount(el); el.__frozen=true; if(el.isConnected) cvSiteRender(tab, el); });
  const f=document.createElement('iframe');
  f.className='cvsiteframe'; f.title='site: '+s.host; f.src=s.embed;
  // sem allow-top-navigation (não tira o Starfork da tela); same-origin aqui é a origem DO SITE, nunca a do app
  f.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation');
  f.setAttribute('allow','autoplay; encrypted-media; picture-in-picture; fullscreen');
  f.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
  stage.appendChild(f);
}
function cvSiteUnmount(el){ const f=el.querySelector('iframe.cvsiteframe'); if(f){ try{ f.src='about:blank'; f.remove(); }catch(_){ } } const id=el.dataset.cvpane; if(id) cvRmDrop('web', 'site:'+id); }
// ---------- Detalhes do ambiente (log) — só quando a pessoa pede ----------
function cvLogRender(tab, el){
  const tid=cvPaneTask(tab, fwTask); const lg=CV.logs[tid];
  if(lg===undefined) cvLogLoad(tid, tab);
  const s=(typeof ENV!=='undefined'&&ENV[tid])?ENV[tid]:{};
  cvPaint(el, `<div class="cvlog"><div class="cvlogbar"><b>Detalhes do ambiente</b><span class="dim">${esc((s.plan&&s.plan.label)||'')}</span><span style="flex:1"></span><button type="button" class="btn sm" data-cvlog="1">atualizar</button></div><pre class="mono envlog cvlogpre">${esc(lg==null?'carregando…':(lg||'(nada ainda — o registro aparece quando o ambiente sobe)'))}</pre></div>`);
  const b=el.querySelector('[data-cvlog]'); if(b) b.onclick=()=>cvLogLoad(tid, tab);
}
function cvLogLoad(tid, tab){ CV.logs[tid]=null; invoke('env_status',{ taskId:tid, log:true }).then(v=>{ CV.logs[tid]=(v&&v.log)||''; }).catch(e=>{ CV.logs[tid]=String(e&&e.message||e); }).finally(()=>{ const el=CV.panes[tab.id]; if(el&&el.isConnected) cvLogRender(tab, el); }); }
// "detalhes" da faixa do ambiente → painel de log (numa coluna nova, se couber)
function cvOpenLog(taskId){ if(!fwTask) return; CV.logs[taskId]=undefined; cvOpenType('log', cvLayout().cols.length<CV_MAX_COLS?'new':undefined); }

// ---------- menu "+" / ⌘K ----------
function cvCloseMenu(){ const m=CV.menu; CV.menu=null; if(m){ m.remove(); document.removeEventListener('mousedown', cvMenuOut, true); } }
function cvMenuOut(e){ const m=CV.menu; if(m && !m.contains(e.target) && !e.target.closest('[data-cvplus]')) cvCloseMenu(); }
function cvOthers(){ return (state.tasks||[]).filter(x=>x.id!==fwTask && !(typeof taskIsDone==='function' && taskIsDone(x) && x.flag==='closed')).slice(-12).reverse(); }
function cvMenuItems(col){
  const t=cvTask(fwTask), ctx=cvCtxOf(t), l=cvLayout();
  return cvPlusItems(Object.assign({}, ctx, { others:cvOthers().map(x=>({ id:x.id, title:x.title })), tasksN:cvTasksIn(l).length||1 }));
}
function cvOpenMenu(anchor, col, quick){
  cvCloseMenu();
  const m=document.createElement('div'); m.className='cvmenu'; m.setAttribute('role','menu'); m.setAttribute('aria-label','abrir um painel');
  const items=cvMenuItems(col);
  const row=(i, x)=>`<button type="button" class="cvmi${x.disabled?' off':''}" role="menuitem" data-cvmi="${i}"${x.disabled?' aria-disabled="true"':''} title="${escA(x.why||x.hint)}"><span class="cvmic" aria-hidden="true">${esc(CV_ICON[x.type]||'')}</span><span class="cvmt"><b>${esc(x.label)}</b><span>${esc(x.why||x.hint)}</span></span>${x.type==='documento'||x.type==='demanda'||x.type==='site'?'<span class="cvmch" aria-hidden="true">›</span>':''}</button>`;
  m.innerHTML=(quick?'<input class="in cvmq" placeholder="painel, documento ou demanda…" aria-label="filtrar painéis">':'')+
    `<div class="cvml">${items.map((x,i)=>row(i,x)).join('')}</div>`+
    `<div class="cvmfoot"><button type="button" class="lnk" data-cvpreset="construir">Construir</button><button type="button" class="lnk" data-cvpreset="revisar">Revisar</button><button type="button" class="lnk" data-cvpreset="normal">voltar ao normal</button></div>`;
  document.body.appendChild(m); CV.menu=m;
  const r=anchor?anchor.getBoundingClientRect():{ left:window.innerWidth/2-160, bottom:120, right:window.innerWidth/2+160 };
  m.style.top=Math.min(window.innerHeight-m.offsetHeight-8, r.bottom+6)+'px';
  m.style.left=Math.max(8, Math.min(window.innerWidth-m.offsetWidth-8, r.left))+'px';
  setTimeout(()=>document.addEventListener('mousedown', cvMenuOut, true), 0);
  const pick=(x)=>{
    if(x.disabled){ if(x.why) toast(x.why,'info'); return; }
    if(x.type==='documento') return cvSubMenu(m, cvDocChoices(cvTask(fwTask)).map(c=>({ label:c.label, hint:c.hint, go:()=>cvOpenType('documento', col, { ref:c.ref }) })).concat([{ label:'escolher depois', hint:'abre o painel com os documentos pra escolher', go:()=>cvOpenType('documento', col) }]), 'Documento');
    if(x.type==='demanda') return cvSubMenu(m, x.others.map(o=>({ label:o.title, hint:'lado a lado, pra comparar ou acompanhar', dot:cvTaskColor(o.id, fwTask), go:()=>cvOpenType('demanda', cvLayout().cols.length<CV_MAX_COLS?'new':col, { taskId:o.id }) })), 'Outra demanda');
    if(x.type==='site') return cvSiteAsk(m, col);
    cvCloseMenu(); cvOpenType(x.type, col);
  };
  m.querySelectorAll('[data-cvmi]').forEach(b=>b.onclick=()=>pick(items[+b.dataset.cvmi]));
  m.querySelectorAll('[data-cvpreset]').forEach(b=>b.onclick=()=>{ cvCloseMenu(); const p=b.dataset.cvpreset; if(p==='normal') cvReset(); else cvApplyPreset(p); });
  cvMenuKeys(m);
  const q=m.querySelector('.cvmq');
  if(q){ q.focus(); q.oninput=()=>{ const v=q.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); m.querySelectorAll('[data-cvmi]').forEach(b=>{ const x=items[+b.dataset.cvmi]; const hay=(x.label+' '+x.hint+' '+(x.others||[]).map(o=>o.title).join(' ')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); b.hidden=!!v && !hay.includes(v); }); };
    q.onkeydown=(e)=>{ if(e.key==='Enter'){ const b=[...m.querySelectorAll('[data-cvmi]')].find(x=>!x.hidden); if(b){ e.preventDefault(); b.click(); } } }; }
  else { const f=m.querySelector('[data-cvmi]'); if(f) f.focus(); }
}
function cvSubMenu(m, list, title){
  const l=m.querySelector('.cvml');
  l.innerHTML=`<div class="cvmsub"><button type="button" class="lnk" data-cvback="1">‹ voltar</button><b>${esc(title)}</b></div>`+(list.length?list.map((x,i)=>`<button type="button" class="cvmi" role="menuitem" data-cvsub="${i}"><span class="cvmic" aria-hidden="true">${x.dot?`<span class="cvtdot" style="background:${x.dot}"></span>`:'▤'}</span><span class="cvmt"><b>${esc(x.label)}</b><span>${esc(x.hint||'')}</span></span></button>`).join(''):'<div class="dim" style="padding:10px">nada por aqui ainda</div>');
  l.querySelector('[data-cvback]').onclick=()=>{ const a=$id('cvCanvas')&&document.querySelector('[data-cvplus]'); cvCloseMenu(); cvOpenMenu(a, undefined); };
  l.querySelectorAll('[data-cvsub]').forEach(b=>b.onclick=()=>{ const x=list[+b.dataset.cvsub]; cvCloseMenu(); x.go(); });
  const f=l.querySelector('[data-cvsub]'); if(f) f.focus();
}
// site: o endereço é pedido AQUI no menu — o painel nunca nasce vazio com um campo de endereço (veto da Carla)
function cvSiteAsk(m, col){
  const l=m.querySelector('.cvml');
  l.innerHTML=`<div class="cvmsub"><button type="button" class="lnk" data-cvback="1">‹ voltar</button><b>Site qualquer</b></div><form class="cvsiteask"><input class="in" name="u" placeholder="cole o endereço — ex.: youtube.com/watch?v=… ou docs.site.com" aria-label="endereço do site" autocomplete="off" spellcheck="false"><button class="btn primary sm">abrir</button></form><div class="dim cvmhint">Abre num painel separado, sem acesso ao Starfork. Se o site não deixar, aparece "abrir fora".</div>`;
  l.querySelector('[data-cvback]').onclick=()=>{ const a=document.querySelector('[data-cvplus]'); cvCloseMenu(); cvOpenMenu(a, col); };
  const f=l.querySelector('form'), i=f.querySelector('input'); i.focus();
  f.onsubmit=(e)=>{ e.preventDefault(); const s=cvSiteUrl(i.value); if(!s){ toast('só endereços http(s) — ex.: youtube.com/watch?v=…','warn'); return; } cvCloseMenu(); cvOpenType('site', col, { url:s.url }); };
}
function cvMenuKeys(m){
  m.addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); cvCloseMenu(); return; }
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
    const its=[...m.querySelectorAll('[role=menuitem]')].filter(b=>!b.hidden); if(!its.length) return;
    const cur=its.indexOf(document.activeElement);
    const nx=(typeof a11yMenuStep==='function')?a11yMenuStep(its.length, cur, e.key):(e.key==='ArrowUp'?(cur-1+its.length)%its.length:(cur+1)%its.length);
    if(nx>=0){ e.preventDefault(); its[nx].focus(); }
  });
}

// ---------- arrastar: aba → outra coluna (meio junta, borda divide); link/PDF de fora → painel ----------
let cvDragTab=null;
function cvColAt(root, x, y){ const cols=[...root.querySelectorAll('.cvcol')]; return cols.find(c=>{ const r=c.getBoundingClientRect(); return x>=r.left && x<=r.right && y>=r.top && y<=r.bottom; })||null; }
function cvShowDrop(col, zone){
  const root=$id('cvCanvas'); if(!root) return;
  root.querySelectorAll('.cvdrop').forEach(d=>{ if(!col || d.parentElement!==col){ d.hidden=true; d.className='cvdrop'; } });
  if(!col) return;
  const d=col.querySelector('.cvdrop'); d.hidden=false; d.className='cvdrop '+zone;
  d.innerHTML='<span>'+(zone==='left'?'solte pra abrir numa coluna à esquerda':zone==='right'?'solte pra abrir numa coluna à direita':zone==='center-full'?'máximo de 3 colunas — solte aqui pra juntar':'solte pra juntar nesta coluna')+'</span>';
}
function cvExternalDrop(dt){
  if(!dt) return false;
  const files=[...(dt.files||[])];
  if(files.length){ cvDropFiles(files); return true; }
  const raw=(dt.getData('text/uri-list')||dt.getData('text/plain')||'').split('\n').map(x=>x.trim()).find(x=>x && !x.startsWith('#'));
  if(raw){ const s=cvSiteUrl(raw); if(s){ cvOpenType('site', 'new', { url:s.url }); return true; } }
  return false;
}
async function cvDropFiles(files){
  const tid=fwTask; if(!tid) return;
  for(const f of files.slice(0,3)){
    if(f.size>25e6){ toast(`${f.name}: maior que 25 MB`,'warn'); continue; }
    try{ const b64=(typeof attFileToB64==='function')?await attFileToB64(f):null; if(!b64) continue;
      const a=await invoke('import_attachment_data',{ name:f.name, dataB64:b64, taskId:tid });
      cvOpenType('documento', 'new', { ref:'ref:'+(a&&a.rel||'.cardume/refs/'+f.name) });
      toast(`${f.name} virou anexo da demanda e abriu num painel`,'ok');
    }catch(e){ showErr(e, 'Não consegui abrir o arquivo'); }
  }
}
// ---------- fiação (uma vez por raiz) ----------
function cvWireOnce(root){
  if(root.__cvWired) return; root.__cvWired=1;
  root.addEventListener('click', (e)=>{
    const x=e.target.closest('[data-cvclose]'); if(x){ e.stopPropagation(); cvCloseTabId(x.dataset.cvclose); return; }
    const tb=e.target.closest('[data-cvtab]'); if(tb){ const l=cvLayout(); cvSet(cvActivate(l, tb.dataset.cvtab)); return; }
    const p=e.target.closest('[data-cvplus]'); if(p){ e.stopPropagation(); if(CV.menu){ cvCloseMenu(); return; } cvOpenMenu(p, +p.dataset.cvplus); return; }
  });
  // coluna em foco = onde você clicou (sem re-render: só a classe)
  root.addEventListener('mousedown', (e)=>{ const c=e.target.closest('.cvcol'); if(!c) return; const l=cvLayout(); const i=+c.dataset.col; if(l && (l.focus|0)!==i){ l.focus=i; cvSave(l); cvSyncMode(l); root.querySelectorAll('.cvcol').forEach(cc=>cc.classList.toggle('focus', +cc.dataset.col===i && l.cols.length>1)); } }, true);
  // abas pelo teclado (padrão tablist): ←/→ trocam, Delete fecha
  root.addEventListener('keydown', (e)=>{
    const tb=e.target.closest&&e.target.closest('[data-cvtab]'); if(!tb) return;
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); tb.click(); return; }
    if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); cvCloseTabId(tb.dataset.cvtab); return; }
    if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight') return;
    const sib=[...tb.parentElement.querySelectorAll('[data-cvtab]')]; const i=sib.indexOf(tb); const nx=sib[(i+(e.key==='ArrowRight'?1:-1)+sib.length)%sib.length];
    if(nx){ e.preventDefault(); const l=cvLayout(); cvSet(cvActivate(l, nx.dataset.cvtab)); setTimeout(()=>{ const f=document.querySelector(`[data-cvtab="${nx.dataset.cvtab}"]`); if(f) f.focus(); }, 0); }
  });
  root.addEventListener('dragstart', (e)=>{ const tb=e.target.closest&&e.target.closest('[data-cvtab]'); if(!tb) return; cvDragTab=tb.dataset.cvtab; try{ e.dataTransfer.setData('text/x-cvtab', cvDragTab); e.dataTransfer.effectAllowed='move'; }catch(_){ } root.classList.add('cvdragging'); });
  root.addEventListener('dragend', ()=>{ cvDragTab=null; root.classList.remove('cvdragging'); cvShowDrop(null); });
  root.addEventListener('dragover', (e)=>{
    const col=e.target.closest&&e.target.closest('.cvcol'); if(!col) return;
    const ext=!cvDragTab && e.dataTransfer && [...(e.dataTransfer.types||[])].some(t=>t==='Files'||t==='text/uri-list');
    if(!cvDragTab && !ext) return;
    e.preventDefault(); try{ e.dataTransfer.dropEffect=cvDragTab?'move':'copy'; }catch(_){ }
    const l=cvLayout(); cvShowDrop(col, cvDragTab?cvDropZone(col.getBoundingClientRect(), e.clientX, l.cols.length):'center');
  });
  root.addEventListener('dragleave', (e)=>{ if(!root.contains(e.relatedTarget)) cvShowDrop(null); });
  root.addEventListener('drop', (e)=>{
    const col=e.target.closest&&e.target.closest('.cvcol'); cvShowDrop(null); root.classList.remove('cvdragging');
    if(cvDragTab && col){ e.preventDefault(); const l=cvLayout(); const zone=cvDropZone(col.getBoundingClientRect(), e.clientX, l.cols.length); const id=cvDragTab; cvDragTab=null; cvSet(cvMoveTab(l, id, +col.dataset.col, zone==='center-full'?'center':zone)); return; }
    if(e.defaultPrevented) return; // o composer do chat já pegou (anexo da mensagem) — não abre painel junto
    if(cvExternalDrop(e.dataTransfer)) e.preventDefault();
  });
  // largura das colunas: arrastar o divisor (fração salva na demanda)
  root.addEventListener('pointerdown', (e)=>{
    const sp=e.target.closest&&e.target.closest('[data-cvsplit]'); if(!sp) return;
    e.preventDefault(); sp.setPointerCapture(e.pointerId); root.classList.add('cvdragging');
    const cols=[...root.querySelectorAll('.cvcol')]; const ws=cols.map(c=>c.getBoundingClientRect().width); const total=ws.reduce((a,b)=>a+b,0);
    const i=+sp.dataset.cvsplit, x0=e.clientX;
    const mv=(ev)=>{ const d=ev.clientX-x0; const a=Math.max(220, ws[i]+d), b=Math.max(220, ws[i+1]-(a-ws[i])); const a2=ws[i]+ws[i+1]-b; cols.forEach((c,k)=>{ const w=k===i?a2:k===i+1?b:ws[k]; c.style.flex=(w/total)+' 1 0'; }); };
    const up=()=>{ sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); root.classList.remove('cvdragging');
      const ws2=cols.map(c=>c.getBoundingClientRect().width), tt=ws2.reduce((a,b)=>a+b,0)||1; const l=cvLayout(); if(!l) return;
      const n=Object.assign({}, l, { w:cvWidths(ws2.map(w=>w/tt), ws2.length) }); cvSave(n); };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
  });
}
// atalhos (só com a demanda na tela): ⌘\ divide · ⌘1..3 foca a coluna (com 2+ colunas) · ⌘K painéis
document.addEventListener('keydown', (e)=>{
  if(!(e.metaKey||e.ctrlKey) || e.altKey || typeof fwVisible!=='function' || !fwVisible() || !fwTask) return;
  const l=cvLayout(); if(!l) return;
  if(e.key==='\\' && !e.shiftKey){ e.preventDefault(); e.stopPropagation();
    const n=cvSplit(l); if(n){ cvSet(n); return; }
    if(l.cols.length>=CV_MAX_COLS){ toast('já são 3 colunas — o máximo','info'); return; }
    const a=document.querySelector(`.cvcol[data-col="${l.focus|0}"] [data-cvplus]`); cvOpenMenu(a, 'new'); return; }
  if(/^[1-3]$/.test(e.key) && !e.shiftKey && l.cols.length>1 && +e.key<=l.cols.length){ e.preventDefault(); e.stopPropagation();
    const i=+e.key-1; l.focus=i; cvSave(l); cvSyncMode(l); const col=document.querySelector(`.cvcol[data-col="${i}"]`); if(col){ document.querySelectorAll('.cvcol').forEach(c=>c.classList.toggle('focus', c===col)); const f=col.querySelector('.cvtab.on'); if(f) f.focus(); } return; }
  if(String(e.key).toLowerCase()==='k' && !e.shiftKey){ e.preventDefault(); e.stopPropagation(); const a=document.querySelector(`.cvcol[data-col="${l.focus|0}"] [data-cvplus]`); cvOpenMenu(a, undefined, true); }
}, true);
// arrastar algo de FORA (Finder/navegador) por cima do app: iframes não roubam o arraste enquanto ele dura
document.addEventListener('dragenter', (e)=>{ const r=$id('cvCanvas'); if(r && e.dataTransfer && [...(e.dataTransfer.types||[])].some(t=>t==='Files'||t==='text/uri-list')) r.classList.add('cvdragging'); });
document.addEventListener('drop', ()=>{ const r=$id('cvCanvas'); if(r) r.classList.remove('cvdragging'); });
// detecção do ambiente chegou (58-ambiente): o layout automático se ajusta (sem página → Entrega/Documento)
function cvOnEnvPlan(taskId){ if(taskId===fwTask && typeof fwVisible==='function' && fwVisible()) renderWorkspace(); }
// barra do topo: presets e "voltar ao normal" (no lugar dos modos exclusivos)
function cvToolbarHtml(){ return `<span class="cvtool" role="group" aria-label="arrumar os painéis"><button type="button" class="fwmode" data-cvtool="construir" title="Meu app + Conversa">Construir</button><button type="button" class="fwmode" data-cvtool="revisar" title="Mudanças + Conversa">Revisar</button><button type="button" class="fwmode" data-cvtool="normal" title="volta os painéis desta demanda pro padrão">voltar ao normal</button></span>`; }
function cvWireToolbar(el){ el.querySelectorAll('[data-cvtool]').forEach(b=>b.onclick=()=>{ const k=b.dataset.cvtool; if(k==='normal') cvReset(); else cvApplyPreset(k); }); }

// ===== F3 — OUTRA DEMANDA lado a lado (comparar / acompanhar) =====
// Um painel de OUTRA demanda mostra o que importa pra comparar: requisitos ✓/✗ com as provas (prints), o que o agente
// disse por último e um campo que manda mensagem PRA ELA (nome + cor no campo: ninguém fala com o agente errado).
// Tudo por taskId explícito — nada aqui lê fwTask pra decidir de quem é o conteúdo. Teto: CV_MAX_TASKS (2 na v1).
// miniatura de prova (mesma regra da Entrega): sfart:// no app; fora dele lê uma vez e repinta ESTE painel
function cvThumb(taskId, name){
  if(typeof artFileUrlOk==='function' && artFileUrlOk()) return artMediaUrl(taskId, name);
  const k=taskId+'|'+name; if(artThumbCache[k]!==undefined) return artThumbCache[k];
  artThumbCache[k]=null;
  invoke('read_artifact',{ taskId, name }).then(c=>{ artThumbCache[k]=(c&&c.kind==='image'&&c.dataUrl)||null; cvRepaintTask(taskId); }).catch(()=>{});
  return null;
}
function cvRepaintTask(taskId){ const l=cvLayout(); if(!l) return; cvVisible(l).filter(x=>x.taskId===taskId && (x.type==='demanda')).forEach(tab=>{ const el=CV.panes[tab.id]; if(el && el.isConnected) cvDemandaRender(tab, el, cvTask(taskId)); }); if(taskId===fwTask && typeof cvReqOverlayPaint==='function') cvReqOverlayPaint(taskId); }
// linhas de requisito com o status e as provas (puro sobre o que já está no cache)
function cvReqRowsHtml(t, max){
  const rows=(typeof reqRows==='function')?reqRows(t):[];
  if(!rows.length) return '<div class="dim cvdemnone">sem requisitos nesta demanda</div>';
  return rows.slice(0, max||20).map((r,i)=>{
    const imgs=r.evidence.filter(e=>/\.(png|jpe?g|gif|webp)$/i.test(String(e))).slice(0,3).map(e=>{ const n=String(e).replace(/^(\.\/)?(\.cardume\/artifacts\/)?/,''); const u=cvThumb(t.id, n); return u?`<img class="cvth" src="${escA(u)}" alt="${escA('prova: '+n)}" loading="lazy" data-cvlb="${escA(n)}">`:`<span class="cvth ph" title="${escA(n)}">print</span>`; }).join('');
    const mk=r.st==='ok'?'<span class="reqst ok">✓</span>':r.st==='blk'?'<span class="reqst blk">✗</span>':'<span class="reqst na">·</span>';
    return `<div class="cvreq ${r.st}">${mk}<div class="cvreqt"><div><span class="cvreqn">${i+1}</span> ${esc(r.text)}</div>${imgs?`<div class="cvths">${imgs}</div>`:''}${r.st==='blk'&&r.note?`<div class="reqnote">${esc(r.note)}</div>`:''}</div></div>`; }).join('');
}
function cvDemSig(t){ const rp=(typeof reqProofCache!=='undefined')?reqProofCache[t.id]:null; const evs=(typeof eventsOf==='function')?eventsOf(t.id):[]; return [t.id,t.status,t.busy?1:0,t.title,evs.length,evs.length?evs[evs.length-1].id:0,(rp&&Array.isArray(rp.list))?rp.list.map(x=>x.status).join(','):'-',(typeof pendingOf==='function')?pendingOf(t.id).length:0].join('|'); }
function cvDemandaRender(tab, el, t){
  if(!t) return cvPaint(el, '<div class="cvempty"><b>Esta demanda não existe mais</b><span>Feche esta aba (×) ou escolha outra pelo +.</span></div>');
  if(typeof reqProofCache!=='undefined' && reqProofCache[t.id]===undefined && typeof loadReqProofs==='function') loadReqProofs(t.id).then(()=>cvRepaintTask(t.id));
  if(!el.querySelector('.cvdembody') || el.dataset.dem!==t.id){
    el.dataset.dem=t.id; el.__sig='';
    const col=cvTaskColor(t.id, fwTask);
    el.innerHTML=`<div class="cvdem" style="--tc:${col}"><div class="cvdembody"></div>
      <form class="cvdemsend" aria-label="${escA('mensagem pra demanda '+t.title)}"><div class="cvdemto"><span class="cvdot" style="background:${col}"></span>mensagem pra <b>${esc(t.title)}</b></div><div class="cvdemrow"><textarea class="in" rows="2" placeholder="peça um ajuste pro agente DESTA demanda…"></textarea><button class="btn primary sm">enviar</button></div></form></div>`;
    const f=el.querySelector('form'), ta=f.querySelector('textarea');
    f.onsubmit=async(e)=>{ e.preventDefault(); const v=ta.value.trim(); if(!v) return; const b=f.querySelector('button'); b.disabled=true; const ok=await fwSendText(t.id, v); b.disabled=false; if(ok){ ta.value=''; toast('enviado pra "'+t.title+'"','ok'); } };
    ta.onkeydown=(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); f.requestSubmit(); } };
    el.addEventListener('click', (e)=>{ const b=e.target.closest('[data-cvdem]'); if(b){ const k=b.dataset.cvdem; if(k==='app') cvOpenType('app', +((el.closest('.cvcol')||{}).dataset||{}).col||undefined, { taskId:t.id }); else if(k==='open') openWorkspace(t.id); return; }
      const im=e.target.closest('[data-cvlb]'); if(im && typeof lbOpen==='function'){ const names=[...el.querySelectorAll('[data-cvlb]')].map(x=>x.dataset.cvlb); lbOpen(t.id, names, names.indexOf(im.dataset.cvlb)); } });
  }
  const sig=cvDemSig(t)+'|'+Object.values(artThumbCache).filter(Boolean).length; // miniatura que chegou repinta
  if(el.__sig===sig) return; el.__sig=sig;
  const rows=(typeof reqRows==='function')?reqRows(t):[]; const ok=rows.filter(r=>r.st==='ok').length;
  const evs=((typeof eventsOf==='function')?eventsOf(t.id):[]).filter(e=>(typeof evIsUserMsg==='function'&&evIsUserMsg(e)) || ((e.type==='think'||e.type==='done') && String(e.text||'').trim())).slice(-4);
  const msgs=evs.map(e=>{ const you=(typeof evIsUserMsg==='function')&&evIsUserMsg(e); const tx=you&&typeof evUserText==='function'?evUserText(e.text):String(e.text||''); return `<div class="cvdemmsg${you?' you':''}"><b>${esc(you?'você':(e.agent||'agente'))}</b> ${(typeof chatMdEv==='function')?chatMdEv(e.id, tx.slice(0,600)):esc(tx.slice(0,600))}</div>`; }).join('');
  const ask=(typeof pendingOf==='function')?pendingOf(t.id):[];
  const st=(typeof stBadge==='function'&&typeof taskSt==='function')?stBadge(taskSt(t)):esc(t.status);
  const html=`<div class="cvdemh"><span class="cvdemst">${st}</span>${ask.length?'<span class="cvdemask">aguardando você</span>':''}<span style="flex:1"></span><button type="button" class="btn sm ghost" data-cvdem="app" title="abre o app desta demanda numa aba (conta no limite de 2 páginas vivas)">ver o app dela</button><button type="button" class="btn sm" data-cvdem="open">abrir a demanda</button></div>
    ${t.objective?`<p class="cvdemobj">${esc(String(t.objective).split('[PLANO DO ORQUESTRADOR')[0].trim().slice(0,240))}</p>`:''}
    <div class="seclbl2">Requisitos <span class="dim">${rows.length?ok+'/'+rows.length+' com prova':''}</span></div>${cvReqRowsHtml(t)}
    <div class="seclbl2" style="margin-top:12px">O que o agente disse por último</div>${msgs||'<div class="dim cvdemnone">nada ainda</div>'}`;
  const body=el.querySelector('.cvdembody'); if(body.__html!==html){ body.__html=html; body.innerHTML=html; }
}
// tique do refresh que JÁ existe (fwLiveUpdate, só com a demanda na tela): repinta painéis de outra demanda que
// mudaram (assinatura) — nada de timer próprio
function cvLiveTick(){
  const l=cvLayout(); if(!l) return;
  for(const tab of cvVisible(l)){ if(tab.type!=='demanda') continue; const el=CV.panes[tab.id]; const t=cvTask(tab.taskId); if(el && el.isConnected && t) cvDemandaRender(tab, el, t); }
  if(typeof cvReqOverlayTick==='function') cvReqOverlayTick();
}
