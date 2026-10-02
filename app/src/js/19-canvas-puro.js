// Starfork — 19-canvas-puro
// ===== Workspace como CANVAS (spec-canvas-workspace / decisão da mesa 02/10) — funções PURAS =====
// Nada aqui toca DOM, Tauri ou globais do app: testado em app/tests/canvas.test.mjs (recorta entre os marcadores).
//  - GERENTE DE RECURSOS (F0): um lugar só conta o que é caro e vivo (iframes/webviews e o stream do dispositivo) e
//    aplica o teto (≤ 2 webviews e ≤ 1 stream no app inteiro). Pediu o 3º → o menos usado recentemente (LRU) congela.
//  - ESTADO POR PAINEL (F0): cada aba carrega o próprio taskId; a demanda de um painel nunca vem de um global.
//  - LAYOUT (F2): até 3 colunas FIXAS (sem split recursivo), cada uma com abas tipadas; JSON versionado por demanda;
//    inválido/versão desconhecida → padrão. Arrastar pra borda divide, pro meio junta.

// @canvas-puro-inicio
const CV_VER=1, CV_MAX_COLS=3;
// demandas diferentes no canvas (casa + outras). A 3ª só se a medição de CPU com 2 passar (decisão: veto do Marcos)
const CV_MAX_TASKS=2;
const CV_CAPS={ web:2, stream:1 };
// tipos de aba: nome humano no "+", o que pesa (heavy) e de quem pode ser (home = só a demanda dona da aba do app;
// any = qualquer demanda; free = não é de demanda nenhuma, ex.: site externo)
const CV_TYPES={
  app:        { label:'Meu app', hint:'o site desta demanda rodando', heavy:'web', who:'any', uniq:true },
  conversa:   { label:'Conversa', hint:'falar com o agente', who:'home', uniq:true },
  dispositivo:{ label:'Celular', hint:'o simulador/emulador ao vivo', heavy:'stream', who:'home', uniq:true },
  documento:  { label:'Documento', hint:'README, um arquivo ou o que foi entregue', who:'any' },
  diff:       { label:'Mudanças', hint:'o que mudou no código, arquivo por arquivo', who:'home', uniq:true },
  entrega:    { label:'Entrega', hint:'requisitos e provas de cada um', who:'home', uniq:true },
  codigo:     { label:'Código', hint:'ler e editar os arquivos da demanda', who:'home', uniq:true },
  pr:         { label:'PR', hint:'comentários, checagens e merge', who:'home', uniq:true },
  site:       { label:'Site qualquer', hint:'YouTube, documentação, referência', heavy:'web', who:'free' },
  demanda:    { label:'Outra demanda', hint:'comparar ou acompanhar lado a lado', who:'other', uniq:true },
  log:        { label:'Detalhes do ambiente', hint:'o registro técnico do site (só se precisar)', who:'home', uniq:true },
};
const CV_TYPE_IDS=Object.keys(CV_TYPES);

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

// ---------- contexto de painel ----------
// a demanda de um painel: a da aba (sempre). Tipo de "casa" sem taskId herda a casa; nada lê fwTask.
function cvPaneTask(tab, homeId){ if(!tab) return null; const w=(CV_TYPES[tab.type]||{}).who; if(w==='free') return homeId||null; return tab.taskId||homeId||null; }
// chave de recurso do painel: web = 'app:<task>' (prévia da demanda) ou 'site:<id da aba>'; stream = 'dev:<task>'
function cvResKey(tab, homeId){
  const ty=CV_TYPES[tab&&tab.type]; if(!ty||!ty.heavy) return null;
  if(tab.type==='app') return 'app:'+cvPaneTask(tab, homeId);
  if(tab.type==='site') return 'site:'+tab.id;
  if(tab.type==='dispositivo') return 'dev:'+cvPaneTask(tab, homeId);
  return null;
}

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
  if(yt && /^[\w-]{6,20}$/.test(yt)){ const t=parseInt(u.searchParams.get('t')||'',10); return { url:u.href, embed:'https://www.youtube-nocookie.com/embed/'+yt+(t>0?'?start='+t:''), blocked:false, host:'youtube.com', video:true }; }
  return { url:u.href, embed:u.href, blocked:CV_BLOCKED.test(host), host };
}

// ---------- abas ----------
function cvTabKey(t){ return [t.type, t.taskId||'', t.ref||'', t.url||''].join('|'); }
function cvMkTab(type, taskId, extra){
  const t={ type, taskId:taskId||null };
  if(extra && extra.ref) t.ref=String(extra.ref);
  if(extra && extra.url) t.url=String(extra.url);
  // id estável pelo conteúdo (abrir o mesmo README de novo = a mesma aba); curto e seguro pra atributo
  t.id='t'+cvHash(cvTabKey(t));
  return t;
}
function cvHash(s){ let h=2166136261; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36); }
function cvClone(l){ return JSON.parse(JSON.stringify(l)); }
function cvAllTabs(l){ return ((l&&l.cols)||[]).flatMap(c=>c.tabs); }
function cvFindTab(l, id){ const cols=(l&&l.cols)||[]; for(let c=0;c<cols.length;c++){ const i=cols[c].tabs.findIndex(t=>t.id===id); if(i>=0) return { col:c, idx:i, tab:cols[c].tabs[i] }; } return null; }
// abas VISÍVEIS = a ativa de cada coluna (só elas montam conteúdo pesado)
function cvVisible(l){ return ((l&&l.cols)||[]).map(c=>c.tabs.find(t=>t.id===c.active)||c.tabs[0]).filter(Boolean); }
function cvTasksIn(l){ return [...new Set(cvAllTabs(l).map(t=>t.taskId).filter(Boolean))]; }

// ---------- layout padrão e presets ----------
// ctx: { web:true|false|null (há página? null = ainda não sei), nonCode, mobile, doc:'art:nome'|'file:README.md'|null }
function cvDefaultLayout(homeId, ctx){
  ctx=ctx||{};
  const conv=cvMkTab('conversa', homeId);
  let left;
  if(ctx.nonCode) left=cvMkTab('documento', homeId, ctx.doc?{ ref:ctx.doc }:null);
  else if(ctx.web===false) left=ctx.mobile?cvMkTab('dispositivo', homeId):cvMkTab('entrega', homeId);
  else left=cvMkTab('app', homeId);
  return { v:CV_VER, cols:[{ tabs:[left], active:left.id }, { tabs:[conv], active:conv.id }], focus:1, auto:true };
}
function cvPreset(name, homeId, ctx){
  ctx=ctx||{};
  const conv=cvMkTab('conversa', homeId);
  // entrega sem código (relatório, pesquisa): "construir" = o documento; "revisar" = a Entrega (provas)
  const left = ctx.nonCode ? (name==='revisar' ? cvMkTab('entrega', homeId) : cvMkTab('documento', homeId, ctx.doc?{ ref:ctx.doc }:null))
    : name==='revisar' ? cvMkTab('diff', homeId)
    : (ctx.web===false ? (ctx.mobile?cvMkTab('dispositivo', homeId):cvMkTab('entrega', homeId)) : cvMkTab('app', homeId));
  return { v:CV_VER, cols:[{ tabs:[left], active:left.id }, { tabs:[conv], active:conv.id }], focus:0, auto:false };
}

// ---------- validação (layout salvo → layout ou null) ----------
// ctx: { homeId, taskIds:[...] (demandas que existem), allow:(type)=>bool (o que faz sentido nesta demanda) }
function cvValidate(raw, ctx){
  ctx=ctx||{};
  let l=raw; if(typeof l==='string'){ try{ l=JSON.parse(l); }catch(_){ return null; } }
  if(!l || typeof l!=='object' || l.v!==CV_VER || !Array.isArray(l.cols) || !l.cols.length) return null;
  const known=new Set(ctx.taskIds||[]); const home=ctx.homeId;
  const seen=new Set(); const tasks=new Set(home?[home]:[]);
  const cols=[];
  for(const c of l.cols.slice(0, CV_MAX_COLS)){
    if(!c || !Array.isArray(c.tabs)) continue;
    const tabs=[];
    for(const t0 of c.tabs){
      if(!t0 || typeof t0!=='object' || !CV_TYPES[t0.type]) continue;
      const who=CV_TYPES[t0.type].who;
      let taskId = who==='free' ? null : (t0.taskId||home||null);
      if(who==='home') taskId=home; // tipo da casa NUNCA mostra outra demanda (diff/conversa/dispositivo não trocam)
      if(who==='other' && (!taskId || taskId===home)) continue;
      if(taskId && !known.has(taskId)) continue; // demanda apagada/de outro projeto
      if(ctx.allow && !ctx.allow(t0.type, taskId)) continue;
      const extra={};
      if(t0.type==='site'){ const s=cvSiteUrl(t0.url); if(!s) continue; extra.url=s.url; }
      if(t0.type==='documento' && t0.ref!=null){ const r=String(t0.ref); if(!/^(art|file|ref):[^\0]{1,300}$/.test(r) || /(^|\/)\.\.(\/|$)/.test(r.slice(4))) continue; extra.ref=r; }
      const t=cvMkTab(t0.type, taskId, extra);
      if(seen.has(t.id)) continue;
      if(taskId && !tasks.has(taskId)){ if(tasks.size>=CV_MAX_TASKS) continue; tasks.add(taskId); }
      seen.add(t.id); tabs.push(t);
    }
    if(!tabs.length) continue;
    const act=tabs.find(t=>t.id===c.active)||tabs[0];
    cols.push({ tabs, active:act.id });
  }
  if(!cols.length) return null;
  const focus=Math.min(cols.length-1, Math.max(0, +l.focus|0));
  const out={ v:CV_VER, cols, focus, auto:!!l.auto };
  if(Array.isArray(l.opened)) out.opened=l.opened.filter(x=>typeof x==='string').slice(0,20);
  if(Array.isArray(l.w) && l.w.length===l.cols.length && cols.length===l.cols.length) out.w=cvWidths(l.w, cols.length);
  return out;
}
function cvSerialize(l){ return JSON.stringify({ v:CV_VER, cols:l.cols.map(c=>({ tabs:c.tabs.map(t=>{ const o={ type:t.type }; if(t.taskId) o.taskId=t.taskId; if(t.ref) o.ref=t.ref; if(t.url) o.url=t.url; return o; }), active:c.active })), focus:l.focus|0, auto:!!l.auto, ...(l.opened?{ opened:l.opened }:{}), ...(Array.isArray(l.w)&&l.w.length===l.cols.length?{ w:cvWidths(l.w, l.cols.length) }:{}) }); }
function cvSig(l){ return l?l.cols.map(c=>c.active+':'+c.tabs.map(t=>t.id).join(',')).join('/')+'@'+(l.focus|0):''; }

// ---------- operações (devolvem um layout NOVO; mexer na mão = sai do automático) ----------
// col: índice, 'new' (coluna nova à direita, se couber) ou undefined (a coluna em foco)
function cvAddTab(l, tab, col){
  const n=cvClone(l); n.auto=false;
  const ex=cvFindTab(n, tab.id);
  if(ex){ n.cols[ex.col].active=tab.id; n.focus=ex.col; return n; }
  const tasks=new Set(cvTasksIn(n)); if(tab.taskId && !tasks.has(tab.taskId) && tasks.size>=CV_MAX_TASKS) return null; // teto de demandas
  if(col==='new' && n.cols.length<CV_MAX_COLS){ n.cols.push({ tabs:[tab], active:tab.id }); n.focus=n.cols.length-1; delete n.w; return n; }
  const c=(typeof col==='number' && n.cols[col]) ? col : Math.min(n.focus|0, n.cols.length-1);
  n.cols[c].tabs.push(tab); n.cols[c].active=tab.id; n.focus=c; return n;
}
function cvActivate(l, id){ const f=cvFindTab(l, id); if(!f) return l; const n=cvClone(l); n.cols[f.col].active=id; n.focus=f.col; return n; }
function cvCloseTab(l, id){
  const f=cvFindTab(l, id); if(!f) return l;
  const n=cvClone(l); n.auto=false; const col=n.cols[f.col];
  col.tabs.splice(f.idx,1);
  if(!col.tabs.length){ n.cols.splice(f.col,1); if(!n.cols.length) return null; n.focus=Math.min(n.focus, n.cols.length-1); delete n.w; return n; }
  if(col.active===id) col.active=(col.tabs[f.idx]||col.tabs[f.idx-1]||col.tabs[0]).id;
  return n;
}
// zona de soltura numa coluna: borda esquerda/direita divide (se couber), o meio junta. rect: {left,width}
function cvDropZone(rect, x, ncols){
  if(!rect || !(rect.width>0)) return 'center';
  const band=Math.max(40, rect.width*0.22), rel=x-rect.left;
  const zone = rel<band ? 'left' : rel>rect.width-band ? 'right' : 'center';
  return (zone!=='center' && ncols>=CV_MAX_COLS) ? 'center-full' : zone;
}
// move uma aba pra coluna `to` (zona left/right = coluna nova daquele lado; center = entra nas abas dela)
function cvMoveTab(l, id, to, zone){
  const f=cvFindTab(l, id); if(!f) return l;
  const side=(zone==='left'||zone==='right');
  // soltou na PRÓPRIA coluna (no meio, ou na borda sendo a única aba dela): nada muda além de ativar
  if(f.col===to && (!side || l.cols[f.col].tabs.length===1)) return cvActivate(l, id);
  const n=cvClone(l); n.auto=false; delete n.w; // colunas mudam: larguras voltam ao automático
  const tab=n.cols[f.col].tabs.splice(f.idx,1)[0];
  const srcEmpty=!n.cols[f.col].tabs.length;
  if(!srcEmpty && n.cols[f.col].active===id) n.cols[f.col].active=(n.cols[f.col].tabs[f.idx]||n.cols[f.col].tabs[f.idx-1]).id;
  let target=to;
  if(srcEmpty){ n.cols.splice(f.col,1); if(f.col<to) target=to-1; }
  if(target>=n.cols.length) target=n.cols.length; // soltou depois da última
  if(side && n.cols.length<CV_MAX_COLS){
    const at=zone==='left'?Math.max(0,target):Math.min(n.cols.length, target+1);
    n.cols.splice(at, 0, { tabs:[tab], active:tab.id }); n.focus=at; return n;
  }
  const c=Math.min(Math.max(0,target), n.cols.length-1);
  if(c<0){ n.cols=[{ tabs:[tab], active:tab.id }]; n.focus=0; return n; }
  n.cols[c].tabs.push(tab); n.cols[c].active=tab.id; n.focus=c; return n;
}
// ⌘\ — com 2+ abas na coluna em foco, a ativa vai pra uma coluna nova à direita. null = não dá (só 1 aba / 3 colunas)
function cvSplit(l){
  const c=l.cols[l.focus|0]; if(!c || c.tabs.length<2 || l.cols.length>=CV_MAX_COLS) return null;
  return cvMoveTab(l, c.active, l.focus|0, 'right');
}
// itens do "+" (nomes humanos). ctx: { web, mobile, nonCode, hasPr, others:[{id,title}], tasksN }
function cvPlusItems(ctx){
  ctx=ctx||{}; const it=[];
  const add=(type, extra)=>it.push(Object.assign({ type, label:CV_TYPES[type].label, hint:CV_TYPES[type].hint }, extra||{}));
  // o que aparece depende do TIPO da entrega/projeto (veto: nada de "modo simples")
  if(!ctx.nonCode && ctx.web!==false) add('app');
  add('conversa');
  if(ctx.mobile) add('dispositivo');
  add('documento');
  if(!ctx.nonCode){ add('diff'); add('codigo'); }
  add('entrega');
  if(ctx.hasPr) add('pr');
  add('site');
  const full=(ctx.tasksN||1)>=CV_MAX_TASKS;
  add('demanda', { others:(ctx.others||[]), disabled:!(ctx.others||[]).length || full,
    why:!(ctx.others||[]).length?'não há outra demanda neste projeto':full?`no máximo ${CV_MAX_TASKS} demandas lado a lado por enquanto`:'' });
  // Log NÃO entra no "+" (veto da Bia: texto de máquina só em "ver detalhes") — abre pela faixa do ambiente
  return it;
}
// troca a aba `id` por outra (mesmo lugar, ativa) — ex.: Documento sem arquivo → com o arquivo escolhido
function cvReplaceTab(l, id, tab){
  const f=cvFindTab(l, id); if(!f) return l;
  const n=cvClone(l); const dup=cvFindTab(n, tab.id);
  if(dup && dup.tab.id!==id){ n.cols[f.col].tabs.splice(f.idx,1); if(!n.cols[f.col].tabs.length) n.cols.splice(f.col,1); const d2=cvFindTab(n, tab.id); n.cols[d2.col].active=tab.id; n.focus=d2.col; return n; }
  n.cols[f.col].tabs[f.idx]=tab; n.cols[f.col].active=tab.id; n.focus=f.col; return n;
}
// legado: os modos antigos (fwMode) viram tipos de aba — nada se perde
const CV_MODE2TYPE={ conversa:'conversa', codigo:'codigo', revisao:'diff', entrega:'entrega', pr:'pr', previa:'app' };
const CV_TYPE2MODE={ conversa:'conversa', codigo:'codigo', diff:'revisao', entrega:'entrega', pr:'pr', app:'previa' };
// cor estável por demanda (nome+cor em cada painel: ninguém manda mensagem pra demanda errada)
function cvTaskHue(id){ let h=2166136261; const s=String(id||''); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } h^=h>>>15; h=Math.imul(h,0x2c1b3c6d); h^=h>>>12; h=Math.imul(h,0x297a2d39); h^=h>>>15; return Math.floor((((h>>>0)*0.6180339887)%1)*360); }
// a cor de uma demanda NA TELA da casa: se ficar parecida com a da casa (< 50°), gira pro lado oposto do círculo —
// duas demandas lado a lado nunca têm a mesma cor
function cvTaskColor(id, homeId){ let h=cvTaskHue(id); if(homeId && id!==homeId){ const hh=cvTaskHue(homeId); const d=Math.abs(h-hh); if(Math.min(d, 360-d)<50) h=(hh+180)%360; } return 'hsl('+h+' 72% 62%)'; }
// larguras salvas: FRAÇÃO da largura por coluna (null = automática); valores sãos, uma por coluna
function cvWidths(w, n){ return Array.from({ length:n }, (_,i)=>{ const v=Array.isArray(w)?+w[i]:NaN; return (v>=0.08 && v<=0.92) ? Math.round(v*1000)/1000 : null; }); }
// @canvas-puro-fim

// ---------- gerente de recursos: a instância do app (um só) ----------
// Quem monta algo caro pede aqui com um "congelar" — se passar do teto, o menos recente é congelado na hora
// (o iframe sai / o stream para) e o painel dele mostra "pausado — clique pra retomar".
const CV_RM=cvRmNew();
const cvRmFreezers={}; // chave → função que congela aquele recurso
function cvRmTake(kind, key, freeze){
  if(freeze) cvRmFreezers[key]=freeze;
  for(const k of cvRmAcquire(CV_RM, kind, key)){ const f=cvRmFreezers[k]; delete cvRmFreezers[k]; try{ if(f) f(); }catch(e){ console.error('congelar '+k, e); } }
}
function cvRmDrop(kind, key){ cvRmRelease(CV_RM, kind, key); delete cvRmFreezers[key]; }
// trocou de aba do app / janela escondeu: quem depende de "estar visível" reavalia (sem laço de polling)
function cvOnViewChange(){ try{ if(typeof dvCheckRun==='function') dvCheckRun(); }catch(e){ console.error('cvOnViewChange', e); } }
