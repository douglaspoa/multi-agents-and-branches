// Starfork — 87-quadro
// ===== QUADRO AO VIVO (aprovado pelo dono em 29/10: "exatamente isso, ficou bem legal") =====
// A IA DESENHA NA TELA, ao vivo, com layout livre, enquanto explica: cada passo vira um traço à mão (tremida estável,
// caneta seguindo o traço, texto letra a letra) sincronizado com a fala (legenda + lista "O que a IA está dizendo").
// A pessoa também desenha por cima (✎ Sua caneta) e pergunta: a IA responde DESENHANDO ali (passos acrescentados).
// Serve pra: explicar como uma tarefa foi resolvida (⋯ da tarefa → "desenhar"), explicar uma demanda, responder no chat
// ("explica desenhando" → botão na bolha) e REVISAR UM LAYOUT (print de fundo + mudanças desenhadas + "Aplicar no código").
// É um KIND do canvas do topo (58-canvas): aba 'quadro' (ref = id do quadro), divide a tela como o Documento.
// Armazenamento: <repo>/.cardume/quadros/<id>/quadro.json + assets/ (quadros.rs); IA: quadro_ia.rs (só leitura).
// Renderizador, motor de passos, caneta e resposta vêm do mock aprovado (quadro-ao-vivo.html), com cores por NOME
// mapeadas pros tokens do tema (--qd-*, claro e escuro) e fonte manuscrita do sistema (nada de CDN).

// @qd-puro-inicio (puro: sem DOM nem invoke — testado em app/tests/quadro.test.mjs)
const QD_W=1000, QD_H=600, QD_MAX_STEPS=120, QD_MAX_TXT=140;
const QD_COLORS=['ink','red','green','blue','mute','mark'];
const QD_KINDS=['say','box','arrow','line','circle','text','cross','check','mark','dot','file'];
const QD_HAND="'Bradley Hand','Chalkboard SE','Marker Felt','Segoe Print','Comic Sans MS',cursive";
function qdNum(v){ const n=(typeof v==='string'&&v.trim()!=='')?Number(v):v; return (typeof n==='number'&&isFinite(n))?n:null; }
function qdClamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function qdR(v){ return Math.round(v*10)/10; }
function qdStr(s, max){ s=String(s==null?'':s).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim(); return s.length>max?s.slice(0,max-1).trimEnd()+'…':s; }
function qdColor(c){ c=String(c==null?'':c).toLowerCase().trim(); return QD_COLORS.includes(c)?c:'ink'; }
function qdNums(a, n){ if(!Array.isArray(a) || a.length<n) return null; const o=[]; for(let i=0;i<n;i++){ const v=qdNum(a[i]); if(v==null) return null; o.push(v); } return o; }
const qdX=v=>qdR(qdClamp(v,0,QD_W)), qdY=v=>qdR(qdClamp(v,0,QD_H));
/** UM passo da IA → passo saneado ou null (tipos, limites, cor da lista; o resto é descartado sem quebrar) */
function qdStep(raw, o){
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return null;
  if(o && o.allowAsk && raw.ask!=null){ const s=qdStr(raw.ask, 300); return s?{ ask:s }:null; }
  const k=QD_KINDS.find(x=>raw[x]!=null); if(!k) return null;
  const color=qdColor(raw.color);
  if(k==='say'){ const s=qdStr(raw.say, QD_MAX_TXT); return s?{ say:s }:null; }
  if(k==='box' || k==='mark' || k==='file'){
    const a=qdNums(raw[k],4); if(!a) return null;
    let x=a[0], y=a[1], w=a[2], h=a[3]; if(w<0){ x+=w; w=-w; } if(h<0){ y+=h; h=-h; }
    x=qdX(x); y=qdY(y); w=qdR(Math.min(w, QD_W-x)); h=qdR(Math.min(h, QD_H-y));
    if(!(w>=4 && h>=4)) return null;
    const st={ [k]:[x,y,w,h] }; if(k==='mark') return st;
    st.color=color; const l=qdStr(raw.label, 60); if(l) st.label=l; return st;
  }
  if(k==='arrow' || k==='line'){
    const a=qdNums(raw[k],4); if(!a) return null;
    const p=[qdX(a[0]),qdY(a[1]),qdX(a[2]),qdY(a[3])]; if(Math.hypot(p[2]-p[0],p[3]-p[1])<4) return null;
    const st={ [k]:p, color }; if(k==='arrow'){ const b=qdNum(raw.bend); st.bend=b==null?0:Math.round(qdClamp(b,-200,200)); } return st;
  }
  if(k==='circle'){
    const a=Array.isArray(raw.circle)&&raw.circle.length===3?qdNums(raw.circle.concat([raw.circle[2]]),4):qdNums(raw.circle,4); if(!a) return null;
    return { circle:[qdX(a[0]),qdY(a[1]),qdR(qdClamp(Math.abs(a[2]),3,500)),qdR(qdClamp(Math.abs(a[3]),3,300))], color };
  }
  if(k==='text'){
    const a=qdNums(raw.text,2); if(!a) return null;
    const s=qdStr(raw.s!=null?raw.s:raw.label, QD_MAX_TXT); if(!s) return null;
    const z=qdNum(raw.size); const size=z==null?26:Math.round(qdClamp(z,12,56));
    return { text:[qdX(a[0]),qdR(qdClamp(a[1],size*.8,QD_H))], s, size, color };
  }
  if(k==='cross' || k==='check'){
    const a=qdNums(raw[k],2); if(!a) return null; const z=qdNum(raw[k][2]);
    return { [k]:[qdX(a[0]),qdY(a[1]),qdR(z==null?16:qdClamp(Math.abs(z),4,80))], color };
  }
  if(k==='dot'){ const a=qdNums(raw.dot,2); if(!a) return null; return { dot:[qdX(a[0]),qdY(a[1])], color }; }
  return null;
}
function qdIsDraw(st){ return !!st && st.say==null && st.ask==null; }
/** resposta da IA (objeto ou só a lista) → { title, steps, changes } saneado; o.max = teto de passos */
function qdSanitize(obj, o){
  o=o||{}; const raw=Array.isArray(obj)?{ steps:obj }:(obj&&typeof obj==='object'?obj:{});
  const steps=[]; const max=o.max||QD_MAX_STEPS;
  for(const r of (Array.isArray(raw.steps)?raw.steps:[])){ if(steps.length>=max) break; const s=qdStep(r, o); if(s) steps.push(s); }
  const changes=(Array.isArray(raw.changes)?raw.changes:[]).map(c=>qdStr(typeof c==='object'&&c?(c.text||c.titulo||''):c, 200)).filter(Boolean).slice(0,12);
  return { title:qdStr(raw.title, 80), steps, changes };
}
/** o JSON do texto da IA (bloco ```json, ou o 1º objeto balanceado) */
function qdJsonFrom(text){
  const t=String(text||'');
  const tries=[...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m=>m[1].trim()).filter(x=>/^[[{]/.test(x)).reverse();
  const i=t.indexOf('{');
  if(i>=0){ let d=0, str=false, esc=false;
    for(let j=i;j<t.length;j++){ const c=t[j];
      if(str){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') str=false; continue; }
      if(c==='"') str=true; else if(c==='{') d++; else if(c==='}'){ if(--d===0){ tries.push(t.slice(i,j+1)); break; } } } }
  for(const x of tries){ try{ return JSON.parse(x); }catch(_){ } }
  const e=new Error('a IA respondeu sem o JSON combinado — tente de novo ou use outra IA'); e.raw=t.slice(0,600); throw e;
}
/** texto da IA → desenho saneado; sem nenhum traço = erro (não mostra quadro vazio fingindo que deu certo) */
function qdParse(text, o){
  const r=qdSanitize(qdJsonFrom(text), o);
  if(!r.steps.some(qdIsDraw)){ const e=new Error('a IA respondeu, mas sem nenhum traço desenhável — tente de novo'); e.raw=String(text||'').slice(0,600); throw e; }
  return r;
}

// ---------- traço à mão: tremida ESTÁVEL (semente por passo — rever o desenho dá o mesmo traço) ----------
function qdRng(seed){ let s=Math.abs(Math.floor(seed))%2147483646+1; return (a,b)=>{ s=(s*16807)%2147483647; return a+(b-a)*((s-1)/2147483646); }; }
function qdF(v){ return (Math.round(v*10)/10).toString(); }
function qdLineD(rnd, x1,y1,x2,y2, bend){
  const j=v=>v+rnd(-1.2,1.2);
  const L=Math.hypot(x2-x1,y2-y1), k=bend!=null?bend:rnd(-1,1)*Math.min(6,L*.025);
  const mx=(x1+x2)/2, my=(y1+y2)/2, nx=-(y2-y1)/(L||1), ny=(x2-x1)/(L||1);
  const cx=mx+nx*k, cy=my+ny*k;
  return { d:`M${qdF(j(x1))} ${qdF(j(y1))} Q${qdF(cx)} ${qdF(cy)} ${qdF(j(x2))} ${qdF(j(y2))}`, ctl:[cx,cy] };
}
function qdEllD(rnd, cx,cy,rx,ry){ let d=''; const n=44, a0=rnd(0,6.28); for(let i=0;i<=n+4;i++){ const a=a0+i/n*6.283, r=1+rnd(-.04,.04); d+=(i?'L':'M')+qdF(cx+Math.cos(a)*rx*r)+' '+qdF(cy+Math.sin(a)*ry*r)+' '; } return d.trim(); }
function qdTextW(s, size){ return String(s||'').length*size*.5; }
/** um passo → o que desenhar: { strokes:[{d,w,color}], texts:[{x,y,s,size,color}], dots, marks } (puro, determinístico) */
function qdShapes(st, i){
  const rnd=qdRng(7+(i|0)*7919), out={ strokes:[], texts:[], dots:[], marks:[] };
  if(!qdIsDraw(st)) return out;
  const c=st.color||'ink', S=(d,w)=>out.strokes.push({ d, w, color:c });
  if(st.box){ const [x,y,w,h]=st.box;
    [qdLineD(rnd,x-3,y,x+w+3,y), qdLineD(rnd,x+w,y-3,x+w,y+h+3), qdLineD(rnd,x+w+3,y+h,x-3,y+h), qdLineD(rnd,x,y+h+3,x,y-3)].forEach(o=>S(o.d,2.5));
    if(st.label){ let size=24; while(size>14 && qdTextW(st.label,size)>w-20) size-=2; out.texts.push({ x:x+12, y:y+Math.min(h/2+size*.35, size+12), s:st.label, size, color:c }); } }
  else if(st.arrow){ const [x1,y1,x2,y2]=st.arrow; const l=qdLineD(rnd,x1,y1,x2,y2,st.bend||0); const [cx,cy]=l.ctl; const a=Math.atan2(y2-cy,x2-cx), h=16;
    S(l.d,3); S(`M${qdF(x2-Math.cos(a-.45)*h)} ${qdF(y2-Math.sin(a-.45)*h)} L${qdF(x2)} ${qdF(y2)} L${qdF(x2-Math.cos(a+.45)*h)} ${qdF(y2-Math.sin(a+.45)*h)}`,3); }
  else if(st.line){ const [x1,y1,x2,y2]=st.line; S(qdLineD(rnd,x1,y1,x2,y2).d,3); }
  else if(st.circle){ const [cx,cy,rx,ry]=st.circle; S(qdEllD(rnd,cx,cy,rx,ry),2.5); }
  else if(st.text){ out.texts.push({ x:st.text[0], y:st.text[1], s:st.s, size:st.size||26, color:c }); }
  else if(st.cross){ const [x,y,s]=st.cross; S(qdLineD(rnd,x-s,y-s,x+s,y+s).d,4); S(qdLineD(rnd,x+s,y-s,x-s,y+s).d,4); }
  else if(st.check){ const [x,y,s]=st.check; S(`M${qdF(x-s)} ${qdF(y)} L${qdF(x-s*.3)} ${qdF(y+s*.7)} L${qdF(x+s)} ${qdF(y-s*.8)}`,4); }
  else if(st.file){ const [x,y,w,h]=st.file, f=Math.min(18,w/3,h/3);
    S(`M${qdF(x)} ${qdF(y)} L${qdF(x+w-f)} ${qdF(y)} L${qdF(x+w)} ${qdF(y+f)} L${qdF(x+w)} ${qdF(y+h)} L${qdF(x)} ${qdF(y+h)} Z`,3);
    S(`M${qdF(x+w-f)} ${qdF(y)} L${qdF(x+w-f)} ${qdF(y+f)} L${qdF(x+w)} ${qdF(y+f)}`,3);
    if(st.label){ let size=22; while(size>13 && qdTextW(st.label,size)>w-12) size-=2; out.texts.push({ x:x+8, y:y+h/2+size*.35, s:st.label, size, color:c }); } }
  else if(st.mark){ out.marks.push(st.mark.slice()); }
  else if(st.dot){ out.dots.push({ x:st.dot[0], y:st.dot[1], color:c }); }
  return out;
}

// ---------- caneta da pessoa + o que está embaixo dela ----------
/** traços salvos → saneados ([[x,y],…] por traço; ≤ 200 traços, ≤ 1500 pontos) */
function qdMineClean(arr){
  const out=[];
  for(const s of (Array.isArray(arr)?arr:[])){ if(out.length>=200) break;
    const pts=[]; for(const p of (Array.isArray(s)?s:[])){ if(pts.length>=1500) break; const a=qdNums(p,2); if(a) pts.push([qdX(a[0]),qdY(a[1])]); }
    if(pts.length) out.push(pts); }
  return out;
}
function qdMinePath(pts){ return (pts||[]).map((p,i)=>(i?'L':'M')+qdF(p[0])+' '+qdF(p[1])).join(' ')+(pts&&pts.length===1?' l0.1 0':''); }
function qdBBox(strokes){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const s of (strokes||[])) for(const p of s){ x0=Math.min(x0,p[0]); y0=Math.min(y0,p[1]); x1=Math.max(x1,p[0]); y1=Math.max(y1,p[1]); }
  return x0===Infinity?null:{ x:qdR(x0), y:qdR(y0), w:qdR(x1-x0), h:qdR(y1-y0) };
}
/** rótulos escritos no quadro, com a caixa ESTIMADA (sem DOM): texto solto, rótulo de caixa e de arquivo */
function qdLabels(steps){
  const out=[];
  (steps||[]).forEach((st,i)=>{ if(!qdIsDraw(st)) return; for(const t of qdShapes(st,i).texts) out.push({ s:t.s, x:t.x, y:t.y-t.size*.8, w:qdTextW(t.s,t.size), h:t.size }); });
  return out;
}
/** os rótulos mais perto do que a pessoa riscou (primeiro os que a caixa toca; depois pela distância do centro) */
function qdNear(bb, labels, n){
  if(!bb) return [];
  const cx=bb.x+bb.w/2, cy=bb.y+bb.h/2;
  const hit=l=>!(l.x>bb.x+bb.w || l.x+l.w<bb.x || l.y>bb.y+bb.h || l.y+l.h<bb.y);
  return (labels||[]).map(l=>({ s:l.s, hit:hit(l), d:Math.hypot(l.x+l.w/2-cx, l.y+l.h/2-cy) }))
    .sort((a,b)=>(b.hit-a.hit)||(a.d-b.d)).filter((l,i,a)=>a.findIndex(x=>x.s===l.s)===i).slice(0,n||3).map(l=>l.s);
}
function qdMineInfo(mine, steps){ const bbox=qdBBox(mine); return { bbox, near:qdNear(bbox, qdLabels(steps), 3), strokes:(mine||[]).length }; }

// ---------- pedidos pra IA ----------
/** o que a IA precisa saber da tarefa (dados simples — quem chama junta do estado do app) */
function qdTaskCtx(c){
  if(!c || !c.title) return '';
  const L=['DEMANDA: '+qdStr(c.title,160)+(c.status?' (status: '+c.status+')':'')+(c.branch?' · branch '+c.branch:'')];
  if(c.objective) L.push('OBJETIVO: '+String(c.objective).split('[PLANO DO ORQUESTRADOR')[0].trim().slice(0,1200));
  const reqs=(c.requirements||[]).slice(0,20);
  if(reqs.length) L.push('PRONTO QUANDO (requisitos e provas):\n'+reqs.map((r,i)=>{ const p=(c.proofs||[])[i]; return '- '+qdStr(r,200)+(p?' → '+(p.status==='done'?'provado':'sem prova')+(p.evidence&&p.evidence.length?' ('+p.evidence.slice(0,2).join(', ')+')':''):''); }).join('\n'));
  const files=(c.files||[]).slice(0,30);
  if(files.length) L.push('ARQUIVOS MEXIDOS ('+(c.files.length)+'):\n'+files.map(f=>'- '+f.path+(f.add!=null?' +'+f.add+(f.del!=null?' −'+f.del:''):'')).join('\n'));
  const talk=(c.talk||[]).slice(-10);
  if(talk.length) L.push('FIM DA CONVERSA:\n'+talk.map(m=>(m.who||'?')+': '+qdStr(m.text,400)).join('\n'));
  return L.join('\n\n');
}
function qdBgLine(bgPath){ return bgPath?'PRINT DE FUNDO (revisar layout): '+bgPath+' — abra com Read. A imagem ocupa o quadro inteiro (1000×600, centralizada). Desenhe POR CIMA: circule em red o que está ruim, desenhe a proposta em green e liste cada mudança em "changes".':''; }
function qdPromptDesenhar(req, o){
  o=o||{};
  return ['PEDIDO: '+(String(req||'').trim()||'Explique, desenhando, o que está acontecendo aqui.'),
    o.ctx?'CONTEXTO\n'+o.ctx:'', qdBgLine(o.bgPath),
    o.project?'PROJETO: '+o.project:'',
    'Desenhe a explicação no quadro (layout livre), intercalando fala curta e traço. Responda SÓ com o bloco ```json.'].filter(Boolean).join('\n\n');
}
/** a cena atual, compacta (pra IA não desenhar em cima do que existe) — corta do começo se passar do teto */
function qdSceneText(steps, max){
  max=max||7000; const lines=(steps||[]).map(s=>JSON.stringify(s));
  let out=lines.join('\n'); while(out.length>max && lines.length>1){ lines.shift(); out='…\n'+lines.join('\n'); }
  return out;
}
function qdPromptPergunta(q, info, steps, o){
  o=o||{}; const bb=info&&info.bbox;
  return ['PERGUNTA DA PESSOA: '+String(q||'').trim(),
    bb?'TRAÇOS DA PESSOA (roxo, '+info.strokes+' traço'+(info.strokes===1?'':'s')+'): caixa x '+Math.round(bb.x)+', y '+Math.round(bb.y)+', largura '+Math.round(bb.w)+', altura '+Math.round(bb.h)+(info.near.length?' — perto de: '+info.near.map(s=>'"'+s+'"').join(', '):'')+'. Responda sobre ESSE ponto, desenhando ali perto.':'A pessoa não riscou nada: responda sobre o desenho inteiro, num espaço livre.',
    'CENA ATUAL (passos que JÁ estão no quadro — não repita):\n'+qdSceneText(steps),
    o.ctx?'CONTEXTO\n'+o.ctx:'', qdBgLine(o.bgPath),
    'Devolva SÓ os passos NOVOS (eles são acrescentados), começando por um {"say":…} que responde a pergunta. No máximo uns 15 passos. Responda SÓ com o bloco ```json.'].filter(Boolean).join('\n\n');
}
/** a mensagem do chat pede um desenho? (oferece o quadro na bolha — não precisa ser perfeito) */
function qdWantsDraw(text){ return /\b(desenh\w*|rabisc\w*|diagrama\w*|quadro branco)\b|explica\w* (com|num|em) (um )?(desenho|quadro)/i.test(String(text||'')); }
/** "Aplicar no código": a mensagem pro agente (as mudanças desenhadas + onde está o desenho) */
function qdApplyText(doc){
  const ch=(doc&&doc.changes)||[];
  return ['Pedido de alteração a partir do Quadro'+(doc&&doc.title?' “'+doc.title+'”':'')+' — o desenho com as mudanças está anexado (PNG).',
    ch.length?'Mudanças desenhadas:\n'+ch.map((c,i)=>(i+1)+'. '+c).join('\n'):'Aplique o que está desenhado em verde por cima do print; o que está circulado em vermelho é o problema.',
    'Siga o desenho como requisito visual; se algo não fizer sentido no código, pergunte antes de inventar.'].join('\n\n');
}
function qdNewId(now, r){ return 'q-'+Math.floor(now||0).toString(36)+(r==null?'':String(r)).replace(/[^a-z0-9]/gi,'').slice(0,6).toLowerCase(); }
function qdIdOk(id){ return /^q-[A-Za-z0-9_-]{1,40}$/.test(String(id||'')); }
/** quadro.json do disco → doc são (passos saneados, com as perguntas da pessoa no meio) */
function qdDoc(raw, id){
  raw=(raw&&typeof raw==='object')?raw:{};
  const s=qdSanitize({ steps:raw.steps, changes:raw.changes, title:raw.title }, { allowAsk:true, max:600 });
  const bg=typeof raw.bg==='string'&&/^assets\/[A-Za-z0-9._-]{1,96}$/.test(raw.bg)?raw.bg:null;
  return { v:1, id:qdIdOk(raw.id)?raw.id:id, title:s.title, prompt:qdStr(raw.prompt, 2000), taskId:raw.taskId?String(raw.taskId):null,
    steps:s.steps, changes:s.changes, mine:qdMineClean(raw.mine), bg,
    history:(Array.isArray(raw.history)?raw.history:[]).filter(h=>h&&typeof h==='object').slice(-100).map(h=>({ q:qdStr(h.q,300), at:+h.at||0, from:+h.from||0, to:+h.to||0 })),
    createdAt:+raw.createdAt||0 };
}
function qdSpeedNext(s){ return s===1?2:s===2?0.5:1; }
function qdSpeedLabel(s){ return (s===0.5?'½':String(s))+'×'; }
function qdSayMs(s){ return 500+String(s||'').length*18; }
// @qd-puro-fim

// ================= DOM =================
const QD={ s:{}, list:null };
const QD_NS='http://www.w3.org/2000/svg';
function qdReduce(){ try{ if(typeof mvReduced==='function') return !!mvReduced(); return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(_){ return false; } }
function qdS(id){ return QD.s[id]||(QD.s[id]={ id, doc:null, loading:false, run:0, paused:false, wake:null, speed:1, busy:false, acts:[], err:null, penOn:false, bgUrl:null, saveT:0, root:null, done:false, note:'' }); }
function qdEl(n, a){ const e=document.createElementNS(QD_NS, n); for(const k in (a||{})) e.setAttribute(k, a[k]); return e; }
function qdEsc(s){ return typeof esc==='function'?esc(s):String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function qdTask(id){ return id?(((typeof state!=='undefined'&&state&&state.tasks)||[]).find(t=>t.id===id)||null):null; }
function qdRepo(){ return (typeof state!=='undefined'&&state&&state.repo)||''; }
function qdModel(){ try{ const d=typeof aiDefaults==='function'?aiDefaults():{}; const eng=typeof aiEngineOf==='function'?aiEngineOf(d.eng):d.eng; return eng==='claude'?(d.model||null):null; }catch(_){ return null; } }
function qdTitleOf(tab){ const s=tab&&QD.s[tab.ref]; const t=s&&s.doc&&s.doc.title; return 'Quadro'+(t?' · '+t:''); }
window.qdTitleOf=qdTitleOf;

// ---------- abrir ----------
/** cria um quadro novo (já gravado — o fundo precisa da pasta) e abre a aba. o: { taskId, prompt, auto, split } */
async function qdOpenNew(o){
  o=o||{};
  const id=qdNewId(Date.now(), Math.random().toString(36).slice(2,6));
  const doc={ v:1, id, title:'', prompt:String(o.prompt||'').trim().slice(0,2000), taskId:o.taskId||null, steps:[], changes:[], mine:[], bg:null, history:[], createdAt:Date.now() };
  try{ await invoke('quadro_write', { id, json:doc }); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui criar o quadro'); return null; }
  const s=qdS(id); s.doc=doc; QD.list=null;
  if(typeof cvOpenTop==='function') cvOpenTop({ kind:'quadro', ref:id }, o.split?{ split:o.split }:{});
  if(o.auto && doc.prompt) setTimeout(()=>qdDraw(s, doc.prompt), 30);
  return id;
}
function qdOpenSaved(id, o){ if(!qdIdOk(id)) return; if(typeof cvOpenTop==='function') cvOpenTop({ kind:'quadro', ref:id }, (o&&o.split)?{ split:o.split }:{}); }
/** ⋯ da tarefa → "desenhar": a IA explica como resolveu (ou, sem código ainda, o que entendeu da demanda) */
async function qdFromTask(taskId){
  const t=qdTask(taskId); if(!t) return null;
  const started=!['draft','queued'].includes(t.status);
  const prompt=started?'Explique, desenhando, COMO você resolveu esta tarefa: o problema, o caminho escolhido e o que mudou.':'Explique, desenhando, o que você ENTENDEU desta demanda e como pretende resolver.';
  return qdOpenNew({ taskId, prompt, auto:true });
}
/** bolha do chat "explica desenhando" → quadro com aquele pedido (ligado à tarefa da conversa, se houver) */
async function qdFromChat(text, taskId){ return qdOpenNew({ taskId:taskId||null, prompt:String(text||'').slice(0,2000), auto:true }); }
window.qdOpenNew=qdOpenNew; window.qdOpenSaved=qdOpenSaved; window.qdFromTask=qdFromTask; window.qdFromChat=qdFromChat;
function qdBubbleHtml(text, taskId){
  if(!qdWantsDraw(text)) return '';
  return `<button type="button" class="qd-bub" data-qdask="${qdEsc(String(text||'').slice(0,1500))}"${taskId?` data-qdtask="${qdEsc(taskId)}"`:''} title="abre o Quadro: a IA explica desenhando">✎ abrir no Quadro</button>`;
}
window.qdBubbleHtml=qdBubbleHtml;
document.addEventListener('click', e=>{ const b=e.target.closest&&e.target.closest('[data-qdask]'); if(!b) return; e.preventDefault(); e.stopPropagation();
  const tid=b.dataset.qdtask||((typeof fwTask!=='undefined'&&fwTask&&b.closest('#fwThread'))?fwTask:null); qdFromChat(b.dataset.qdask, tid); });

// ---------- salvar ----------
function qdSave(s, now){
  if(!s.doc) return; clearTimeout(s.saveT);
  const go=()=>invoke('quadro_write', { id:s.id, json:s.doc }).catch(e=>{ if(typeof showErr==='function') showErr(e, 'Não consegui salvar o quadro'); });
  if(now) return go(); s.saveT=setTimeout(go, 400);
}
async function qdLoad(s){
  if(s.doc || s.loading) return; s.loading=true;
  try{ s.doc=qdDoc(await invoke('quadro_read', { id:s.id }), s.id);
    if(s.doc.bg){ try{ s.bgUrl=await invoke('quadro_asset_url', { id:s.id, path:s.doc.bg }); }catch(_){ s.bgUrl=null; } } }
  catch(e){ s.err={ msg:(typeof humanErr==='function'?humanErr(e,'Não consegui abrir o quadro').msg:String(e&&e.message||e)), load:true }; }
  finally{ s.loading=false; }
}

// ---------- tela (aba do canvas) ----------
function qdTaskOpts(sel){
  const ts=((typeof state!=='undefined'&&state&&state.tasks)||[]).slice(-30).reverse();
  return `<option value="">nenhuma (quadro livre)</option>`+ts.map(t=>`<option value="${qdEsc(t.id)}"${t.id===sel?' selected':''}>${qdEsc(String(t.title||t.id).slice(0,60))}</option>`).join('')
    +(sel&&!ts.some(t=>t.id===sel)?`<option value="${qdEsc(sel)}" selected>${qdEsc(sel)}</option>`:'');
}
function qdShellHtml(s){
  return `<div class="qd" data-qd="${qdEsc(s.id)}">
  <div class="qd-top"><b class="qd-title"></b><label class="qd-link"><span>demanda</span><select class="qd-tsel" aria-label="demanda ligada ao quadro"></select></label><span class="qd-sp"></span><span class="qd-bgbtns"><button type="button" class="qd-ctl" data-qd-act="bg" title="colar (⌘V), arrastar pro quadro ou escolher um arquivo">Usar um print como fundo</button><button type="button" class="qd-ctl" data-qd-act="previa" hidden title="o print da Prévia da demanda ligada">Print da Prévia</button><button type="button" class="qd-ctl" data-qd-act="nobg" hidden>tirar o fundo</button></span><span class="qd-live off" role="status"><i aria-hidden="true"></i><span class="qd-livetx">pronto</span></span></div>
  <div class="qd-wrap">
    <div class="qd-col">
      <div class="qd-board" aria-label="quadro onde a IA desenha">
        <svg class="qd-svg" viewBox="0 0 1000 600" role="img" aria-label="desenho da explicação"><g class="qd-bg"></g><g class="qd-marks"></g><g class="qd-draw"></g><g class="qd-mine"></g></svg>
        <div class="qd-cap" hidden></div>
        <div class="qd-over" hidden></div>
      </div>
      <div class="qd-bar">
        <button type="button" class="qd-ctl qd-pen" aria-pressed="false" title="risque por cima e pergunte sobre o que marcou">✎ Sua caneta</button>
        <button type="button" class="qd-ctl" data-qd-act="clearmine">apagar meus traços</button>
        <span class="qd-sp"></span>
        <button type="button" class="qd-ctl qd-play" aria-label="pausar">❚❚</button>
        <button type="button" class="qd-ctl" data-qd-act="again" title="desenha de novo, do começo">↺ de novo</button>
        <button type="button" class="qd-ctl qd-speed" aria-label="velocidade">1×</button>
        <input type="file" class="qd-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
    </div>
    <aside class="qd-side">
      <div class="qd-card"><h2>O que a IA está dizendo</h2><ol class="qd-tr" aria-live="polite"></ol><p class="qd-note qd-trempty">Quando ela começar a desenhar, cada fala aparece aqui.</p></div>
      <div class="qd-card qd-offer" hidden><h2 class="qd-offh">Mudanças desenhadas</h2><ol class="qd-chg"></ol><div class="qd-row"><button type="button" class="btn primary sm" data-qd-act="apply">Aplicar no código</button><button type="button" class="btn sm" data-qd-act="adjust">Ajustar o desenho</button></div><p class="qd-note qd-offnote"></p></div>
      <div class="qd-card"><h2 class="qd-askh">O que desenhar?</h2>
        <form class="qd-ask"><label class="qd-sr" for="qdq-${qdEsc(s.id)}">pedido ou pergunta pra IA</label><textarea id="qdq-${qdEsc(s.id)}" class="qd-q" rows="2" placeholder="ex.: por que o checkout da loja-web perde o cupom?"></textarea><button type="submit" class="btn primary sm qd-go">Desenhar</button></form>
        <p class="qd-note qd-asknote"></p>
        <div class="qd-row"><button type="button" class="btn sm ghost" data-qd-act="redo" hidden>Desenhar de novo</button></div>
      </div>
      <div class="qd-card"><h2>Guardar</h2><div class="qd-row qd-wrap2"><button type="button" class="btn sm" data-qd-act="artifact">Salvar como artefato</button><button type="button" class="btn sm" data-qd-act="attach">Anexar na conversa</button></div><p class="qd-note qd-savenote"></p></div>
    </aside>
  </div></div>`;
}
/** a aba do quadro (58-canvas chama a cada troca/re-render; monta UMA vez e só atualiza) */
function qdRender(tab, body){
  const id=tab&&tab.ref; if(!qdIdOk(id)){ body.innerHTML='<div class="cvempty"><b>Quadro inválido</b><span>Feche esta aba.</span></div>'; return; }
  const s=qdS(id);
  if(!s.root || !body.contains(s.root)){
    body.__html=''; body.innerHTML=qdShellHtml(s); s.root=body.querySelector('.qd'); qdWire(s);
    if(s.doc) qdAfterShell(s);
    else { qdPaintAll(s); qdLoad(s).then(()=>{ if(s.root && s.root.isConnected) qdAfterShell(s); }); }
    return;
  }
  qdPaintAll(s);
}
window.qdRender=qdRender;
function qdAfterShell(s){
  qdPaintAll(s); qdBgPaint(s);
  if(s.doc && s.doc.steps.length && !s.busy) qdPlay(s, { instant:true });
  else qdMinePaint(s);
}
function qdQ(s, sel){ return s.root?s.root.querySelector(sel):null; }
function qdPaintAll(s){
  if(!s.root) return; const d=s.doc;
  const ttl=qdQ(s,'.qd-title'); if(ttl) ttl.textContent=d?(d.title||'Quadro novo'):'abrindo o quadro…';
  const sel=qdQ(s,'.qd-tsel'); if(sel && d && sel.__sig!==(d.taskId||'')+'|'+((typeof state!=='undefined'&&state.tasks)||[]).length){ sel.__sig=(d.taskId||'')+'|'+((typeof state!=='undefined'&&state.tasks)||[]).length; sel.innerHTML=qdTaskOpts(d.taskId); }
  const has=!!(d && d.steps.length);
  const askh=qdQ(s,'.qd-askh'); if(askh) askh.textContent=has?'Pergunte, ela desenha':'O que desenhar?';
  const go=qdQ(s,'.qd-go'); if(go){ go.disabled=!d || s.busy; go.textContent=s.busy?'desenhando…':'Desenhar'; }
  const q=qdQ(s,'.qd-q'); if(q && !q.value && d && !has && d.prompt && !s.busy && !q.__filled){ q.value=d.prompt; q.__filled=1; }
  if(q) q.placeholder=has?(d.mine.length?'pergunte sobre o que você marcou…':'ex.: por que essa seta vai pra lá?'):'ex.: por que o checkout da loja-web perde o cupom?';
  const an=qdQ(s,'.qd-asknote'); if(an) an.textContent=s.note||(has?(d.mine.length?'Ela responde sobre o que você riscou, desenhando ali — os traços novos são acrescentados.':'Risque com ✎ Sua caneta pra perguntar sobre um ponto, ou pergunte sobre o desenho todo.'):'Escreva o que quer ver explicado. Pra revisar uma tela, use um print como fundo (⌘V também funciona).');
  const redo=qdQ(s,'[data-qd-act="redo"]'); if(redo) redo.hidden=!has || s.busy || !d.prompt;
  const pen=qdQ(s,'.qd-pen'); if(pen){ pen.setAttribute('aria-pressed', String(!!s.penOn)); }
  const brd=qdQ(s,'.qd-board'); if(brd) brd.classList.toggle('drawing', !!s.penOn);
  const cm=qdQ(s,'[data-qd-act="clearmine"]'); if(cm) cm.disabled=!(d && d.mine.length);
  const pb=qdQ(s,'.qd-play'); if(pb){ pb.textContent=s.paused?'▶':'❚❚'; pb.setAttribute('aria-label', s.paused?'continuar':'pausar'); }
  const sp=qdQ(s,'.qd-speed'); if(sp) sp.textContent=qdSpeedLabel(s.speed);
  const nb=qdQ(s,'[data-qd-act="nobg"]'); if(nb) nb.hidden=!(d && d.bg);
  const pv=qdQ(s,'[data-qd-act="previa"]'); if(pv) pv.hidden=!qdPreviaOk(s);
  const t=d&&qdTask(d.taskId);
  const sn=qdQ(s,'.qd-savenote'); if(sn) sn.textContent=t?'Vai pra lista de artefatos de “'+t.title+'” (SVG + PNG). Anexar põe o PNG na próxima mensagem da conversa.':'Ligue o quadro a uma demanda (lá em cima) pra salvar como artefato ou anexar na conversa. O quadro em si já se salva sozinho.';
  ['artifact','attach'].forEach(k=>{ const b=qdQ(s,`[data-qd-act="${k}"]`); if(b) b.disabled=!t || !has || s.busy; });
  qdOverPaint(s); qdOfferPaint(s);
}
function qdOverPaint(s){
  const o=qdQ(s,'.qd-over'); if(!o) return; const d=s.doc;
  let h='';
  if(s.err) h=`<div class="qd-msg err" role="alert"><b>${s.err.load?'Não abriu o quadro':'A IA não conseguiu desenhar'}</b><span>${qdEsc(s.err.msg)}</span>${s.err.load?'':'<button type="button" class="btn sm" data-qd-act="retry">tentar de novo</button>'}</div>`;
  else if(s.busy) h=`<div class="qd-msg"><b><span class="spin" aria-hidden="true"></span> a IA está pensando o desenho…</b>${s.acts.length?`<ul class="qd-acts">${s.acts.slice(-3).map(a=>`<li>${qdEsc(String(a).slice(0,120))}</li>`).join('')}</ul>`:'<span>ela lê o que precisa e devolve os traços; o desenho começa em seguida</span>'}<button type="button" class="btn sm ghost" data-qd-act="stop">parar</button></div>`;
  else if(!d) h=s.loading||!s.err?'<div class="qd-msg"><span>abrindo o quadro…</span></div>':'';
  else if(!d.steps.length && !d.bg) h=`<div class="qd-msg ghost"><b>Quadro em branco</b><span>Escreva ao lado o que você quer ver explicado — a IA escolhe a forma (trilho, linha de montagem, balança, antes × depois…) e desenha enquanto fala.</span></div>`;
  o.hidden=!h; if(o.__h!==h){ o.__h=h; o.innerHTML=h; }
}
function qdOfferPaint(s){
  const c=qdQ(s,'.qd-offer'); if(!c) return; const d=s.doc;
  const on=!!(d && d.bg && d.changes.length && s.done && !s.busy);
  c.hidden=!on; if(!on) return;
  const h=qdQ(s,'.qd-offh'); if(h) h.textContent=d.changes.length+(d.changes.length===1?' mudança desenhada':' mudanças desenhadas');
  const l=qdQ(s,'.qd-chg'); const lh=d.changes.map(x=>`<li>${qdEsc(x)}</li>`).join(''); if(l && l.__h!==lh){ l.__h=lh; l.innerHTML=lh; }
  const t=qdTask(d.taskId); const n=qdQ(s,'.qd-offnote');
  if(n && !n.__set) n.textContent=t?'Aplicar vira um pedido de alteração em “'+t.title+'”, com o desenho anexado como PNG.':'Aplicar abre uma Nova demanda com o desenho anexado como referência.';
}
function qdSetLive(s, on, tx){ const l=qdQ(s,'.qd-live'); if(!l) return; l.classList.toggle('off', !on); const t=qdQ(s,'.qd-livetx'); if(t) t.textContent=tx||(on?'desenhando':'pronto · ↺ pra ver de novo'); }

// ---------- fundo (revisar layout) ----------
function qdBgPaint(s){
  const g=qdQ(s,'.qd-bg'); if(!g) return;
  const want=(s.doc&&s.doc.bg&&s.bgUrl)?s.bgUrl:'';
  if(g.__u===want) return; g.__u=want; g.innerHTML='';
  if(want) g.appendChild(qdEl('image', { href:want, x:0, y:0, width:QD_W, height:QD_H, preserveAspectRatio:'xMidYMid meet' }));
}
function qdFileToUrl(f){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result)); r.onerror=rej; r.readAsDataURL(f); }); }
async function qdSetBg(s, dataUrl, ext){
  if(!s.doc || !dataUrl) return;
  const name='fundo-'+Date.now().toString(36)+'.'+(ext||'png');
  try{ await qdSave(s, true); s.doc.bg=await invoke('quadro_asset_put', { id:s.id, name, base64:String(dataUrl).replace(/^data:[^,]*,/,'') }); s.bgUrl=dataUrl; qdSave(s); qdBgPaint(s); qdPaintAll(s);
    if(typeof toast==='function') toast(s.doc.steps.length?'Fundo trocado. Peça pra IA revisar ali do lado.':'Fundo pronto. Diga o que revisar (ou só “revise esta tela”) e clique em Desenhar.','ok');
    const q=qdQ(s,'.qd-q'); if(q){ if(!q.value.trim() && !s.doc.steps.length) q.value='Revise esta tela e desenhe por cima o que você mudaria.'; q.focus(); } }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui usar a imagem como fundo'); }
}
async function qdBgFromFile(s, f){
  if(!f || !/^image\/(png|jpe?g|webp|gif)$/.test(f.type||'')){ if(typeof toast==='function') toast('Use uma imagem PNG, JPG, WEBP ou GIF.','warn'); return; }
  if(f.size>15*1024*1024){ if(typeof toast==='function') toast('Imagem grande demais (máx. 15 MB).','warn'); return; }
  const ext=(f.type.split('/')[1]||'png').replace('jpeg','jpg'); await qdSetBg(s, await qdFileToUrl(f), ext);
}
function qdPreviaOk(s){ const d=s.doc; if(!d||!d.taskId||typeof nvSt!=='function'||typeof nvSnap!=='function'||typeof nvShotRect!=='function') return false; try{ const st=nvSt(d.taskId); return !!(st&&st.frame&&st.frame.isConnected); }catch(_){ return false; } }
async function qdBgFromPrevia(s){
  const d=s.doc; if(!qdPreviaOk(s)){ if(typeof toast==='function') toast('Abra a Prévia da demanda (⌘4) primeiro — o print sai dela.','info'); return; }
  try{ const st=nvSt(d.taskId); const fr=st.frame.getBoundingClientRect();
    const rect=nvShotRect({ left:Math.max(0,fr.left), top:Math.max(0,fr.top), right:Math.min(innerWidth,fr.right), bottom:Math.min(innerHeight,fr.bottom) }, { x:0, y:0, w:fr.width, h:fr.height });
    const r=rect?await nvSnap(d.taskId, rect, 'attachment', { text:'quadro', tag:'previa' }):null;
    if(r && r.dataUrl) await qdSetBg(s, r.dataUrl, 'png'); else if(typeof toast==='function') toast('Não consegui tirar o print da Prévia agora.','warn'); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui tirar o print da Prévia'); }
}

// ---------- motor: toca os passos um a um (do mock) ----------
function qdSleep(s, ms){ return new Promise(r=>setTimeout(r, ms/(s.speed||1))); }
async function qdGate(s, id){ while(s.paused && id===s.run) await new Promise(r=>s.wake=r); return id===s.run; }
function qdPenAt(s, x, y){
  const svg=qdQ(s,'.qd-svg'); if(!svg) return;
  if(!s.pen){ s.pen=qdEl('g', { class:'qd-tip', 'aria-hidden':'true' }); s.pen.appendChild(qdEl('circle', { r:7, class:'qd-tip-o' })); s.pen.appendChild(qdEl('circle', { r:2.5, class:'qd-tip-i' })); }
  svg.appendChild(s.pen); s.pen.setAttribute('transform', `translate(${qdF(x)} ${qdF(y)})`);
}
function qdPenOff(s){ if(s.pen){ s.pen.remove(); s.pen=null; } }
function qdPath(d, w, color){ const p=qdEl('path', { d, fill:'none', 'stroke-width':w, 'stroke-linecap':'round', 'stroke-linejoin':'round' }); p.style.stroke=`var(--qd-${color||'ink'})`; return p; }
function qdTextEl(t){ const e=qdEl('text', { x:qdF(t.x), y:qdF(t.y), 'font-size':t.size, 'font-weight':700, class:'qd-hand' }); e.style.fill=`var(--qd-${t.color||'ink'})`; return e; }
async function qdStroke(s, layer, d, w, color, id, anim){
  const p=qdPath(d, w, color); layer.appendChild(p); if(!anim) return;
  let L=0; try{ L=p.getTotalLength(); }catch(_){ return; } if(!(L>0)) return;
  p.style.strokeDasharray=L; p.style.strokeDashoffset=L;
  const dur=Math.max(140, Math.min(900, L*2.2))/(s.speed||1); let t0=null;
  await new Promise(res=>{ const f=now=>{ if(id!==s.run || !p.isConnected){ p.style.strokeDasharray=''; p.style.strokeDashoffset=''; return res(); }
      if(s.paused){ t0=null; requestAnimationFrame(f); return; } if(t0==null) t0=now-(p.__k||0)*dur;
      const k=Math.min(1,(now-t0)/dur), e=1-Math.pow(1-k,2); p.__k=k; p.style.strokeDashoffset=L*(1-e);
      try{ const pt=p.getPointAtLength(L*e); qdPenAt(s, pt.x, pt.y); }catch(_){ }
      if(k<1) requestAnimationFrame(f); else { p.style.strokeDasharray=''; p.style.strokeDashoffset=''; res(); } };
    requestAnimationFrame(f); });
}
async function qdWrite(s, layer, t, id, anim){
  const e=qdTextEl(t); layer.appendChild(e);
  if(!anim){ e.textContent=t.s; return; }
  for(let i=1;i<=t.s.length;i++){ if(!await qdGate(s, id)){ e.textContent=t.s; return; } e.textContent=t.s.slice(0,i); try{ const b=e.getBBox(); qdPenAt(s, b.x+b.width, b.y+b.height*.7); }catch(_){ } await qdSleep(s, 28); }
}
function qdCap(s, tx){ const c=qdQ(s,'.qd-cap'); if(!c) return; if(tx==null){ c.hidden=true; return; } c.textContent=tx; c.hidden=false; }
function qdTrAdd(s, label, tx, cls){
  const tr=qdQ(s,'.qd-tr'); if(!tr) return; tr.querySelectorAll('li.now').forEach(x=>x.classList.remove('now'));
  const li=document.createElement('li'); li.className='now'+(cls?' '+cls:''); const sp=document.createElement('span'); sp.textContent=label; li.appendChild(sp); li.appendChild(document.createTextNode(tx)); tr.appendChild(li); tr.scrollTop=tr.scrollHeight;
  const em=qdQ(s,'.qd-trempty'); if(em) em.hidden=true;
}
/** desenha os passos. o.from = a partir de qual passo ANIMA (os anteriores aparecem prontos); o.instant = tudo pronto */
async function qdPlay(s, o){
  o=o||{}; if(!s.root || !s.doc) return;
  const id=++s.run; s.done=false; if(s.wake){ const w=s.wake; s.wake=null; w(); }
  const draw=qdQ(s,'.qd-draw'), marks=qdQ(s,'.qd-marks'), tr=qdQ(s,'.qd-tr'); if(!draw) return;
  draw.innerHTML=''; marks.innerHTML=''; if(tr) tr.innerHTML=''; qdPenOff(s); qdCap(s, null);
  { const em=qdQ(s,'.qd-trempty'); if(em) em.hidden=s.doc.steps.some(x=>x.say!=null||x.ask!=null); }
  qdBgPaint(s); qdMinePaint(s);
  const red=qdReduce(), from=o.instant?Infinity:(o.from|0);
  qdSetLive(s, !o.instant && !red); qdOfferPaint(s);
  let n=0;
  const steps=s.doc.steps;
  for(let i=0;i<steps.length;i++){
    const st=steps[i]; const anim=!red && i>=from;
    if(anim && !await qdGate(s, id)) return;
    if(id!==s.run) return;
    if(st.say!=null){ n++; qdTrAdd(s, String(n).padStart(2,'0'), st.say); if(anim){ qdCap(s, st.say); await qdSleep(s, qdSayMs(st.say)); } continue; }
    if(st.ask!=null){ qdTrAdd(s, 'você', st.ask, 'you'); if(anim) qdCap(s, 'você: '+st.ask); continue; }
    const sh=qdShapes(st, i);
    for(const m of sh.marks){ const r=qdEl('rect', { x:m[0], y:m[1], width:m[2], height:m[3], rx:6 }); r.style.fill='var(--qd-mark)'; marks.appendChild(r); if(anim) await qdSleep(s, 300); }
    for(const dt of sh.dots){ const c=qdEl('circle', { cx:dt.x, cy:dt.y, r:8 }); c.style.fill=`var(--qd-${dt.color})`; draw.appendChild(c); if(anim) await qdSleep(s, 120); }
    for(const k of sh.strokes){ if(anim && !await qdGate(s, id)) return; await qdStroke(s, draw, k.d, k.w, k.color, id, anim); }
    for(const t of sh.texts){ await qdWrite(s, draw, t, id, anim); }
  }
  if(id!==s.run) return;
  qdPenOff(s); s.done=true; qdSetLive(s, false); qdOfferPaint(s); qdPaintAll(s);
  if(!o.instant && !red) setTimeout(()=>{ if(id===s.run) qdCap(s, null); }, 2500/(s.speed||1));
}

// ---------- a SUA caneta ----------
function qdMinePaint(s){
  const g=qdQ(s,'.qd-mine'); if(!g || !s.doc) return; g.innerHTML='';
  for(const pts of s.doc.mine){ const p=qdEl('path', { d:qdMinePath(pts), fill:'none', 'stroke-width':3.5, 'stroke-linecap':'round', 'stroke-linejoin':'round' }); p.style.stroke='var(--qd-pen)'; g.appendChild(p); }
}
function qdToSvg(svg, e){ const r=svg.getBoundingClientRect(); if(!r.width) return [0,0];
  // viewBox 1000×600 com preserveAspectRatio padrão (meet, centralizado): converte pela escala menor
  const k=Math.min(r.width/QD_W, r.height/QD_H), ox=(r.width-QD_W*k)/2, oy=(r.height-QD_H*k)/2;
  return [qdR(qdClamp((e.clientX-r.left-ox)/k,0,QD_W)), qdR(qdClamp((e.clientY-r.top-oy)/k,0,QD_H))]; }
function qdSetPen(s, on){ s.penOn=!!on; qdPaintAll(s); }
function qdWirePen(s){
  const svg=qdQ(s,'.qd-svg'); let cur=null, el=null;
  svg.addEventListener('pointerdown', e=>{ if(!s.penOn || !s.doc) return; e.preventDefault(); try{ svg.setPointerCapture(e.pointerId); }catch(_){ }
    cur=[qdToSvg(svg, e)]; el=qdEl('path', { d:qdMinePath(cur), fill:'none', 'stroke-width':3.5, 'stroke-linecap':'round', 'stroke-linejoin':'round' }); el.style.stroke='var(--qd-pen)'; qdQ(s,'.qd-mine').appendChild(el); });
  svg.addEventListener('pointermove', e=>{ if(!cur) return; const p=qdToSvg(svg, e); const l=cur[cur.length-1]; if(Math.hypot(p[0]-l[0],p[1]-l[1])<1.5 || cur.length>=1500) return; cur.push(p); el.setAttribute('d', qdMinePath(cur)); });
  const stop=()=>{ if(!cur) return; if(s.doc.mine.length<200) s.doc.mine.push(cur); cur=null; el=null; qdSave(s); s.note='Agora pergunte sobre o que você marcou — ela responde desenhando ali.'; qdPaintAll(s); const q=qdQ(s,'.qd-q'); if(q) q.focus(); };
  svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop);
}

// ---------- a IA ----------
async function qdRun(prompt, s){
  let un=null;
  try{ if(window.__TAURI__&&window.__TAURI__.event) un=await window.__TAURI__.event.listen('quadro-ai-activity-desenhar', ev=>{ const l=ev&&ev.payload&&ev.payload.line; if(l){ s.acts.push(String(l)); if(s.acts.length>20) s.acts.shift(); qdOverPaint(s); } }); }catch(_){ }
  const t=qdTask(s.doc.taskId);
  try{ const r=await invoke('quadro_ai', { kind:'desenhar', prompt, repo:(t&&t.worktree)||null, model:qdModel() }); return (r&&r.text!=null)?r.text:String(r||''); }
  finally{ try{ if(typeof un==='function') un(); }catch(_){ } }
}
function qdStopped(e){ return /_STOPPED\b/.test(String((e&&e.message)||e||'')); }
function qdErrMsg(e){ const h=typeof humanErr==='function'?humanErr(e):null; if(h && h.id!=='generic' && h.msg) return h.msg; return String((e&&e.message)||e||'erro sem detalhe').replace(/^Error:\s*/,'').split('\n')[0].slice(0,240); }
function qdBgAbs(s){ const r=qdRepo(); return (s.doc&&s.doc.bg&&r)?r+'/.cardume/quadros/'+s.id+'/'+s.doc.bg:(s.doc&&s.doc.bg?'.cardume/quadros/'+s.id+'/'+s.doc.bg:''); }
async function qdCtx(taskId){
  const t=qdTask(taskId); if(!t) return '';
  const c={ title:t.title, status:t.status, branch:t.branch, objective:t.objective, requirements:Array.isArray(t.requirements)?t.requirements:[], proofs:[], files:[], talk:[] };
  try{ const rp=(typeof reqProofCache!=='undefined')?reqProofCache[t.id]:null; const list=rp&&Array.isArray(rp.list)?rp.list:null;
    if(list && typeof matchReqProofs==='function') c.proofs=matchReqProofs(c.requirements, list).map(m=>m?{ status:m.status, evidence:m.evidence||[] }:null); }catch(_){ }
  try{ c.files=(await (typeof invokeQuiet==='function'?invokeQuiet:invoke)('task_files', { taskId:t.id }))||[]; }catch(_){ c.files=[]; }
  try{ const evs=(typeof eventsOf==='function')?eventsOf(t.id):[];
    c.talk=evs.filter(e=>e && e.text && ((typeof evIsUserMsg==='function'&&evIsUserMsg(e)) || (['think','note','done'].includes(e.type) && !e.tool && !(typeof looksLikeTool==='function'&&looksLikeTool(e.text)))))
      .slice(-10).map(e=>({ who:(typeof evIsUserMsg==='function'&&evIsUserMsg(e))?'Você':(e.agent||'agente'), text:(typeof evUserText==='function'&&evIsUserMsg(e))?evUserText(e.text):e.text })); }catch(_){ }
  return qdTaskCtx(c);
}
/** desenho NOVO (substitui os passos; o fundo e a caneta ficam) */
async function qdDraw(s, req){
  if(!s.doc || s.busy) return; req=String(req||'').trim(); if(!req && !s.doc.bg){ const q=qdQ(s,'.qd-q'); if(q) q.focus(); return; }
  s.busy=true; s.err=null; s.acts=[]; s.note=''; s.doc.prompt=req||s.doc.prompt; qdSetPen(s, false); qdSetLive(s, true, 'pensando o desenho…'); qdPaintAll(s);
  try{
    const ctx=await qdCtx(s.doc.taskId);
    const text=await qdRun(qdPromptDesenhar(req||'Revise esta tela e desenhe por cima o que você mudaria.', { ctx, bgPath:qdBgAbs(s), project:qdRepo()?qdRepo().split('/').pop():'' }), s);
    const r=qdParse(text);
    s.doc.steps=r.steps; s.doc.changes=r.changes; if(r.title) s.doc.title=r.title; else if(!s.doc.title) s.doc.title=qdStr(req,60);
    { const q=qdQ(s,'.qd-q'); if(q) q.value=''; }
    s.busy=false; qdSave(s); qdRetitle(s); qdPaintAll(s); qdPlay(s, { from:0 });
  }catch(e){ s.busy=false; if(!qdStopped(e)) s.err={ msg:qdErrMsg(e), retry:()=>qdDraw(s, req) }; qdSetLive(s, false, s.err?'não deu':'parado'); qdPaintAll(s); }
}
/** pergunta (com ou sem os traços da pessoa): os passos da resposta são ACRESCENTADOS */
async function qdAsk(s, q){
  if(!s.doc || s.busy) return; q=String(q||'').trim(); if(!q) return;
  const info=qdMineInfo(s.doc.mine, s.doc.steps);
  s.busy=true; s.err=null; s.acts=[]; s.note=''; qdSetPen(s, false); qdSetLive(s, true, 'pensando a resposta…'); qdPaintAll(s);
  try{
    const ctx=await qdCtx(s.doc.taskId);
    const text=await qdRun(qdPromptPergunta(q, info, s.doc.steps, { ctx, bgPath:qdBgAbs(s) }), s);
    const r=qdParse(text, { max:Math.max(1, Math.min(40, 600-s.doc.steps.length)) });
    const from=s.doc.steps.length;
    s.doc.steps=s.doc.steps.concat([{ ask:qdStr(q,300) }], r.steps);
    if(r.changes.length) s.doc.changes=s.doc.changes.concat(r.changes).slice(0,12);
    s.doc.history.push({ q:qdStr(q,300), at:Date.now(), from, to:s.doc.steps.length });
    s.busy=false; qdSave(s); qdPaintAll(s); qdPlay(s, { from });
  }catch(e){ s.busy=false; if(!qdStopped(e)) s.err={ msg:qdErrMsg(e), retry:()=>qdAsk(s, q) }; qdSetLive(s, false, s.err?'não deu':'parado'); qdPaintAll(s); }
}
function qdRetitle(s){ try{ const tab=(typeof TABS!=='undefined'?TABS:[]).find(t=>t.kind==='quadro' && t.ref===s.id); if(tab){ tab.title=qdTitleOf(tab).slice(0,28); if(typeof renderTabs==='function') renderTabs(); } }catch(_){ } }

// ---------- exportar (SVG + PNG com as cores do tema resolvidas) ----------
/** desenho COMPLETO num SVG fora da tela (mesmas classes → mesmas cores do tema, resolvidas em valores pro arquivo se
 *  abrir sozinho). o.bg=false: sem papel nem print de fundo (a camada de cima do PNG). Exporta até no meio da animação. */
function qdSvgString(s, o){
  o=o||{}; if(!s.root || !s.doc) return '';
  const tmp=qdEl('svg', { viewBox:'0 0 1000 600', width:1000, height:600, class:'qd-svg' }); tmp.style.cssText='position:absolute;left:-99999px;top:0;width:1000px;height:600px';
  s.root.appendChild(tmp);
  try{
    if(o.bg!==false){ const bgR=qdEl('rect', { x:0, y:0, width:QD_W, height:QD_H }); bgR.style.fill='var(--qd-paper)'; tmp.appendChild(bgR);
      if(s.doc.bg && s.bgUrl) tmp.appendChild(qdEl('image', { href:s.bgUrl, x:0, y:0, width:QD_W, height:QD_H, preserveAspectRatio:'xMidYMid meet' })); }
    s.doc.steps.forEach((st,i)=>{ qdShapes(st,i).marks.forEach(m=>{ const r=qdEl('rect', { x:m[0], y:m[1], width:m[2], height:m[3], rx:6 }); r.style.fill='var(--qd-mark)'; tmp.appendChild(r); }); });
    s.doc.steps.forEach((st,i)=>{ const sh=qdShapes(st,i);
      sh.dots.forEach(dt=>{ const c=qdEl('circle', { cx:dt.x, cy:dt.y, r:8 }); c.style.fill=`var(--qd-${dt.color})`; tmp.appendChild(c); });
      sh.strokes.forEach(k=>tmp.appendChild(qdPath(k.d, k.w, k.color)));
      sh.texts.forEach(t=>{ const e=qdTextEl(t); e.textContent=t.s; tmp.appendChild(e); }); });
    s.doc.mine.forEach(pts=>{ const p=qdEl('path', { d:qdMinePath(pts), fill:'none', 'stroke-width':3.5, 'stroke-linecap':'round', 'stroke-linejoin':'round' }); p.style.stroke='var(--qd-pen)'; tmp.appendChild(p); });
    tmp.querySelectorAll('*').forEach(el=>{ const cs=getComputedStyle(el);
      if(el.style.stroke) el.setAttribute('stroke', cs.stroke); if(el.style.fill) el.setAttribute('fill', cs.fill);
      el.removeAttribute('style'); if(el.tagName==='text'){ el.setAttribute('font-family', QD_HAND); el.removeAttribute('class'); } });
    tmp.removeAttribute('style'); tmp.removeAttribute('class'); tmp.setAttribute('xmlns', QD_NS);
    return new XMLSerializer().serializeToString(tmp);
  } finally { tmp.remove(); }
}
function qdImg(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('não consegui gerar o PNG do desenho')); i.src=src; }); }
/** PNG 2000×1200: papel → print de fundo (contido, centralizado) → traços. O fundo vai direto no canvas (um SVG com
 *  imagem dentro pode "sujar" o canvas no WebKit e travar o toDataURL). */
async function qdPng(s){
  const c=document.createElement('canvas'); c.width=2000; c.height=1200; const g=c.getContext('2d');
  g.fillStyle=getComputedStyle(s.root).getPropertyValue('--qd-paper').trim()||getComputedStyle(document.documentElement).getPropertyValue('--qd-paper').trim()||'white'; g.fillRect(0,0,2000,1200);
  if(s.doc.bg && s.bgUrl){ try{ const im=await qdImg(s.bgUrl); const k=Math.min(2000/im.width, 1200/im.height), w=im.width*k, h=im.height*k; g.drawImage(im,(2000-w)/2,(1200-h)/2,w,h); }catch(_){ } }
  const top=await qdImg('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qdSvgString(s, { bg:false })));
  g.drawImage(top,0,0,2000,1200);
  return c.toDataURL('image/png');
}
async function qdExport(s){ const svg=qdSvgString(s); if(!svg) throw new Error('o quadro não está aberto'); return { svg, png:await qdPng(s) }; }
function qdSlug(s){ return (String(s||'quadro').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40))||'quadro'; }
async function qdSaveArtifact(s){
  const t=qdTask(s.doc&&s.doc.taskId); if(!t) return;
  try{ const x=await qdExport(s); const r=await invoke('quadro_export', { id:s.id, taskId:t.id, svg:x.svg, png:x.png.replace(/^data:[^,]*,/,'') });
    if(typeof artifactsCache!=='undefined') delete artifactsCache[t.id]; if(typeof fwInvalidate==='function') fwInvalidate(t.id);
    if(typeof toast==='function') toast('Salvo nos artefatos de “'+t.title+'”: '+((r&&r.png)||'quadro.png'),'ok'); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui salvar o desenho como artefato'); }
}
/** PNG do desenho → anexo da tarefa (.cardume/refs) — volta o Attachment pronto pro compositor */
async function qdPngAttachment(s, taskId){
  const x=await qdExport(s);
  return invoke('import_attachment_data', { name:'quadro-'+qdSlug(s.doc.title)+'.png', dataB64:x.png.replace(/^data:[^,]*,/,''), taskId:taskId||null });
}
async function qdAttach(s){
  const t=qdTask(s.doc&&s.doc.taskId); if(!t) return;
  try{ const a=await qdPngAttachment(s, t.id); if(!a) return;
    if(typeof fwPend!=='undefined'){ (fwPend[t.id]=fwPend[t.id]||[]).push(a); }
    if(typeof toast==='function') toast('Desenho anexado na próxima mensagem de “'+t.title+'”.','ok', { label:'abrir a conversa', fn:()=>{ if(typeof openWorkspace==='function') openWorkspace(t.id); } }); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui anexar o desenho'); }
}
async function qdApply(s){
  const d=s.doc; if(!d) return; const t=qdTask(d.taskId);
  if(t){
    const n=d.changes.length;
    if(typeof askYes==='function' && !await askYes('Mandar '+(n?n+(n===1?' mudança':' mudanças'):'o desenho')+' pro agente de “'+t.title+'”?\n\nVira um pedido de alteração na conversa da tarefa, com o desenho anexado como PNG. O agente começa a mexer no código.')) return;
    try{ const a=await qdPngAttachment(s, t.id);
      const msg=qdApplyText(d)+(typeof attPromptBlock==='function'&&a?attPromptBlock([a]):'');
      const ok=typeof fwSendText==='function'?await fwSendText(t.id, msg):false;
      if(ok){ const n2=qdQ(s,'.qd-offnote'); if(n2){ n2.__set=1; n2.textContent='Mandado pro agente de “'+t.title+'”. Acompanhe na conversa da tarefa.'; }
        if(typeof toast==='function') toast('Pedido de alteração enviado com o desenho.','ok', { label:'abrir a tarefa', fn:()=>{ if(typeof openWorkspace==='function') openWorkspace(t.id); } }); }
      else if(typeof toast==='function') toast('Não deu pra mandar agora — o desenho foi anexado; mande pela conversa da tarefa.','warn'); }
    catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui mandar o pedido de alteração'); }
    return;
  }
  // sem tarefa: nova demanda com o desenho como referência
  try{ const x=await qdExport(s); const rel=await invoke('quadro_asset_put', { id:s.id, name:'desenho-'+Date.now().toString(36)+'.png', base64:x.png.replace(/^data:[^,]*,/,'') });
    const abs=(qdRepo()?qdRepo()+'/':'')+'.cardume/quadros/'+s.id+'/'+rel;
    if(typeof ntOpenFormTab!=='function' || !await ntOpenFormTab()){ if(typeof toast==='function') toast('A Nova demanda não abriu agora — tente de novo.','warn'); return; }
    if(typeof setNtMode==='function') setNtMode('build');
    const ti=$id('ntTitle'), ob=$id('ntObj'); if(ti) ti.value=('Revisão: '+(d.title||'layout')).slice(0,80); if(ob) ob.value=qdApplyText(d);
    if(typeof ntReq!=='undefined'){ ntReq=d.changes.slice(); if(typeof renderNtList==='function') renderNtList('ntRequirements', ntReq); }
    if(typeof ntRefs!=='undefined'){ ntRefs=[abs]; if(typeof renderNtRefs==='function') renderNtRefs(); }
    if(typeof ntMarkBase==='function') ntMarkBase();
    if(typeof toast==='function') toast('Nova demanda montada com o desenho e '+d.changes.length+' “Pronto quando”.','ok'); }
  catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui montar a demanda a partir do desenho'); }
}

// ---------- ligações ----------
function qdWire(s){
  const r=s.root;
  qdWirePen(s);
  r.addEventListener('click', async e=>{
    const pen=e.target.closest('.qd-pen'); if(pen){ qdSetPen(s, !s.penOn); return; }
    if(e.target.closest('.qd-play')){ s.paused=!s.paused; if(!s.paused && s.wake){ const w=s.wake; s.wake=null; w(); } qdPaintAll(s); return; }
    if(e.target.closest('.qd-speed')){ s.speed=qdSpeedNext(s.speed); qdPaintAll(s); return; }
    const b=e.target.closest('[data-qd-act]'); if(!b) return; const k=b.dataset.qdAct;
    if(k==='again'){ s.paused=false; qdPaintAll(s); if(s.doc && s.doc.steps.length) qdPlay(s, { from:0 }); }
    else if(k==='clearmine'){ if(s.doc){ s.doc.mine=[]; qdSave(s); qdMinePaint(s); s.note=''; qdPaintAll(s); } }
    else if(k==='bg'){ const f=qdQ(s,'.qd-file'); if(f) f.click(); }
    else if(k==='nobg'){ if(s.doc){ s.doc.bg=null; s.bgUrl=null; qdSave(s); qdBgPaint(s); qdPaintAll(s); } }
    else if(k==='previa') await qdBgFromPrevia(s);
    else if(k==='redo'){ if(s.doc) await qdDraw(s, s.doc.prompt); }
    else if(k==='retry'){ const f=s.err&&s.err.retry; s.err=null; qdPaintAll(s); if(f) f(); }
    else if(k==='stop'){ try{ await invoke('quadro_ai_stop', { kind:'desenhar' }); }catch(_){ } }
    else if(k==='artifact'){ b.disabled=true; await qdSaveArtifact(s); qdPaintAll(s); }
    else if(k==='attach'){ b.disabled=true; await qdAttach(s); qdPaintAll(s); }
    else if(k==='apply'){ b.disabled=true; try{ await qdApply(s); }finally{ b.disabled=false; } }
    else if(k==='adjust'){ qdSetPen(s, true); const n=qdQ(s,'.qd-offnote'); if(n){ n.__set=1; n.textContent='Caneta ligada: risque, circule ou desenhe por cima e diga o que mudar.'; } }
  });
  const f=qdQ(s,'.qd-file'); if(f) f.addEventListener('change', async ()=>{ const x=f.files&&f.files[0]; f.value=''; if(x) await qdBgFromFile(s, x); });
  const form=qdQ(s,'.qd-ask'), q=qdQ(s,'.qd-q');
  form.addEventListener('submit', e=>{ e.preventDefault(); const v=q.value.trim(); if(!s.doc || s.busy) return;
    if(!s.doc.steps.length){ qdDraw(s, v); return; } if(!v) return; q.value=''; qdAsk(s, v); });
  // ⌘↵ / Enter envia (⇧Enter quebra linha) — só neste campo
  q.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit', { cancelable:true })); } });
  const sel=qdQ(s,'.qd-tsel'); sel.addEventListener('change', ()=>{ if(!s.doc) return; s.doc.taskId=sel.value||null; const n=qdQ(s,'.qd-offnote'); if(n) n.__set=0; qdSave(s); qdPaintAll(s); });
  const brd=qdQ(s,'.qd-board');
  brd.addEventListener('dragover', e=>{ if(e.dataTransfer && [...(e.dataTransfer.types||[])].includes('Files')){ e.preventDefault(); brd.classList.add('drop'); } });
  brd.addEventListener('dragleave', ()=>brd.classList.remove('drop'));
  brd.addEventListener('drop', e=>{ brd.classList.remove('drop'); const x=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(!x) return; e.preventDefault(); qdBgFromFile(s, x); });
}
// ⌘V de imagem com um quadro à vista → vira o fundo (texto colado no campo continua normal; terminal nunca)
document.addEventListener('paste', e=>{
  const el=e.target; if(el && el.closest && el.closest('.xterm')) return;
  const items=[...((e.clipboardData&&e.clipboardData.items)||[])]; const it=items.find(x=>x.kind==='file' && /^image\//.test(x.type)); if(!it) return;
  const tab=(typeof tabById==='function'&&typeof activeTab!=='undefined')?tabById(activeTab):null;
  let root=el&&el.closest?el.closest('.qd'):null;
  if(!root && tab && tab.kind==='quadro'){ const s=QD.s[tab.ref]; root=s&&s.root; }
  if(!root || !root.isConnected) return;
  const s=QD.s[root.dataset.qd]; if(!s) return; e.preventDefault(); qdBgFromFile(s, it.getAsFile());
});

// ---------- menu "+" do canvas: Quadro novo / abrir quadro salvo ----------
async function qdMenuList(){ try{ QD.list=await invoke('quadro_list'); }catch(_){ QD.list=QD.list||[]; } return QD.list||[]; }
function qdAgo(ms){ const d=Date.now()-(+ms||0); if(d<60e3) return 'agora'; if(d<3600e3) return Math.round(d/60e3)+' min'; if(d<86400e3) return Math.round(d/3600e3)+' h'; return Math.round(d/86400e3)+' d'; }
async function qdMenuItems(split){
  const list=await qdMenuList();
  const sp=split?{ split }:{};
  return [{ label:'Quadro novo', hint:'escreva o que quer ver desenhado', go:()=>qdOpenNew(sp) }]
    .concat(list.slice(0,12).map(q=>({ label:q.title||'Quadro sem título', hint:'salvo · '+(q.steps||0)+' passos · '+qdAgo(q.updatedAt)+(q.taskId&&qdTask(q.taskId)?' · '+qdTask(q.taskId).title.slice(0,24):''), go:()=>qdOpenSaved(q.id, sp) })));
}
window.qdMenuItems=qdMenuItems;
