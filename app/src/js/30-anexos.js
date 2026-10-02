// Starfork — 30-anexos
// ===== anexos IMPORTADOS (planner, chat do projeto e chat da tarefa) =====
// o arquivo é copiado pra dentro do projeto (import_attachment), o texto entra
// INTEIRO na mensagem e a imagem vira miniatura — antes só o caminho ia pro chat.
async function attPick(taskId){
  let paths=[]; try{ paths=await invoke('pick_ref_files'); }catch(e){ console.error('pick_ref_files',e); }
  const out=[];
  for(const p of (paths||[])){
    try{ out.push(await invoke('import_attachment',{ path:p, taskId:taskId||null })); }
    catch(e){ console.error('import_attachment',e); showErr(e, 'Não consegui importar '+pathBase(p)); }
  }
  return out;
}
function attFmtSize(n){ n=+n||0; return n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB'; }
function attChipHtml(a,i,removable){
  const thumb=(a.kind==='image'&&a.dataUrl)?`<img src="${a.dataUrl}" alt="">`:`<span class="attic">${a.kind==='pdf'?'PDF':a.kind==='image'?'IMG':a.kind==='text'?'TXT':'FILE'}</span>`;
  return `<span class="attchip ${esc(a.kind||'file')}" title="${escA(a.rel||a.name||'')}">${thumb}<span class="attnm">${esc(a.name||'')}</span><span class="attsz">${esc(a.sizeLabel||attFmtSize(a.size))}</span>${removable?`<button class="attx" data-attrm="${i}" title="remover">${IC.x}</button>`:''}</span>`;
}
function attRowHtml(atts,removable){ return (atts&&atts.length)?`<div class="attrow">${atts.map((a,i)=>attChipHtml(a,i,removable)).join('')}</div>`:''; }
function attRenderPend(id, arr, rerender){
  const el=$id(id); if(!el) return;
  el.innerHTML=arr.map((a,i)=>attChipHtml(a,i,true)).join(''); el.style.display=arr.length?'flex':'none';
  el.querySelectorAll('[data-attrm]').forEach(b=>b.onclick=()=>{ arr.splice(+b.dataset.attrm,1); rerender(); });
}
function attLite(atts){ return (atts||[]).map(a=>({ name:a.name, kind:a.kind, size:a.size, rel:a.rel })); } // sem dataUrl/texto (persistência)
// bloco que VAI pro modelo: texto integral inline; imagem/PDF pelo caminho dentro do projeto
function attPromptBlock(atts){
  if(!atts||!atts.length) return '';
  return '\n\n[ANEXOS]\n'+atts.map((a,i)=>{
    const h=`${i+1}. ${a.name} (${a.kind}, ${attFmtSize(a.size)}) — ${a.rel}`;
    if(a.kind==='text'&&a.text!=null) return h+(a.truncated?' — TRUNCADO nos primeiros 60k caracteres':'')+' — conteúdo integral:\n<<<\n'+a.text+'\n>>>';
    if(a.kind==='image') return h+' — imagem: abra com a ferramenta Read pra VER o print.';
    if(a.kind==='pdf') return h+' — PDF: abra com a ferramenta Read pra ler.';
    return h;
  }).join('\n')+'\n[/ANEXOS]';
}
// ===== COMPOSER de chat ÚNICO — anexar (botão), colar (⌘V de print/arquivo) e arrastar, igual nos 3 chats =====
function attFileToB64(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(',')[1]||''); r.onerror=rej; r.readAsDataURL(file); }); }
function attPastedName(f){
  if(f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f.name; // "image.png" é o nome genérico do clipboard
  const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const ext=f.type==='image/jpeg'?'.jpg':f.type==='image/gif'?'.gif':f.type==='image/webp'?'.webp':f.type==='application/pdf'?'.pdf':f.type==='text/plain'?'.txt':'.png';
  return 'print-'+ts+ext;
}
async function attImportFiles(files, taskId){
  const out=[];
  for(const f of files){
    try{ const b64=await attFileToB64(f); out.push(await invoke('import_attachment_data',{ name:attPastedName(f), dataB64:b64, taskId:taskId||null })); }
    catch(e){ console.error('import_attachment_data',e); showErr(e, 'Não consegui importar '+(f.name||'o conteúdo colado')); }
  }
  return out;
}
// cfg: { input, attach (ids), pend: ()=>array pendente, taskId: ()=>id|null, rerender: fn, afterAdd?: fn(atts) }
// idempotente (usa on* em vez de addEventListener) — pode ser chamado a cada render
function attWireComposer(cfg){
  const input=$id(cfg.input), btn=$id(cfg.attach);
  const add=async(atts)=>{ atts=(atts||[]).filter(Boolean); if(!atts.length) return; cfg.pend().push(...atts); if(cfg.afterAdd) cfg.afterAdd(atts); cfg.rerender(); const i=$id(cfg.input); if(i) i.focus(); };
  if(btn) btn.onclick=async()=>add(await attPick(cfg.taskId()));
  if(!input) return;
  input.onpaste=async(e)=>{ const files=[...((e.clipboardData&&e.clipboardData.files)||[])]; if(!files.length) return; e.preventDefault(); add(await attImportFiles(files, cfg.taskId())); };
  input.ondragover=(e)=>{ e.preventDefault(); input.classList.add('dropping'); };
  input.ondragleave=()=>input.classList.remove('dropping');
  input.ondrop=async(e)=>{ e.preventDefault(); input.classList.remove('dropping'); const files=[...((e.dataTransfer&&e.dataTransfer.files)||[])]; if(files.length) add(await attImportFiles(files, cfg.taskId())); };
}
// ===== CHAT ÚNICO: o mesmo composer + a mesma bolha em todos os chats (planner, projeto, issues, orquestrador) =====
// Layout ÚNICO = o do chat da tarefa (20-workspace): caixa de texto em cima; embaixo UMA linha com
// clipe · (extras da tela) · espaço · [■ parar] [enviar]; e a dica com as teclas em <span class="kbd">.
// Quem monta o HTML usa chatComposerHtml(); marcação antiga (.plinput/.chatinput/.orq-chatin) é
// normalizada por chatComposer() — então qualquer tela que chame chatComposer fica igual.
const CHAT_HINT='Enter envia · ⇧Enter quebra linha · ⌘V ou arraste pra anexar';
const CHAT_CLIP_SVG='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 3.5L5 8a2 2 0 0 0 2.8 2.8l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// ---- pílula da IA/modelo no composer (igual ChatGPT/Claude): fica logo depois do clipe, embaixo da caixa ----
// p: { id, label (ex.: aiRunLabel(eng, model) → "Codex · GPT-5"), title?, popup? ('menu' padrão | '' = não abre menu, leva a outra tela), onPick(anchor) }
// Uma tela entra com cfg.modelPill no chatComposer (ou o.modelPill no chatComposerHtml); quem monta a própria
// linha (chat da tarefa) usa chatModelPillHtml + chatModelPillWire. O clique NUNCA decide nada: só chama onPick.
const CHAT_MODEL_TIP='trocar a IA/modelo — vale a partir da próxima mensagem';
const CHAT_MODEL_CHEV='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.5 6.3 8 9.8l3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// aspas escapadas sem depender do escA (33-switcher): o planner monta o composer já na carga, antes dele existir
const ccAttr=s=>esc(s).replace(/"/g,'&quot;');
function chatModelPillHtml(p){
  if(!p || !p.id) return '';
  const tip=p.title||CHAT_MODEL_TIP, lbl=String(p.label||'');
  return `<button type="button" class="cc-model" id="${ccAttr(p.id)}"${p.popup===''?'':` aria-haspopup="${ccAttr(p.popup||'menu')}" aria-expanded="false"`} aria-label="${ccAttr('IA: '+lbl+' — '+tip)}" title="${ccAttr(tip)}"${p.disabled?' disabled':''}><span class="cc-model-t">${esc(lbl)}</span>${CHAT_MODEL_CHEV}</button>`;
}
function chatModelPillWire(p){
  const b=p&&$id(p.id); if(!b) return null;
  b.onclick=(e)=>{ e.preventDefault(); if(b.disabled) return; p.onPick(b); };
  return b;
}
// o: { input, attach, send, stop (ids) · placeholder · value · modelPill (pílula da IA, ver chatModelPillHtml)
//      · extras (HTML logo depois do clipe/pílula) · right (HTML antes do parar/enviar)
//      · sendHtml (rótulo do enviar) · rows · cls (classe extra no contêiner) · attachTitle · stopTitle · disabled }
function chatComposerHtml(o){
  const dis=o.disabled?' disabled':'';
  return `<div class="cc${o.cls?' '+o.cls:''}"><textarea class="in cc-ta" id="${o.input}" rows="${o.rows||2}" placeholder="${escA(o.placeholder||'')}"${dis}>${esc(o.value||'')}</textarea>`+
    `<div class="cc-row">${o.attach?`<button class="btn sm cc-clip" id="${o.attach}" title="${escA(o.attachTitle||'anexar print, PDF ou doc — ou cole (⌘V) / arraste')}"${dis}>${CHAT_CLIP_SVG}</button>`:''}${chatModelPillHtml(o.modelPill)}${o.extras||''}<span class="cc-sp"></span>${o.right||''}`+
    `${o.stop?`<button class="btn sm trk-stop" id="${o.stop}" style="display:none" title="${escA(o.stopTitle||'interrompe a IA agora')}">${IC.stop} parar</button>`:''}`+
    `${o.send?`<button class="btn primary sm cc-send" id="${o.send}"${dis}>${o.sendHtml||'enviar'}</button>`:''}</div></div>`;
}
// marcação antiga (botões soltos ao lado da caixa) → layout único. Idempotente; roda a cada render.
function chatNormalize(input){
  const done=input.closest('.cc'); if(done) return done;
  const box=input.closest('.plinput,.chatinput,.orq-chatin'); if(!box) return input.parentNode;
  box.classList.add('cc'); input.classList.add('in','cc-ta');
  const kids=[...box.children].filter(k=>k!==input && !k.classList.contains('atmenu') && !k.classList.contains('chathint'));
  const isEnd=k=>k.tagName==='BUTTON' && (k.classList.contains('primary')||k.classList.contains('trk-stop')||/Send$|Stop$/.test(k.id||''));
  const row=document.createElement('div'); row.className='cc-row';
  const clip=kids.find(k=>/Att(ach)?$/.test(k.id||''));
  const asBtn=k=>{ if(k.tagName==='BUTTON'){ k.classList.remove('as-btn','orq-attbtn','big'); k.classList.add('btn','sm'); } };
  if(clip){ asBtn(clip); clip.classList.add('cc-clip'); row.appendChild(clip); }
  kids.filter(k=>k!==clip && !isEnd(k)).forEach(k=>row.appendChild(k));
  const sp=document.createElement('span'); sp.className='cc-sp'; row.appendChild(sp);
  kids.filter(isEnd).forEach(k=>{ asBtn(k); row.appendChild(k); });
  box.insertBefore(row, input.nextSibling);
  return box;
}
function chatGrow(el){ if(!el||!el.offsetParent) return; el.style.height='auto'; const h=Math.min(el.scrollHeight+2,160); el.style.height=h+'px'; el.style.overflowY=el.scrollHeight>160?'auto':'hidden'; }
{ let t=null; window.addEventListener('resize',()=>{ clearTimeout(t); t=setTimeout(()=>document.querySelectorAll('textarea[data-chat-grow]').forEach(chatGrow),120); }); }
// teclas da dica viram <span class="kbd"> (igual ao chat da tarefa)
function chatKbd(text){ return esc(String(text||'')).replace(/Shift\+Enter/g,'⇧Enter').replace(/(⇧Enter|⌘Enter|⌘V|Enter|Esc)/g,'<span class="kbd">$1</span>'); }
// linha de dica DENTRO do composer, abaixo dos botões (mesmo texto em todos); `busyHint` troca o texto enquanto a IA responde
function chatHintLine(box, text, busy){
  if(!box) return;
  let h=[...box.children].find(x=>x.classList.contains('chathint'));
  if(!h){ h=document.createElement('div'); h.className='chathint'; box.appendChild(h); }
  const html=chatKbd(text); if(h.innerHTML!==html) h.innerHTML=html; h.classList.toggle('busy', !!busy);
}
// garante a pílula na linha do composer (marcação antiga/estática não a tem): logo depois do clipe; rótulo sempre atual
function chatModelPillEnsure(box, p){
  if(!box || !p || !p.id) return null;
  const row=[...box.children].find(x=>x.classList && x.classList.contains('cc-row')); if(!row) return null;
  let b=$id(p.id);
  if(!b){ const tmp=document.createElement('div'); tmp.innerHTML=chatModelPillHtml(p); b=tmp.firstElementChild;
    const clip=row.querySelector('.cc-clip'); if(clip && clip.parentNode===row) clip.after(b); else row.insertBefore(b, row.firstChild); }
  else { const t=b.querySelector('.cc-model-t'), lbl=String(p.label||''); if(t && t.textContent!==lbl) t.textContent=lbl; b.setAttribute('aria-label', 'IA: '+lbl+' — '+(p.title||CHAT_MODEL_TIP)); }
  return chatModelPillWire(p);
}
// cfg: { input, attach, pend, taskId, rerender, afterAdd?, onSend, onKey?, stop?:{btn, busy:()=>bool, fn}, send?, busyHint?, hint?,
//        modelPill?:{ id, label, title?, popup?, onPick(anchor) } — a IA/modelo deste chat, embaixo da caixa (opcional) }
// Idempotente (on* handlers + flag no elemento): pode ser chamado a cada render.
// onKey(e) roda ANTES do Enter; devolver true (ou dar preventDefault) cancela o envio.
function chatComposer(cfg){
  attWireComposer(cfg);
  const input=$id(cfg.input); if(!input) return;
  const box=chatNormalize(input);
  if(cfg.modelPill) chatModelPillEnsure(box, cfg.modelPill);
  input.onkeydown=(e)=>{
    if(cfg.onKey && cfg.onKey(e)===true) return;
    if(e.defaultPrevented) return;
    if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); cfg.onSend(); setTimeout(()=>chatGrow($id(cfg.input)),0); }
  };
  if(!input.dataset.chatGrow){ input.dataset.chatGrow='1'; input.addEventListener('input',()=>chatGrow(input)); }
  chatGrow(input);
  const busy=!!(cfg.stop&&cfg.stop.busy&&cfg.stop.busy());
  if(cfg.stop){ const b=$id(cfg.stop.btn); if(b){ b.onclick=cfg.stop.fn; b.style.display=busy?'':'none'; } }
  if(cfg.send){ const s=$id(cfg.send); if(s){ s.disabled=busy && !cfg.sendWhileBusy; s.title=(busy&&!cfg.sendWhileBusy)?'espere a resposta — ou ■ parar':''; } }
  chatHintLine(box, busy&&cfg.busyHint?cfg.busyHint:(cfg.hint||CHAT_HINT), busy);
}
// ---- bolha única: você / IA (símbolo da marca + markdown + copiar) / aviso do sistema ----
function chatCopyBtn(){ return '<button class="ccopy" title="copiar">⧉</button>'; }
function chatMsgHtml(m){
  const w=m.who||m.role, t=String(m.text||'');
  if(w==='you'||w==='user') return `<div class="plmsg you chatmsg"><div class="plbub">${esc(t)}${attRowHtml(m.atts)}</div></div>`;
  if(w==='sys') return `<div class="plmsg sys chatmsg"><div class="plbub">${esc(t)}</div></div>`;
  return `<div class="plmsg bot chatmsg"><span class="plav">${IC.starfork}</span><div class="plbub">${mdToHtml(t)}${chatCopyBtn()}</div></div>`;
}
function chatThinkHtml(inner){ return `<div class="plmsg bot chatmsg"><span class="plav">${IC.starfork}</span><div class="plbub think">${inner||'<span class="pltyping"><i></i><i></i><i></i></span>'}</div></div>`; }
document.addEventListener('click', e=>{
  const cp=e.target.closest&&e.target.closest('.chatmsg .ccopy'); if(!cp) return;
  const cl=cp.parentElement.cloneNode(true); cl.querySelectorAll('.ccopy').forEach(x=>x.remove());
  try{ navigator.clipboard.writeText(cl.innerText.trim()); cp.textContent='✓'; setTimeout(()=>{ cp.textContent='⧉'; },900); }catch(_){ }
});
// ---- rolagem: só gruda no fim se você JÁ estava no fim (ler lá em cima não é mais interrompido) ----
// uso: const keep=stickBottom($id('x')); …re-render…; keep($id('x'))  (o elemento pode ter sido recriado)
const chatPinned=new Set(); // ids que DEVEM ir pro fim no próximo render (você acabou de enviar)
function chatPinBottom(id){ chatPinned.add(id); }
function stickBottom(el){
  const was=el?{ bottom:el.scrollHeight-el.scrollTop-el.clientHeight<48, top:el.scrollTop, id:el.id }:null;
  return (el2)=>{ el2=el2||el; if(!el2) return;
    const pin=el2.id&&chatPinned.delete(el2.id);
    el2.scrollTop=(!was||was.bottom||pin)?el2.scrollHeight:was.top; };
}
// campos de texto que não são chat (objetivo da Nova demanda): colar/arrastar um print vira anexo (path na lista de refs)
function attWireRefField(id, arr, render){
  attWireComposer({ input:id, attach:null, pend:()=>[], taskId:()=>null, rerender:()=>{},
    afterAdd:atts=>{ const a=arr(); atts.forEach(x=>{ if(x&&x.path&&!a.includes(x.path)) a.push(x.path); }); render(); toast(atts.length===1?'anexado: '+atts[0].name:atts.length+' anexos adicionados'); } });
}
// mensagem EXIBIDA: o bloco vira chips (o texto integral do anexo não polui a conversa)
function attSplit(text){
  const src=String(text||''); const m=src.match(/\n*\[ANEXOS\]\n([\s\S]*?)\n\[\/ANEXOS\]/);
  if(!m) return { text:src, atts:[] };
  const atts=[];
  m[1].split('\n').forEach(l=>{ const mm=l.match(/^\d+\. (.+?) \((image|pdf|text|file), ([^)]+)\) — (\S+)/); if(mm) atts.push({ name:mm[1], kind:mm[2], sizeLabel:mm[3], rel:mm[4] }); });
  return { text:src.replace(m[0],'').trim(), atts };
}
function refIcon(name){ return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name||'')?IC.image:IC.doc; }
// lista de anexos genérica: prints/PDFs/docs em qualquer modo da Nova tarefa
function renderRefsInto(elId, arr, emptyMsg){
  const el=$id(elId); if(!el) return;
  el.innerHTML = arr.length ? arr.map((p,i)=>{ const name=pathBase(p); return `<div class="refchip"><span class="refic">${refIcon(name)}</span><span class="refnm mono">${esc(name)}</span><button class="refrm" data-r="${i}" title="remover">${IC.x}</button></div>`; }).join('') : `<div class="dim" style="font-size:var(--fs-sm);padding:2px">${emptyMsg}</div>`;
  el.querySelectorAll('.refrm').forEach(b=>b.onclick=()=>{ arr.splice(+b.dataset.r,1); renderRefsInto(elId, arr, emptyMsg); });
}
function renderNtRefs(){ renderRefsInto('ntRefs', ntRefs, 'nenhum — anexe specs, PDFs ou um print do bug'); }
function renderDzRefs(){ renderRefsInto('ntDzRefs', ntDzRefs, 'nenhum — anexe prints da tela atual, rascunhos, referências visuais'); }
function renderFixRefs(){ renderRefsInto('ntFixRefs', ntFixRefs, 'nenhum — anexe o print do bug pra mostrar exatamente onde acontece'); }
function renderInvRefs(){ renderRefsInto('ntInvRefs', ntInvRefs, 'nenhum — anexe o print do erro, log ou gráfico onde o problema aparece'); }
async function pickRefsInto(arr, render){ try{ const paths=await invoke('pick_ref_files'); if(paths&&paths.length){ arr.push(...paths); render(); } }catch(e){ console.error('pick_ref_files',e); } }
async function pickRefs(){ await pickRefsInto(ntRefs, renderNtRefs); }
function renderNtList(id, arr){
  const el=$id(id);
  el.innerHTML = arr.length ? arr.map((v,i)=>`<div class="listrow"><input class="in" data-li="${i}" value="${escA(v)}" placeholder="descreva…"><button class="iconbtn" data-lrm="${i}" title="remover">${IC.trash}</button></div>`).join("") : '<div class="dim">nenhum item — clique "+ item"</div>';
  el.querySelectorAll("[data-li]").forEach(inp=>inp.addEventListener("input",()=>{ arr[+inp.dataset.li]=inp.value; ntGate(); }));
  el.querySelectorAll("[data-lrm]").forEach(b=>b.onclick=()=>{ arr.splice(+b.dataset.lrm,1); renderNtList(id,arr); ntGate(); });
  if(typeof ntGate==='function') ntGate();
}
