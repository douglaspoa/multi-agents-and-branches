// Starfork — 19-canvas-puro
// ===== CANVAS NO TOPO (spec-canvas-workspace, pivot 02/10) — funções PURAS =====
// Nada aqui toca DOM, Tauri ou globais do app: testado em app/tests/canvas.test.mjs (recorta entre os marcadores).
//  - GERENTE DE RECURSOS (F0): um lugar só conta o que é caro e vivo (iframes de páginas e o stream do dispositivo) e
//    aplica o teto (≤ 2 páginas e ≤ 1 stream no app inteiro — inclusive dentro dos painéis divididos). LRU congela.
//  - ESTADO POR PAINEL (F0): cada painel carrega o próprio taskId; nada de "a demanda" global decidindo o conteúdo.
//  - TELA DIVIDIDA (pivot): a barra de abas DE CIMA é o canvas. Até 3 abas lado a lado (demanda, navegador, simulador,
//    documento), cada uma do jeito que ela é sozinha. Sem split recursivo. JSON versionado; inválido → sem divisão.

// @canvas-puro-inicio
// v2 (03/10): a divisão virou GRUPO DE ABAS na barra de cima (estilo Chrome). v1 continua carregando igual.
const CV_VER=2, CV_VER_OK=[1,2], CV_MAX_PANES=3;
const CV_CAPS={ web:2, stream:1 };
// o que pode ir pra tela dividida (as outras abas — Central, Skills… — continuam abrindo sozinhas)
const CV_SPLIT_KINDS=['task','web','device','doc'];
// ---------- gerente de recursos (LRU com teto) ----------
function cvRmNew(caps){ return { caps:Object.assign({}, CV_CAPS, caps||{}), live:{ web:[], stream:[] } }; }
// pede (ou reafirma) o recurso `key` do tipo `kind`; vira o MAIS recente. Devolve as chaves despejadas (congelar).
function cvRmAcquire(rm, kind, key){
  const list=rm.live[kind]||(rm.live[kind]=[]); const cap=rm.caps[kind]==null?Infinity:rm.caps[kind];
  const i=list.indexOf(key); if(i>=0) list.splice(i,1);
  list.push(key);
  const evicted=[]; while(list.length>cap) evicted.push(list.shift());
  return evicted;
}
function cvRmRelease(rm, kind, key){ const list=rm.live[kind]||[]; const i=list.indexOf(key); if(i>=0){ list.splice(i,1); return true; } return false; }
function cvRmIsLive(rm, kind, key){ return (rm.live[kind]||[]).includes(key); }
function cvRmCount(rm, kind){ return (rm.live[kind]||[]).length; }

// ---------- site externo (sem proxy, sem mira, sem ponte) ----------
// hosts que mandam X-Frame-Options/CSP frame-ancestors: abrem direto no cartão "abrir fora"
const CV_BLOCKED=/(^|\.)(google\.[a-z.]+|github\.com|x\.com|twitter\.com|instagram\.com|facebook\.com|linkedin\.com|whatsapp\.com|web\.whatsapp\.com|notion\.so|figma\.com|chatgpt\.com|claude\.ai|accounts\.[a-z.]+|stackoverflow\.com|amazon\.[a-z.]+|mail\.google\.com)$/i;
function cvSiteUrl(raw){
  let s=String(raw||'').trim(); if(!s) return null;
  if(!/^[a-z][a-z0-9+.-]*:/i.test(s)) s='https://'+s;
  let u; try{ u=new URL(s); }catch(_){ return null; }
  if(!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return null;
  const host=u.hostname.replace(/^www\./,'').toLowerCase();
  // YouTube: o "watch" recusa iframe — o /embed/ é feito pra isso (nocookie: sem rastreio de terceiros)
  let yt=null;
  if(/(^|\.)youtube\.com$/.test(host)){ yt=u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/)||[])[1] || null; }
  else if(host==='youtu.be'){ yt=(u.pathname.match(/^\/([\w-]{6,})/)||[])[1]||null; }
  if(yt && /^[\w-]{6,20}$/.test(yt)){ const t=parseInt(u.searchParams.get('t')||'',10); return { url:u.href, embed:'https://www.youtube-nocookie.com/embed/'+yt+(t>0?'?start='+t:''), blocked:false, host:'youtube.com', video:true, vid:yt }; }
  return { url:u.href, embed:u.href, blocked:CV_BLOCKED.test(host), host };
}

// cor estável por demanda (nome+cor em cada painel: ninguém manda mensagem pra demanda errada)
function cvTaskHue(id){ let h=2166136261; const s=String(id||''); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } h^=h>>>15; h=Math.imul(h,0x2c1b3c6d); h^=h>>>12; h=Math.imul(h,0x297a2d39); h^=h>>>15; return Math.floor((((h>>>0)*0.6180339887)%1)*360); }
// a cor de uma demanda NA TELA da casa: se ficar parecida com a da casa (< 50°), gira pro lado oposto do círculo —
// duas demandas lado a lado nunca têm a mesma cor
function cvTaskColor(id, homeId){ let h=cvTaskHue(id); if(homeId && id!==homeId){ const hh=cvTaskHue(homeId); const d=Math.abs(h-hh); if(Math.min(d, 360-d)<50) h=(hh+180)%360; } return 'hsl('+h+' 72% 62%)'; }

// ---------- tela dividida ----------
// aba (do topo) → descritor salvável (sem id de sessão): o que reabrir pra montar a divisão de novo
function cvTabDesc(tab){
  if(!tab || !CV_SPLIT_KINDS.includes(tab.kind)) return null;
  const d={ kind:tab.kind };
  if(tab.taskId) d.taskId=String(tab.taskId);
  if(tab.url) d.url=String(tab.url);
  if(tab.ref) d.ref=String(tab.ref);
  if(tab.app) d.app=true;
  return d;
}
// id estável da aba pelo conteúdo (abrir o mesmo site/documento de novo = a mesma aba)
function cvHash(s){ let h=2166136261; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36); }
function cvTabIdOf(d){ if(!d) return null; if(d.kind==='task') return 'task:'+d.taskId; return d.kind+':'+cvHash([d.taskId||'', d.url||'', d.ref||'', d.app?1:0].join('|')); }
// descritor que veio do disco/rede → descritor são ou null
function cvDescValid(d, taskIds){
  if(!d || typeof d!=='object' || !CV_SPLIT_KINDS.includes(d.kind)) return null;
  const known=new Set(taskIds||[]);
  const o={ kind:d.kind };
  if(d.taskId!=null){ if(!known.has(String(d.taskId))) return null; o.taskId=String(d.taskId); }
  if(d.kind==='task' && !o.taskId) return null;
  if(d.kind==='device' && !o.taskId) return null;
  if(d.kind==='doc'){ if(!o.taskId) return null; if(d.ref!=null){ const r=String(d.ref); if(!/^(art|file|ref):[^\0]{1,300}$/.test(r) || /(^|\/)\.\.(\/|$)/.test(r.slice(4))) return null; o.ref=r; } }
  if(d.kind==='web'){ if(d.app){ if(!o.taskId) return null; o.app=true; } else { const s=cvSiteUrl(d.url); if(!s) return null; o.url=s.url; } }
  return o;
}
// divisão salva → { v, panes:[descritor], w:[frações]|undefined, focus } ou null (versão estranha, lixo, menos de 2)
function cvSplitValid(raw, taskIds){
  let l=raw; if(typeof l==='string'){ try{ l=JSON.parse(l); }catch(_){ return null; } }
  if(!l || typeof l!=='object' || !CV_VER_OK.includes(l.v) || !Array.isArray(l.panes)) return null;
  const seen=new Set(), panes=[];
  for(const d0 of l.panes){ const d=cvDescValid(d0, taskIds); if(!d) continue; const id=cvTabIdOf(d); if(seen.has(id)) continue; seen.add(id); panes.push(d); if(panes.length>=CV_MAX_PANES) break; }
  if(panes.length<2) return null;
  const out={ v:CV_VER, group:true, panes, focus:Math.min(panes.length-1, Math.max(0, +l.focus|0)) };
  if(Array.isArray(l.w) && l.w.length===panes.length){ const w=l.w.map(Number); if(w.every(x=>x>=0.12 && x<=0.88) && Math.abs(w.reduce((a,b)=>a+b,0)-1)<0.02) out.w=w.map(x=>Math.round(x*1000)/1000); }
  // layout A (03/10): layout do grupo + tamanhos POR layout (lado a lado usa `w`, empilhado `h`, grade [coluna, linha])
  if(CV_LAYS.includes(l.lay)) out.lay=l.lay;
  if(Array.isArray(l.h) && l.h.length===panes.length){ const h=l.h.map(Number); if(h.every(x=>x>=0.12 && x<=0.88) && Math.abs(h.reduce((a,b)=>a+b,0)-1)<0.02) out.h=h.map(x=>Math.round(x*1000)/1000); }
  if(Array.isArray(l.g) && l.g.length===2){ const g=l.g.map(Number); if(g.every(x=>x>=0.25 && x<=0.75)) out.g=g.map(x=>Math.round(x*1000)/1000); }
  return out;
}
// ---------- layout do grupo: lado a lado · empilhado · grade (foco grande à esquerda + 2 empilhadas) ----------
const CV_LAYS=['side','stack','grid'];
const CV_GUTTER=6; // px da divisória arrastável (trilho da grade)
// layout efetivo: grade só existe com 3; com 2 a grade vira lado a lado
function cvLayEff(n, lay){ return lay==='stack'?'stack':(lay==='grid' && n>=3)?'grid':'side'; }
// fração por painel (lista salva válida ou partes iguais)
function cvFracs(n, l){ return (Array.isArray(l) && l.length===n) ? l.slice() : Array.from({ length:n }, ()=>1/n); }
/**
 * Monta a GRADE CSS do grupo (sem mover os iframes no DOM — mover um iframe recarrega a demanda):
 * { cols, rows, panes:[gridArea por índice], splits:[{ area, dir:'v'|'h', k }] }. dir 'v' arrasta na horizontal.
 * Grade: o painel em FOCO vai pro lugar grande; os outros dois empilham à direita, na ordem do grupo.
 */
function cvLayout(n, lay, focus, sz){
  sz=sz||{}; const L=cvLayEff(n, lay), G=CV_GUTTER+'px';
  if(n<2) return { lay:L, cols:'minmax(0,1fr)', rows:'minmax(0,1fr)', panes:['1 / 1 / 2 / 2'], splits:[] };
  const tracks=(f)=>f.map(x=>'minmax(0,'+(+x).toFixed(3)+'fr)').join(' '+G+' ');
  if(L==='grid'){
    const c=(sz.g&&sz.g[0])||0.56, r=(sz.g&&sz.g[1])||0.5; const f=Math.max(0, Math.min(n-1, focus|0));
    const rest=[]; for(let i=0;i<n;i++) if(i!==f) rest.push(i);
    const panes=[]; panes[f]='1 / 1 / 4 / 2'; panes[rest[0]]='1 / 3 / 2 / 4'; panes[rest[1]]='3 / 3 / 4 / 4';
    return { lay:L, cols:tracks([c,1-c]), rows:tracks([r,1-r]), panes, splits:[{ area:'1 / 2 / 4 / 3', dir:'v', k:0 }, { area:'2 / 3 / 3 / 4', dir:'h', k:1 }] };
  }
  const f=cvFracs(n, L==='stack'?sz.h:sz.w);
  const panes=[], splits=[];
  for(let i=0;i<n;i++){ panes.push(L==='stack'?`${2*i+1} / 1 / ${2*i+2} / 2`:`1 / ${2*i+1} / 2 / ${2*i+2}`); if(i) splits.push({ area:L==='stack'?`${2*i} / 1 / ${2*i+1} / 2`:`1 / ${2*i} / 2 / ${2*i+1}`, dir:L==='stack'?'h':'v', k:i-1 }); }
  return L==='stack' ? { lay:L, cols:'minmax(0,1fr)', rows:tracks(f), panes, splits } : { lay:L, cols:tracks(f), rows:'minmax(0,1fr)', panes, splits };
}
/**
 * Arrastar a divisória `k` (puro): sizes = medidas atuais (px) dos painéis no eixo; d = deslocamento em px.
 * Devolve as frações novas (soma 1), nenhum painel menor que `min` px.
 */
function cvDragFracs(sizes, k, d, min){
  const s=sizes.slice(); const tot=s.reduce((a,b)=>a+b,0)||1;
  // mínimo: o pedido, mas nunca abaixo do que o grupo salvo aceita (12%) nem acima do que cabe nos dois painéis
  const m=Math.min(Math.max(min||200, tot*0.12), (s[k]+s[k+1])/2);
  const a=Math.max(m, Math.min(s[k]+s[k+1]-m, s[k]+d)); const b=s[k]+s[k+1]-a; s[k]=a; s[k+1]=b;
  return s.map(x=>Math.round(x/tot*1000)/1000);
}
// grade: posição do ponteiro → fração (25%–75%)
function cvGridFrac(pos, start, len){ return Math.round(Math.max(0.25, Math.min(0.75, (pos-start)/(len||1)))*1000)/1000; }
// junta a aba `id` à divisão `ids` (lista de ids de aba), do lado pedido. null = não cabe (já são 3)
function cvSplitAdd(ids, baseId, id, side){
  let list=Array.isArray(ids)&&ids.length?ids.slice():[baseId];
  if(!list.includes(baseId)) list=[baseId];
  if(id===baseId && list.length<2) return null; // dividir a aba com ela mesma: precisa de OUTRA aba
  list=list.filter(x=>x!==id);
  if(list.length>=CV_MAX_PANES) return null;
  if(side==='left') list.unshift(id); else list.push(id);
  return list;
}
// tira uma aba da divisão: com menos de 2 sobra a tela normal (null)
function cvSplitRemove(ids, id){ const l=(ids||[]).filter(x=>x!==id); return l.length>=2?l:null; }
// soltar uma aba arrastada na área de conteúdo: metade esquerda/direita (faixa do meio não divide)
function cvDropSide(rect, x){ if(!rect || !(rect.width>0)) return null; const r=(x-rect.left)/rect.width; return r<0.42?'left':r>0.58?'right':null; }
// ---------- grupo de abas (a tela dividida vista na barra de cima, estilo Chrome) ----------
// Os membros continuam em TABS; a barra mostra UMA aba-grupo no lugar do 1º membro, com um segmento por membro.
// itens da barra, na ordem: { id } (aba solta) ou { group:[ids] } (uma vez só). Grupo com < 2 membros = abas soltas
function cvStripItems(tabIds, groupIds){
  const g=Array.isArray(groupIds)?groupIds.filter(id=>tabIds.includes(id)):[];
  const grouped=g.length>=2; const out=[]; let put=false;
  for(const id of tabIds){ if(grouped && g.includes(id)){ if(!put){ put=true; out.push({ group:g }); } continue; } out.push({ id }); }
  return out;
}
// membros colados na barra: entram juntos (na ordem do grupo) no lugar do 1º que aparece
function cvGroupContig(order, ids){
  if(!Array.isArray(ids) || ids.length<2) return order.slice();
  const first=order.findIndex(x=>ids.includes(x)); if(first<0) return order.slice();
  const rest=order.filter(x=>!ids.includes(x));
  rest.splice(first, 0, ...ids.filter(x=>order.includes(x)));
  return rest;
}
// um membro sai (fechado ou "tirar do grupo"): o que sobra, o foco novo e quem fica na tela. ids:null = desfez (1 só)
function cvGroupLeave(ids, id, focus){
  const list=Array.isArray(ids)?ids:[]; const i=list.indexOf(id); if(i<0) return null;
  const rest=list.filter(x=>x!==id); if(!rest.length) return { ids:null, focus:0, next:null };
  const f=Math.max(0, Math.min(list.length-1, focus|0));
  const nf=Math.max(0, Math.min(rest.length-1, i<f?f-1:i===f?i:f));
  return rest.length>=2 ? { ids:rest, focus:nf, next:rest[nf] } : { ids:null, focus:0, next:rest[0] };
}
// arrastar: segmento solto na barra → sai do grupo; aba solta em cima do grupo → entra (até 3)
function cvGroupDrop(ids, dragId, onGroup){
  const inG=!!(Array.isArray(ids) && ids.includes(dragId));
  if(onGroup){ if(inG) return 'none'; if(Array.isArray(ids) && ids.length>=CV_MAX_PANES) return 'full'; return 'add'; }
  return inG?'eject':'move';
}
// teclado na aba-grupo: ←/→ andam entre segmentos (nas pontas saem pra aba vizinha), Home/End, Delete fecha o membro
function cvGroupKey(n, cur, key){
  const c=Math.max(0, Math.min(n-1, cur|0));
  if(key==='ArrowRight') return c+1<n ? { seg:c+1 } : { out:1 };
  if(key==='ArrowLeft') return c>0 ? { seg:c-1 } : { out:-1 };
  if(key==='Home') return { seg:0 };
  if(key==='End') return { seg:n-1 };
  if(key==='Delete' || key==='Backspace') return { close:c };
  if(key==='Enter' || key===' ') return { enter:c };
  return null;
}
// nome da aba-grupo pro leitor de tela (os segmentos são só visuais)
function cvGroupLabel(titles, focus){
  const n=titles.length, f=Math.max(0, Math.min(n-1, focus|0));
  return 'grupo de '+n+' abas lado a lado: '+titles.join(', ')+'. Em foco: '+titles[f]+' ('+(f+1)+' de '+n+'). Setas trocam, Delete fecha, Shift+F10 abre as opções';
}
// @canvas-puro-fim

// ---------- gerente de recursos: UM só no app (os painéis divididos usam o da janela principal) ----------
// Quem monta algo caro pede aqui com um "congelar" — passou do teto, o menos recente congela na hora (o iframe sai /
// o stream para) e o painel dele mostra "pausado — continuar daqui".
const CV_RM_HOST=(()=>{ try{ return (window.parent && window.parent!==window && window.parent.cvRmTake) ? window.parent : null; }catch(_){ return null; } })();
const CV_RM=CV_RM_HOST?CV_RM_HOST.CV_RM:cvRmNew();
const cvRmFreezers={}; // chave → função que congela aquele recurso
function cvRmTake(kind, key, freeze){
  if(CV_RM_HOST) return CV_RM_HOST.cvRmTake(kind, key, freeze);
  if(freeze) cvRmFreezers[key]=freeze;
  for(const k of cvRmAcquire(CV_RM, kind, key)){ const f=cvRmFreezers[k]; delete cvRmFreezers[k]; try{ if(f) f(); }catch(e){ console.error('congelar '+k, e); } }
}
function cvRmDrop(kind, key){ if(CV_RM_HOST) return CV_RM_HOST.cvRmDrop(kind, key); cvRmRelease(CV_RM, kind, key); delete cvRmFreezers[key]; }
// trocou de aba do app / janela escondeu: quem depende de "estar visível" reavalia (sem laço de polling)
function cvOnViewChange(){ try{ if(typeof dvCheckRun==='function') dvCheckRun(); }catch(e){ console.error('cvOnViewChange', e); } }
