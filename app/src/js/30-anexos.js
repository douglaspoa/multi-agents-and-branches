// Constellation — 30-anexos
// ===== anexos IMPORTADOS (planner, chat do projeto e chat da tarefa) =====
// o arquivo é copiado pra dentro do projeto (import_attachment), o texto entra
// INTEIRO na mensagem e a imagem vira miniatura — antes só o caminho ia pro chat.
async function attPick(taskId){
  let paths=[]; try{ paths=await invoke('pick_ref_files'); }catch(e){ console.error('pick_ref_files',e); }
  const out=[];
  for(const p of (paths||[])){
    try{ out.push(await invoke('import_attachment',{ path:p, taskId:taskId||null })); }
    catch(e){ console.error('import_attachment',e); alert('Não consegui importar '+String(p).split('/').pop()+':\n'+e); }
  }
  return out;
}
function attFmtSize(n){ n=+n||0; return n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB'; }
function attChipHtml(a,i,removable){
  const thumb=(a.kind==='image'&&a.dataUrl)?`<img src="${a.dataUrl}" alt="">`:`<span class="attic">${a.kind==='pdf'?'PDF':a.kind==='image'?'IMG':a.kind==='text'?'TXT':'FILE'}</span>`;
  return `<span class="attchip ${esc(a.kind||'file')}" title="${escA(a.rel||a.name||'')}">${thumb}<span class="attnm">${esc(a.name||'')}</span><span class="attsz">${esc(a.sizeLabel||attFmtSize(a.size))}</span>${removable?`<button class="attx" data-attrm="${i}" title="remover">✕</button>`:''}</span>`;
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
    catch(e){ console.error('import_attachment_data',e); alert('Não consegui importar '+(f.name||'o conteúdo colado')+':\n'+e); }
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
  el.innerHTML = arr.length ? arr.map((p,i)=>{ const name=(p||'').split('/').pop(); return `<div class="refchip"><span class="refic">${refIcon(name)}</span><span class="refnm mono">${esc(name)}</span><button class="refrm" data-r="${i}" title="remover">×</button></div>`; }).join('') : `<div class="dim" style="font-size:12px;padding:2px">${emptyMsg}</div>`;
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
