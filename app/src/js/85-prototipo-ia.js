// Starfork — 85-prototipo-ia
// ===== PROTÓTIPO · a IA e as pontes (frente "ia", 27/10; mock starfork-prototipo.html opção A, passos 1, 5 e 6) =====
// A aba do protótipo (quadro, comentários, armazenamento) é da outra frente; aqui só a IA e as pontes, conversando
// pelo modelo do brief (prototipo.json) e pelas funções globais dela (openPrototipo, protoNew, protoState,
// protoApplyScreens, protoSnapshot — sempre atrás de typeof).
//  1. Gerar a 1ª versão: protoGerarIA(prompt, { repo, taskId, onActivity }) → { title, notes, screens } já
//     sanitizado (sem <script>, on*, javascript:). Parar: protoGerarParar(). Estados prontos: protoIA.genHtml().
//  2. "Pedir pra IA olhar" (⌘↵): protoIA = { panelHtml(proto), wire(root, proto), ask(proto), undo(proto) } — manda
//     o prototipo.json (telas + comentários abertos com tela/posição/alvo/seletor) + recortes PNG de cada ponto e, com a
//     crítica ligada (padrão), acessibilidade e Padrões do time. A IA devolve propostas {pinId|null, titulo, explicacao,
//     blk, screen, html, css}; o painel mostra antes/depois de cada uma, Aceitar/Recusar/Ajustar…, "Aceitar todas" e
//     "Aplicar N" → protoApplyScreens (nova versão; comentários aceitos resolvidos com "IA: corrigido na vN").
//  3. Transformar em demanda: protoParaDemanda(id) abre a Nova demanda (Formulário) preenchida — título, "Pronto quando"
//     dos comentários resolvidos + crítica, prints das telas anexados, aviso dos abertos — e, ao criar a tarefa, chama
//     proto_export_to_task e liga o taskId (protoAfterTaskCreated, chamado pelo 32-planner).
//  4. Ponte Nova demanda: chip "Rascunhar a tela" (32-planner) → protoRascunharDaDemanda(texto).
//  5. Prévia ⌘4 (79-previa-mira): "Comparar com protótipo" — Lado a lado | Sobrepor (slider), "Ver diferenças" (IA sob
//     demanda) e "Mandar pro agente" (terminal da tarefa, como a Mira).
// Rust: prototipo_ia.rs (proto_ai / proto_ai_stop) — mesmo caminho dos chats, só leitura no repo.

// @pia-puro-inicio (puro: sem DOM nem invoke — testado em app/tests/prototipo-ia.test.mjs)
const PIA_DROP_WITH_BODY=['script','iframe','object','frameset','applet','noscript','template','noembed','noframes'];
const PIA_DROP_TAG=['base','meta','link','frame','portal','embed','param'];
const PIA_VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const PIA_URL_ATTR=/^(href|src|action|formaction|xlink:href|poster|background|data|srcset|ping|lowsrc|dynsrc|codebase|cite|longdesc|usemap|manifest)$/i;
const PIA_TAG_RE=/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const PIA_ATTR_RE=/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** entidades que escondem "javascript:" (java&#115;cript&colon;) */
function piaDecodeEnt(s){
  return String(s||'').replace(/&#x([0-9a-f]+);?/gi,(_,h)=>String.fromCodePoint(parseInt(h,16)||32)).replace(/&#(\d+);?/g,(_,d)=>String.fromCodePoint(+d||32))
    .replace(/&colon;/gi,':').replace(/&tab;/gi,'\t').replace(/&newline;/gi,'\n').replace(/&lpar;/gi,'(').replace(/&rpar;/gi,')').replace(/&sol;/gi,'/');
}
/** URL que roda código ou busca coisa de fora (o protótipo não sai da máquina) */
function piaBadUrl(v){
  const s=piaDecodeEnt(v).replace(/[\u0000-\u0020\u007f-\u00a0]+/g,'').toLowerCase();
  if(/^(javascript|vbscript|livescript|mocha):/.test(s)) return true;
  if(/^data:/.test(s) && !/^data:image\/(png|jpe?g|gif|webp);/.test(s)) return true;
  if(/^(https?:)?\/\//.test(s)) return true;
  return false;
}
/** CSS sem @import, expression(), javascript:, binding e url() de fora; não fecha o <style> */
function piaSanitizeCss(css){
  let s=String(css||'');
  for(let i=0;i<4;i++){ const b=s;
    s=s.replace(/\/\*[\s\S]*?\*\//g, m=>/expression|javascript|import/i.test(m)?'':m)
      .replace(/@import[^;]*;?/gi,'').replace(/expression\s*\(/gi,'x(').replace(/javascript\s*:/gi,'').replace(/vbscript\s*:/gi,'')
      .replace(/behavior\s*:[^;}]*;?/gi,'').replace(/-moz-binding\s*:[^;}]*;?/gi,'')
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,(m,q,u)=>piaBadUrl(u)?'none':m)
      .replace(/</g,''); // CSS não precisa de "<": nunca fecha o <style> nem abre tag
    if(s===b) break; }
  return s;
}
function piaAttrClean(name, val){
  const n=name.toLowerCase();
  if(/^on/.test(n) || n==='srcdoc' || n==='formaction' || n==='http-equiv') return null;
  if(PIA_URL_ATTR.test(n) && piaBadUrl(val)) return null;
  if(n==='style') return piaSanitizeCss(piaDecodeEnt(val));
  return val;
}
/** HTML do protótipo: tira script/iframe/object…, atributos on*, srcdoc e URLs perigosas/de fora. Idempotente. */
function piaSanitize(html){
  let s=String(html||'');
  for(let pass=0; pass<6; pass++){
    const before=s;
    s=s.replace(/<!--[\s\S]*?(-->|$)/g,'');
    PIA_DROP_WITH_BODY.forEach(t=>{
      for(let k=0;k<8;k++){ const b=s; s=s.replace(new RegExp('<'+t+'\\b[\\s\\S]*?<\\/'+t+'\\s*>','gi'),''); if(s===b) break; } // <scr<script></script>ipt> remonta: repete
      s=s.replace(new RegExp('<'+t+'\\b(?![\\s\\S]*<\\/'+t+'\\s*>)[\\s\\S]*$','i'),''); // aberto sem fechar: o navegador engoliria o resto
      s=s.replace(new RegExp('<\\/'+t+'\\s*>','gi'),'');
    });
    PIA_DROP_TAG.forEach(t=>{ s=s.replace(new RegExp('<\\/?'+t+'\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*>','gi'),''); });
    s=s.replace(PIA_TAG_RE,(m,close,name,attrs)=>{
      if(close) return '</'+name+'>';
      const self=/\/\s*$/.test(attrs);
      const out=[]; let a; PIA_ATTR_RE.lastIndex=0;
      while((a=PIA_ATTR_RE.exec(attrs))){
        const an=a[1]; const raw=a[2]!=null?a[2]:a[3]!=null?a[3]:a[4]!=null?a[4]:null;
        if(!/^[a-zA-Z_:][\w:.-]*$/.test(an)) continue;
        if(raw==null){ if(!/^on/i.test(an)) out.push(an); continue; }
        const v=piaAttrClean(an, raw); if(v==null) continue;
        out.push(an+'="'+String(v).replace(/"/g,'&quot;')+'"');
      }
      return '<'+name+(out.length?' '+out.join(' '):'')+(self?' /':'')+'>';
    });
    s=s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,(m,a,b,c)=>a+piaSanitizeCss(b)+c);
    if(s===before) break;
  }
  return s;
}
function piaAttrOf(attrs, name){ let a; const re=new RegExp(PIA_ATTR_RE.source,'g'); while((a=re.exec(attrs||''))){ if(a[1].toLowerCase()===name) return a[2]!=null?a[2]:a[3]!=null?a[3]:a[4]!=null?a[4]:''; } return null; }
/** onde está o bloco data-blk="blk" no HTML: { start, end } do outerHTML (ou null) */
function piaBlkRange(html, blk){
  const re=new RegExp(PIA_TAG_RE.source,'g'); let m, start=-1, name='', depth=0; html=String(html||'');
  while((m=re.exec(html))){
    const close=!!m[1], tag=m[2].toLowerCase(), attrs=m[3]||'';
    if(start<0){
      if(!close && piaAttrOf(attrs,'data-blk')===blk){ start=m.index; name=tag; if(PIA_VOID.has(tag)||/\/\s*$/.test(attrs)) return { start, end:re.lastIndex }; depth=1; }
      continue;
    }
    if(tag!==name) continue;
    if(close){ if(--depth===0) return { start, end:re.lastIndex }; }
    else if(!/\/\s*$/.test(attrs)) depth++;
  }
  return start>=0 ? { start, end:html.length } : null;
}
/** as tags abertas em volta do bloco (pra o antes/depois herdar os seletores da tela: .lj .apl etc.) */
function piaBlkContext(html, blk){
  html=String(html||''); const r=piaBlkRange(html, blk); if(!r) return { open:'', close:'' };
  const re=new RegExp(PIA_TAG_RE.source,'g'); const stack=[]; let m;
  while((m=re.exec(html)) && m.index<r.start){
    const close=!!m[1], tag=m[2].toLowerCase(), attrs=m[3]||'';
    if(close){ const i=stack.map(x=>x.tag).lastIndexOf(tag); if(i>=0) stack.splice(i); }
    else if(!PIA_VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, open:m[0] });
  }
  return { open:stack.map(x=>x.open).join(''), close:stack.map(x=>'</'+x.tag+'>').reverse().join('') };
}
function piaBlkOf(html, blk){ const r=piaBlkRange(html, blk); return r?String(html).slice(r.start, r.end):''; }
function piaBlks(html){ const out=[]; const re=new RegExp(PIA_TAG_RE.source,'g'); let m; while((m=re.exec(String(html||'')))){ if(m[1]) continue; const v=piaAttrOf(m[3],'data-blk'); if(v && !out.includes(v)) out.push(v); } return out; }
/** troca o bloco pelo novo outerHTML (que ganha o data-blk se a IA esqueceu). null = bloco não existe nesta tela. */
function piaReplaceBlk(html, blk, outer){
  const r=piaBlkRange(html, blk); if(!r) return null;
  let o=piaSanitize(outer).trim();
  if(o && !new RegExp('data-blk\\s*=\\s*["\']?'+blk.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(["\'\\s>/]|$)').test(o)) o=o.replace(/^(<[a-zA-Z][\w:-]*)/, '$1 data-blk="'+blk+'"');
  return String(html).slice(0, r.start)+o+String(html).slice(r.end);
}
function piaBlkName(s){ return String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40); }
function piaScreenId(s){ const v=String(s==null?'':s).toLowerCase(); if(!v||v==='null'||v==='ambas'||v==='todas'||v==='both') return null; return /cel|mob|phone|390|iphone|android|m$/.test(v)?'cel':'desk'; }
/** tira o JSON da resposta: o ÚLTIMO bloco ```json, senão o 1º objeto { … } equilibrado */
function piaJsonFrom(text){
  const t=String(text||'');
  const fences=[...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m=>m[1].trim()).filter(x=>/^[[{]/.test(x));
  const tries=fences.reverse();
  const i=t.indexOf('{');
  if(i>=0){ let d=0, str=false, esc=false;
    for(let j=i;j<t.length;j++){ const c=t[j];
      if(str){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') str=false; continue; }
      if(c==='"') str=true; else if(c==='{') d++; else if(c==='}'){ if(--d===0){ tries.push(t.slice(i,j+1)); break; } } } }
  for(const x of tries){ try{ return JSON.parse(x); }catch(_){ } }
  const e=new Error('a IA respondeu sem o JSON combinado — tente de novo ou use outra IA'); e.raw=t.slice(0,600); throw e;
}
const PIA_SCREEN_DEF={ desk:{ id:'desk', name:'Desktop · 1280', w:1280, h:840 }, cel:{ id:'cel', name:'Celular · 390', w:390, h:844 } };
/** resposta do "gerar" → { title, notes, screens:[desk, cel] } sanitizado (as duas telas sempre) */
function piaParseGerar(text, prompt){
  const o=piaJsonFrom(text);
  const list=Array.isArray(o)?o:(Array.isArray(o.screens)?o.screens:Array.isArray(o.telas)?o.telas:[]);
  const by={};
  list.forEach(sc=>{ if(!sc||typeof sc!=='object') return; const id=piaScreenId(sc.id||sc.name||(sc.w<700?'cel':'desk'))||'desk'; if(by[id]) return;
    const d=PIA_SCREEN_DEF[id]; by[id]={ id, name:String(sc.name||d.name).slice(0,60), w:+sc.w>0?Math.round(+sc.w):d.w, h:+sc.h>0?Math.round(+sc.h):d.h, html:piaSanitize(sc.html||''), css:piaSanitizeCss(sc.css||'') }; });
  if(!by.desk && !by.cel){ const e=new Error('a IA não devolveu nenhuma tela — tente de novo descrevendo melhor'); e.raw=String(text||'').slice(0,600); throw e; }
  if(!by.desk) by.desk={ ...PIA_SCREEN_DEF.desk, html:by.cel.html, css:by.cel.css };
  if(!by.cel) by.cel={ ...PIA_SCREEN_DEF.cel, html:by.desk.html, css:by.desk.css };
  const title=String(o.title||o.titulo||'').trim()||String(prompt||'').trim().split(/[.\n]/)[0].slice(0,60)||'Protótipo';
  return { title:title.slice(0,80), notes:String(o.notes||o.notas||'').slice(0,300), screens:[by.desk, by.cel] };
}
function piaOpenPins(proto){ return ((proto&&proto.pins)||[]).filter(p=>p && !p.resolved && String(p.text||'').trim()); }
/** resposta do "olhar" → propostas válidas (pinId de comentário aberto, ou null = crítica); html sanitizado */
function piaParsePropostas(text, proto){
  const o=piaJsonFrom(text);
  const raw=Array.isArray(o)?o:(o.propostas||o.proposals||o.items||[]);
  const open=new Map(piaOpenPins(proto).map(p=>[String(p.id), p]));
  const seen=new Set(); const out=[];
  (Array.isArray(raw)?raw:[]).forEach((r,i)=>{
    if(!r || typeof r!=='object') return;
    let pid=r.pinId!=null?r.pinId:r.pin!=null?r.pin:r.comentario;
    pid=(pid===null||pid===undefined||pid==='')?null:String(pid);
    if(pid!=null && !open.has(pid)) return; // comentário inexistente ou já resolvido: proposta inventada
    const key=pid!=null?'p'+pid:'c'+i; if(seen.has(key)) return; seen.add(key);
    const pin=pid!=null?open.get(pid):null;
    out.push({ key, pinId:pin?pin.id:null, crit:!pin, titulo:String(r.titulo||r.title||'Ajustar conforme o pedido').trim().slice(0,90),
      explicacao:String(r.explicacao||r.explanation||r.detalhe||'').trim().slice(0,400), blk:piaBlkName(r.blk||r.block||''),
      screen:piaScreenId(r.screen||r.tela), html:piaSanitize(r.html||''), css:piaSanitizeCss(r.css||'') });
  });
  return out;
}
/** resposta do "diff" → { iguais, diffs:[{ titulo, detalhe, blk }] } */
function piaParseDiffs(text){
  const o=piaJsonFrom(text);
  const raw=Array.isArray(o)?o:(o.diffs||o.diferencas||[]);
  const diffs=(Array.isArray(raw)?raw:[]).filter(d=>d&&typeof d==='object'&&(d.titulo||d.title)).map((d,i)=>({ key:'d'+i, titulo:String(d.titulo||d.title).trim().slice(0,90), detalhe:String(d.detalhe||d.detail||'').trim().slice(0,400), blk:piaBlkName(d.blk||'')||null }));
  return { iguais:Math.max(0, parseInt(o.iguais,10)||0), diffs };
}
function piaClone(x){ return JSON.parse(JSON.stringify(x==null?null:x)); }
/** aplica as propostas ACEITAS → { screens, pins, applied, skipped, version }. Nada muda no proto de entrada. */
function piaApply(proto, props, dec, o){
  o=o||{}; const now=o.now||Date.now(); const version=(+proto.version||1)+1;
  const screens=piaClone(proto.screens||[]); const pins=piaClone(proto.pins||[]);
  let applied=0; const skipped=[];
  let nextId=pins.reduce((m,p)=>Math.max(m,+p.id||0),0), nextN=pins.reduce((m,p)=>Math.max(m,+p.n||0),0);
  (props||[]).filter(p=>dec&&dec[p.key]==='ok').forEach(p=>{
    const targets=p.screen?screens.filter(s=>s.id===p.screen):screens.filter(s=>!p.blk||piaBlkRange(s.html,p.blk));
    let changed=false;
    if(p.html && p.blk){ targets.forEach(s=>{ const h=piaReplaceBlk(s.html, p.blk, p.html); if(h!=null && h!==s.html){ s.html=h; changed=true; } }); }
    if(p.css){ (targets.length?targets:screens).forEach(s=>{ s.css=(s.css||'').replace(/\s*$/,'')+'\n/* IA v'+version+' · '+p.titulo.replace(/\*\//g,'')+' */\n'+p.css.trim()+'\n'; changed=true; }); }
    if(!changed && (p.html||p.css)){ skipped.push(p.key); return; }
    applied++;
    const reply={ who:'IA', text:'IA: corrigido na v'+version+' — '+p.titulo, at:now };
    if(p.pinId!=null){ const pin=pins.find(x=>String(x.id)===String(p.pinId)); if(pin){ pin.resolved=true; pin.replies=(pin.replies||[]).concat([reply]); } }
    else pins.push({ id:++nextId, n:++nextN, screen:p.screen||(targets[0]&&targets[0].id)||'desk', x:16, y:16, target:p.blk||'tela', selector:p.blk?'[data-blk='+p.blk+']':'', who:'IA', text:'Crítica: '+p.titulo+(p.explicacao?' — '+p.explicacao:''), replies:[reply], resolved:true, at:now });
  });
  return { screens, pins, applied, skipped, version };
}
function piaProtoSlim(proto, o){
  o=o||{};
  return { id:proto.id, titulo:proto.title, versao:proto.version, pedido:proto.prompt||'',
    telas:(proto.screens||[]).map(s=>({ id:s.id, nome:s.name, w:s.w, h:s.h, blocos:piaBlks(s.html), html:s.html, css:s.css })),
    comentarios:piaOpenPins(proto).map(p=>({ id:p.id, n:p.n, tela:p.screen, x:Math.round(+p.x||0), y:Math.round(+p.y||0), alvo:p.target||'', seletor:p.selector||'', quem:p.who||'', texto:p.text,
      respostas:(p.replies||[]).map(r=>(r.who||'')+': '+(r.text||'')), recorte:(o.crops&&o.crops[p.id])||null })) };
}
function piaPromptGerar(prompt, ctx){
  ctx=ctx||{};
  return ['TELA PEDIDA: '+String(prompt||'').trim(),
    ctx.project?'PROJETO: '+ctx.project+' (leia as telas e estilos que já existem nele e siga o mesmo visual; siga os Padrões do time: CLAUDE.md, .claude/skills, .cardume/policy.json).':'Siga os Padrões do time do projeto (CLAUDE.md, .claude/skills, .cardume/policy.json) e o visual das telas que já existem.',
    ctx.taskTitle?'TAREFA LIGADA: '+ctx.taskTitle:'',
    'Desenhe DUAS telas: Desktop (1280×840) e Celular (390×844), com o mesmo conteúdo adaptado. Marque cada bloco editável com data-blk (o mesmo nome nas duas telas). Inclua os estados que a descrição pede (erro, vazio, carregando) como blocos.',
    'Responda só o bloco ```json combinado.'].filter(Boolean).join('\n\n');
}
function piaPromptOlhar(proto, o){
  o=o||{};
  const slim=piaProtoSlim(proto, o);
  const shots=Object.entries(o.shots||{}).map(([k,v])=>'- tela '+k+': '+v);
  return ['PROTÓTIPO (prototipo.json resumido; cada comentário aberto traz tela, posição x/y em px da tela, alvo, seletor e o caminho do RECORTE PNG daquele ponto — abra os PNGs com Read):',
    '```json\n'+JSON.stringify(slim, null, 1)+'\n```',
    shots.length?'PRINTS DAS TELAS INTEIRAS:\n'+shots.join('\n'):'',
    slim.comentarios.length?'Proponha UMA correção por comentário aberto (pinId = id do comentário).':'Não há comentários abertos.',
    o.crit?'CRÍTICA DE DESIGN LIGADA: confira também contraste de texto (≥ 4,5:1; diga o valor antes → depois), alvo de toque ≥ 44px no Celular, rótulos de campos e botões, e consistência com os Padrões do time e o visual do projeto. Cada problema achado vira uma proposta com pinId null.':'Crítica de design desligada: só os comentários.',
    o.ajuste?'AJUSTE PEDIDO: refaça SÓ a proposta do '+(o.ajuste.pinId!=null?'comentário '+o.ajuste.pinId:'bloco '+o.ajuste.blk)+' — "'+o.ajuste.titulo+'" — levando em conta: '+o.ajuste.pedido+'. Devolva só ela na lista.':'',
    'Responda só o bloco ```json combinado.'].filter(Boolean).join('\n\n');
}
function piaPromptDiff(proto, screenId, o){
  o=o||{}; const sc=(proto.screens||[]).find(s=>s.id===screenId)||(proto.screens||[])[0]||{};
  return ['PROTÓTIPO "'+(proto.title||'')+'" v'+(proto.version||1)+' — tela '+(sc.name||screenId)+' ('+sc.w+'×'+sc.h+'):',
    '```html\n'+String(sc.html||'').slice(0,12000)+'\n```', '```css\n'+String(sc.css||'').slice(0,6000)+'\n```',
    o.protoShot?'PRINT DO PROTÓTIPO: '+o.protoShot:'',
    o.realShot?'PRINT DA PRÉVIA REAL (como a tarefa está agora'+(o.dev?', '+o.dev:'')+'): '+o.realShot:'Sem print da Prévia: compare pelo código desta branch.',
    o.branch?'BRANCH DA TAREFA: '+o.branch+' (você está na pasta dela: leia o código das telas).':'',
    'Liste as diferenças que importam. Responda só o bloco ```json combinado.'].filter(Boolean).join('\n\n');
}
/** pedido pro terminal da tarefa (formato da Mira): diferenças numeradas + onde está o protótipo + prints */
function piaDiffAgentText(diffs, o){
  o=o||{}; const L=(diffs||[]).filter(Boolean); if(!L.length) return '';
  const out=['Diferenças entre a Prévia e o protótipo "'+(o.title||'')+'" v'+(o.version||1)+' ('+(o.screen==='cel'?'Celular':'Desktop')+') · '+L.length+' '+(L.length===1?'item':'itens')+':'];
  L.forEach((d,i)=>{ out.push('['+(i+1)+'] '+d.titulo+(d.detalhe?' — '+d.detalhe:'')+(d.blk?' · bloco do protótipo [data-blk='+d.blk+']':'')); });
  out.push('Protótipo de referência: '+(o.ref||'docs/prototipos/')+' (prototipo.json + prints)'+(o.realRel?' · print da Prévia @'+o.realRel:'')+(o.protoShot?' · print do protótipo '+o.protoShot:'')+'.');
  out.push('O protótipo é referência visual: use os componentes do projeto, não copie o HTML. Ajuste só o que está listado, nesta branch, e diga em uma linha o que mudou.');
  return out.join('\n');
}
/** Nova demanda a partir do protótipo: título, objetivo (com a referência e o resumo), "Pronto quando" e abertos */
function piaDemanda(proto, o){
  o=o||{}; const pins=(proto.pins||[]).filter(p=>p&&String(p.text||'').trim());
  const resolved=pins.filter(p=>p.resolved), open=pins.filter(p=>!p.resolved);
  const reqs=resolved.map(p=>{
    const last=[...(p.replies||[])].reverse().find(r=>/^IA: corrigido na v\d+ — /.test(r.text||''));
    const text=last?last.text.replace(/^IA: corrigido na v\d+ — /,''):String(p.text).replace(/^Crítica:\s*/,'').split(' — ')[0];
    return { text:text.slice(0,140), from:p.who==='IA'?'crítica de design':(String(p.who||'alguém')+' · #'+(p.n||p.id)) };
  });
  const ref=o.ref||'docs/prototipos/';
  const telas=(proto.screens||[]).map(s=>s.name||s.id).join(' e ');
  const lines=['Implementar a tela do protótipo "'+(proto.title||'')+'" (v'+(proto.version||1)+(telas?' · '+telas:'')+').',
    'O protótipo é a REFERÊNCIA visual, não código: está em '+ref+' nesta branch (prototipo.json com o HTML/CSS de cada tela + prints). Use os componentes e estilos do projeto; não copie o HTML.',
    proto.prompt?'Pedido original: '+String(proto.prompt).trim():'',
    reqs.length?'Cada item de "Pronto quando" veio de um comentário resolvido no protótipo ou da crítica de design.':'',
    open.length?'PENDÊNCIAS (comentários ainda abertos no protótipo — confirme com quem comentou antes de decidir):\n'+open.map(p=>'- #'+(p.n||p.id)+' '+(p.who||'')+(p.target?' em '+p.target:'')+': '+p.text).join('\n'):''];
  return { title:String(proto.title||'Implementar protótipo').slice(0,80), objective:lines.filter(Boolean).join('\n\n'), reqs, open:open.length, resolved:resolved.length };
}
/** ⌘↵ / Ctrl+↵ pede pra IA olhar — nunca dentro do terminal */
function piaKeyAsk(e){ if(!e || !(e.metaKey||e.ctrlKey) || e.altKey || e.shiftKey || e.key!=='Enter') return false; const el=e.target; return !(el && el.closest && el.closest('.xterm')); }
/** ⌘Z / Ctrl+Z (sem shift) fora de campo de texto e do terminal */
function piaKeyUndo(e){ if(!e || !(e.metaKey||e.ctrlKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase()!=='z') return false; const el=e.target; if(!el) return true; const tag=String(el.tagName||'');
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || el.isContentEditable) return false; return !(el.closest && el.closest('.xterm')); }
/** documento da tela num iframe sem script (sandbox="" — defesa extra além da sanitização) */
function piaDoc(html, css){ return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}'+piaSanitizeCss(css)+'</style></head><body>'+piaSanitize(html)+'</body></html>'; }
// @pia-puro-fim

const PIA={ s:{}, gen:{ busy:false, acts:[] }, link:null, cmp:{}, list:null, listAt:0, listBusy:false, protos:{} };
function piaS(id){ return PIA.s[id]||(PIA.s[id]={ st:'idle', crit:true, props:[], dec:{}, adj:{}, adjOpen:null, acts:[], step:0, err:null, undo:null, applied:0, ver:0, root:null, proto:null }); }
function piaEsc(s){ return typeof esc==='function'?esc(s):String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function piaEscA(s){ return typeof escA==='function'?escA(s):piaEsc(s); }
function piaModel(){ try{ const d=typeof aiDefaults==='function'?aiDefaults():{}; const eng=typeof aiEngineOf==='function'?aiEngineOf(d.eng):d.eng; return eng==='claude'?(d.model||null):null; }catch(_){ return null; } }
/** erro traduzido pra um cartão que já tem o próprio título (sem repetir "A IA não conseguiu…") */
function piaErr(e){ const h=typeof humanErr==='function'?humanErr(e):{ id:'generic', msg:'', raw:String(e&&e.message||e||'') }; const raw=String(h.raw||'');
  return { msg:h.id==='generic'?((raw.split('\n').find(l=>l.trim())||'erro sem detalhe').replace(/^Error:\s*/,'').slice(0,240)):h.msg, action:h.action||null, raw }; }
function piaStopped(e){ return /_STOPPED\b/.test(String((e&&e.message)||e||'')); }
function piaRepo(){ return (typeof state!=='undefined'&&state&&state.repo)||''; }
function piaProjName(){ const r=piaRepo(); return r?(typeof projShort==='function'?projShort(r):r.split('/').pop()):''; }
/** uma rodada da IA do protótipo, com as linhas de atividade */
async function piaRun(kind, prompt, o){
  o=o||{}; let un=null;
  try{ if(window.__TAURI__&&window.__TAURI__.event&&o.onLine) un=await window.__TAURI__.event.listen('proto-ai-activity-'+kind, ev=>{ const l=ev&&ev.payload&&ev.payload.line; if(l) o.onLine(String(l)); }); }catch(_){ }
  try{ const r=await invoke('proto_ai', { kind, prompt, repo:o.repo||null, model:piaModel() }); return (r&&r.text!=null)?r.text:String(r||''); }
  finally{ try{ if(typeof un==='function') un(); }catch(_){ } }
}
async function piaRead(id){ const r=await invoke('proto_read', { id }); return typeof r==='string'?JSON.parse(r):r; }
async function piaWrite(id, obj){
  try{ return await invoke('proto_write', { id, json:obj }); }
  catch(e){ if(/string|invalid type/i.test(String(e&&e.message||e))) return invoke('proto_write', { id, json:JSON.stringify(obj) }); throw e; }
}
/** o protótipo mais novo: o aberto na aba (protoState) ou o do disco */
async function piaCur(id){ const st=typeof protoState==='function'?protoState():null; if(st && st.id===id) return st; try{ return await piaRead(id); }catch(_){ return (PIA.s[id]&&PIA.s[id].proto)||PIA.protos[id]||null; } }
function piaB64(dataUrl){ return String(dataUrl||'').replace(/^data:[^,]*,/,''); }
async function piaPutPng(id, name, dataUrl){
  if(!dataUrl) return null;
  const rel=await invoke('proto_asset_put', { id, name, base64:piaB64(dataUrl) });
  const r=String(rel||'assets/'+name); const repo=piaRepo();
  return { rel:r, abs:repo?repo+'/.cardume/prototipos/'+id+'/'+r:r };
}
async function piaSnap(screenId){ if(typeof protoSnapshot!=='function') return null; try{ return await protoSnapshot(screenId); }catch(_){ return null; } }
/** recorte em volta do ponto (x,y em px da tela) de um print da tela inteira */
function piaCrop(dataUrl, sc, x, y){
  return new Promise(res=>{ try{
    const img=new Image(); img.onload=()=>{ try{
      const k=img.width/(sc.w||img.width)||1, W=Math.min(img.width, Math.round(480*k)), H=Math.min(img.height, Math.round(320*k));
      const sx=Math.max(0, Math.min(img.width-W, Math.round(x*k-W/2))), sy=Math.max(0, Math.min(img.height-H, Math.round(y*k-H/2)));
      const c=document.createElement('canvas'); c.width=W; c.height=H; const g=c.getContext('2d'); g.drawImage(img, sx, sy, W, H, 0, 0, W, H);
      g.strokeStyle=(getComputedStyle(document.documentElement).getPropertyValue('--accent')||'').trim()||'currentColor'; g.lineWidth=Math.max(2, 3*k); g.beginPath(); g.arc(x*k-sx, y*k-sy, 14*k, 0, Math.PI*2); g.stroke();
      res(c.toDataURL('image/png')); }catch(_){ res(null); } };
    img.onerror=()=>res(null); img.src=dataUrl; }catch(_){ res(null); } });
}
/** prints das telas (inteiras) e recortes de cada comentário aberto, salvos em assets/ → caminhos pra IA abrir */
async function piaShots(proto, open, all){
  const shots={}, crops={}, ver=proto.version||1;
  const ids=[...new Set((all?(proto.screens||[]).map(s=>s.id):[]).concat(open.map(p=>p.screen)))].filter(Boolean);
  for(const sid of ids){
    const sc=(proto.screens||[]).find(s=>s.id===sid); if(!sc) continue;
    const url=await piaSnap(sid); if(!url) continue;
    try{ const f=await piaPutPng(proto.id, 'ia-'+sid+'-v'+ver+'.png', url); if(f) shots[sid]=f.abs; }catch(_){ }
    for(const p of open.filter(q=>q.screen===sid)){
      const c=await piaCrop(url, sc, +p.x||0, +p.y||0); if(!c) continue;
      try{ const f=await piaPutPng(proto.id, 'ia-pin-'+(p.n||p.id)+'-v'+ver+'.png', c); if(f) crops[p.id]=f.abs; }catch(_){ }
    }
  }
  return { shots, crops };
}

// ---------- 1. gerar a 1ª versão ----------
async function protoGerarIA(prompt, o){
  o=o||{}; prompt=String(prompt||'').trim();
  if(!prompt){ const e=new Error('descreva a tela que a IA deve desenhar'); throw e; }
  const g=PIA.gen; g.busy=true; g.acts=[]; g.prompt=prompt; g.err=null;
  let taskTitle='';
  try{ if(o.taskId && typeof taskById==='function'){ const t=taskById(o.taskId); taskTitle=(t&&t.title)||''; } }catch(_){ }
  try{
    const text=await piaRun('gerar', piaPromptGerar(prompt, { project:piaProjName(), taskTitle }), { repo:o.repo||null,
      onLine:l=>{ g.acts.push(l); if(g.acts.length>30) g.acts.shift(); try{ o.onActivity&&o.onActivity(l, g.acts.slice()); }catch(_){ } } });
    return piaParseGerar(text, prompt);
  }catch(e){
    if(piaStopped(e)){ const s=new Error('PROTO_GEN_STOPPED'); s.stopped=true; throw s; }
    g.err=e; throw e;
  }finally{ g.busy=false; }
}
// Esc para a geração (fora do terminal), como o "Parar esc" do estado carregando
document.addEventListener('keydown', e=>{ if(e.key!=='Escape' || !PIA.gen.busy || e.defaultPrevented) return; const el=e.target; if(el && el.closest && el.closest('.xterm')) return; e.preventDefault(); protoGerarParar(); });
async function protoGerarParar(){ try{ return await invoke('proto_ai_stop', { kind:'gerar' }); }catch(_){ return false; } }
/** estados da geração pra aba do protótipo: { st:'loading'|'erro', prompt, acts, err } */
function piaGenHtml(o){
  o=o||{};
  if(o.st==='erro'){ const h=piaErr(o.err);
    return `<div class="pia-state err" role="alert"><h2>Não deu pra gerar o protótipo</h2><p>${piaEsc(h.msg)}</p><p class="pia-dim">Nada foi perdido: o texto que você escreveu está salvo.</p><div class="pia-row"><button type="button" class="btn primary sm" data-pia-gen="retry">Tentar de novo</button><button type="button" class="btn sm" data-pia-gen="engine">Usar outra IA</button><button type="button" class="btn sm" data-pia-gen="branco">Começar em branco</button></div></div>`; }
  const acts=(o.acts||PIA.gen.acts||[]).slice(-4);
  return `<div class="pia-state" aria-live="polite"><span class="pia-spin lg" aria-hidden="true"></span><h2>A IA está desenhando a 1ª versão…</h2><p>“${piaEsc(String(o.prompt||PIA.gen.prompt||'').slice(0,140))}” · usando os Padrões do time e as telas ${piaEsc(piaProjName()?'de '+piaProjName():'do projeto')}</p>
    <div class="pia-acts">${acts.map(a=>`<span>${piaEsc(a)}</span>`).join('')||'<span>lendo o projeto…</span>'}</div><div class="pia-skel"></div><div class="pia-skel w70"></div>
    <button type="button" class="btn ghost sm" data-pia-gen="parar">Parar <span class="kbd">esc</span></button></div>`;
}
function piaGenWire(root, h){
  h=h||{}; if(!root) return;
  root.querySelectorAll('[data-pia-gen]').forEach(b=>b.onclick=()=>{ const k=b.dataset.piaGen;
    if(k==='parar'){ protoGerarParar(); if(h.onStop) h.onStop(); }
    else if(k==='retry'){ if(h.onRetry) h.onRetry(); }
    else if(k==='engine'){ if(window.suaIaOpenCfg) window.suaIaOpenCfg(); else if(window.openTab) window.openTab('cfg'); }
    else if(k==='branco'){ if(h.onBlank) h.onBlank(); } });
}

// ---------- 2. pedir pra IA olhar ----------
function piaPanelHtml(proto){
  if(!proto) return '';
  const s=piaS(proto.id); s.proto=proto;
  const nOpen=piaOpenPins(proto).length;
  if(s.st==='erro') return `<div class="pia-card err" role="alert"><h4>A IA não conseguiu olhar</h4><p>${piaEsc(s.err&&s.err.msg||'')}</p><p class="pia-dim">Seus comentários estão salvos.</p><div class="pia-row"><button type="button" class="btn primary sm" data-pia="ask">Tentar de novo</button><button type="button" class="btn sm" data-pia="engine">Usar outra IA</button>${s.err&&s.err.action?`<button type="button" class="btn ghost sm" data-pia="erract">${piaEsc(s.err.action.label)}</button>`:''}</div></div>`;
  if(s.st==='loading'){ const acts=s.acts.slice(-3);
    return `<div class="pia-card" aria-live="polite"><h4><span class="pia-spin" aria-hidden="true"></span> A IA está olhando…</h4><div class="pia-steps"><span class="${s.step>=1?'dn':''}">${s.step>=1?'✓':'·'} Leu ${nOpen} ${nOpen===1?'comentário':'comentários'} com posição e elemento</span><span class="${s.step>=1?'dn':''}">${s.step>=1?'✓':'·'} Recortou cada ponto da tela</span><span>${s.step>=1?'<span class="pia-spin sm" aria-hidden="true"></span> ':''}${s.crit?'Comparando com Padrões do time · Acessibilidade':'Preparando as propostas'}</span>${acts.map(a=>`<span class="pia-act">${piaEsc(a)}</span>`).join('')}</div><div class="pia-skel"></div><div class="pia-skel w70"></div><button type="button" class="btn ghost sm" data-pia="stop">Parar <span class="kbd">esc</span></button></div>`; }
  if(s.st==='done') return `<div class="pia-card ok"><h4>${piaAv()} Pronto · versão ${s.ver} salva</h4><p>${s.applied} ${s.applied===1?'correção aplicada':'correções aplicadas'} no protótipo e os comentários foram marcados como resolvidos com a resposta da IA.</p><div class="pia-row"><button type="button" class="btn sm" data-pia="undo">Desfazer <span class="kbd">⌘Z</span></button><button type="button" class="btn sm" data-pia="again">Olhar de novo</button><button type="button" class="btn primary sm" data-pia="demanda">Transformar em demanda →</button></div></div>`;
  if(s.st!=='props') return `<div class="pia-card"><h4>${piaAv()} Pedir pra IA olhar</h4><p>Ela lê cada comentário com a posição, o elemento e um recorte da tela, e propõe uma correção por comentário. Você aceita ou recusa um por um.</p><label class="pia-chk"><input type="checkbox" data-pia="crit"${s.crit?' checked':''}> Incluir crítica de design (acessibilidade, consistência com os Padrões do time)</label><button type="button" class="btn primary" data-pia="ask"${(nOpen||s.crit)?'':' disabled'}>Pedir pra IA olhar <span class="kbd">⌘↵</span></button>${nOpen?'':`<p class="pia-dim">Nenhum comentário aberto${s.crit?' — ela faz só a crítica de design':''}. Comente com <span class="kbd">C</span>.</p>`}</div>`;
  const items=s.props;
  if(!items.length) return `<div class="pia-card"><h4>${piaAv()} Nada pra corrigir</h4><p>Não há comentários abertos nem problemas de design. Comente algo com <span class="kbd">C</span>.</p><div class="pia-row"><button type="button" class="btn sm" data-pia="again">Olhar de novo</button></div></div>`;
  const okN=items.filter(i=>s.dec[i.key]==='ok').length, nPin=items.filter(i=>!i.crit).length;
  return `<div class="pia-sum">A IA leu ${nPin} ${nPin===1?'comentário':'comentários'}${s.crit?' e fez uma crítica de design':''}. Nada muda até você aceitar.</div>`+
    items.map(i=>piaPropHtml(proto, s, i)).join('')+
    `<div class="pia-foot"><button type="button" class="btn sm" data-pia="all">Aceitar todas</button><button type="button" class="btn primary" data-pia="apply"${okN?'':' disabled'}>Aplicar ${okN} no protótipo</button></div>`;
}
function piaAv(){ return '<span class="pia-av" aria-hidden="true">'+(typeof IC!=='undefined'&&IC.starforkEm?IC.starforkEm:'')+'</span>'; }
function piaPropHtml(proto, s, i){
  const d=s.dec[i.key]; const pin=i.pinId!=null?(proto.pins||[]).find(p=>String(p.id)===String(i.pinId)):null;
  const who=pin?(typeof personName==='function'&&/^[0-9a-f-]{20,}$/i.test(String(pin.who||''))?personName(pin.who):(pin.who||'alguém')):'';
  return `<div class="pia-card${d==='ok'?' on':d==='no'?' no':''}" data-pia-key="${piaEscA(i.key)}"><h4>${pin?`<span class="pia-pn">${piaEsc(pin.n||pin.id)}</span>`:'<span class="pia-crit">crítica</span>'} ${piaEsc(i.titulo)}</h4>
    ${pin?`<p class="pia-q">${piaEsc(who)}: “${piaEsc(String(pin.text).slice(0,90))}${String(pin.text).length>90?'…':''}”</p>`:''}
    ${i.explicacao?`<p class="pia-x">${piaEsc(i.explicacao)}</p>`:''}
    ${piaBAHtml(proto, i)}
    <div class="pia-row"><button type="button" class="btn sm${d==='ok'?' primary':''}" data-pia="dec" data-v="ok" data-k="${piaEscA(i.key)}" aria-pressed="${d==='ok'}">${d==='ok'?'✓ Aceita':'Aceitar'}</button><button type="button" class="btn sm" data-pia="dec" data-v="no" data-k="${piaEscA(i.key)}" aria-pressed="${d==='no'}">${d==='no'?'Recusada':'Recusar'}</button><button type="button" class="btn ghost sm" data-pia="adj" data-k="${piaEscA(i.key)}" aria-expanded="${s.adjOpen===i.key}">Ajustar…</button></div>
    ${s.adjOpen===i.key?`<div class="pia-adj"><label class="pia-dim" for="pia-adj-${piaEscA(i.key)}">O que mudar nesta proposta</label><textarea class="in" id="pia-adj-${piaEscA(i.key)}" rows="2" data-pia-adj="${piaEscA(i.key)}" placeholder="ex.: use o verde da marca, não o escuro">${piaEsc(s.adj[i.key]||'')}</textarea><div class="pia-row"><button type="button" class="btn sm primary" data-pia="redo" data-k="${piaEscA(i.key)}">Refazer só esta</button><button type="button" class="btn ghost sm" data-pia="adjx">cancelar</button></div></div>`:''}
  </div>`;
}
/** antes/depois do bloco, renderizado sem script (iframe sandbox) */
function piaBAHtml(proto, i){
  if(!i.blk || !(i.html||i.css)) return '';
  const sc=(proto.screens||[]).find(s=>s.id===(i.screen||'desk'))||(proto.screens||[]).find(s=>piaBlkRange(s.html,i.blk))||(proto.screens||[])[0];
  if(!sc) return '';
  const before=piaBlkOf(sc.html, i.blk); if(!before && !i.html) return '';
  const after=i.html?i.html:before, cssA=(sc.css||'')+'\n'+(i.css||'');
  const cx=piaBlkContext(sc.html, i.blk); // o bloco dentro das mesmas caixas da tela: os seletores do CSS continuam valendo
  cx.open=cx.open.replace(/<([a-zA-Z][\w:-]*)/g, (m, t, at)=>at===0?m:m+' data-pia-ctx'); // caixas do meio sem layout (grid/colunas espremiam o bloco)
  const fr=(h,c,l)=>`<figure><figcaption>${l}</figcaption><iframe class="pia-mini" sandbox="" tabindex="-1" title="${l} — ${piaEscA(i.blk)}" srcdoc="${piaEscA(piaDoc(cx.open+h+cx.close, 'html{zoom:.62}body{padding-top:14px}'+c+'\n[data-pia-ctx]{display:contents!important}input,select,textarea{min-width:0;max-width:100%}'))}"></iframe></figure>`;
  return `<div class="pia-ba">${fr(before||'<p style="font-size:12px;opacity:.6">(bloco novo)</p>', sc.css||'', 'antes')}${fr(after, cssA, 'depois')}</div>`;
}
function piaRepaint(id){
  const s=piaS(id); const root=s.root; if(!root || !root.isConnected || !s.proto) return;
  const ae=document.activeElement, keep=ae&&root.contains(ae)&&ae.dataset&&ae.dataset.piaAdj?{ k:ae.dataset.piaAdj, p:ae.selectionStart }:null;
  root.innerHTML=piaPanelHtml(s.proto);
  if(keep){ const el=root.querySelector('[data-pia-adj="'+(window.CSS&&CSS.escape?CSS.escape(keep.k):keep.k)+'"]'); if(el){ el.focus(); try{ el.setSelectionRange(keep.p, keep.p); }catch(_){ } } }
}
function piaWire(root, proto){
  if(!root || !proto) return;
  const s=piaS(proto.id); s.root=root; s.proto=proto; root.dataset.piaId=proto.id; root.classList.add('pia-panel');
  if(!root.innerHTML.trim()) root.innerHTML=piaPanelHtml(proto);
  if(root.__piaWired) return; root.__piaWired=1;
  root.addEventListener('click', ev=>{ const b=ev.target.closest('[data-pia]'); if(!b || b.tagName==='INPUT') return; piaAct(root.dataset.piaId, b.dataset.pia, b); });
  root.addEventListener('change', ev=>{ const b=ev.target; if(b && b.dataset && b.dataset.pia==='crit'){ const st=piaS(root.dataset.piaId); st.crit=!!b.checked; piaRepaint(root.dataset.piaId); } });
  root.addEventListener('input', ev=>{ const k=ev.target&&ev.target.dataset&&ev.target.dataset.piaAdj; if(k!=null){ piaS(root.dataset.piaId).adj[k]=ev.target.value; } });
  root.addEventListener('keydown', ev=>{
    if(ev.key==='Escape' && piaS(root.dataset.piaId).st==='loading'){ ev.preventDefault(); piaAct(root.dataset.piaId, 'stop'); return; }
    if(piaKeyUndo(ev) && piaS(root.dataset.piaId).st==='done'){ ev.preventDefault(); ev.stopPropagation(); piaAct(root.dataset.piaId, 'undo'); }
  });
}
async function piaAct(id, k, b){
  const s=piaS(id); const proto=s.proto||await piaCur(id); if(!proto) return;
  if(k==='ask' || k==='again'){ s.st='idle'; return piaAsk(proto); }
  if(k==='stop'){ try{ await invoke('proto_ai_stop', { kind:'olhar' }); }catch(_){ } return; }
  if(k==='engine'){ if(window.suaIaOpenCfg) window.suaIaOpenCfg(); else if(window.openTab) window.openTab('cfg'); return; }
  if(k==='erract'){ if(s.err&&s.err.action) s.err.action.fn(); return; }
  if(k==='dec'){ const key=b.dataset.k, v=b.dataset.v; s.dec[key]=s.dec[key]===v?undefined:v; piaRepaint(id); return; }
  if(k==='all'){ s.props.forEach(i=>{ s.dec[i.key]='ok'; }); piaRepaint(id); return; }
  if(k==='adj'){ s.adjOpen=s.adjOpen===b.dataset.k?null:b.dataset.k; piaRepaint(id); const el=s.root&&s.root.querySelector('[data-pia-adj]'); if(el) el.focus(); return; }
  if(k==='adjx'){ s.adjOpen=null; piaRepaint(id); return; }
  if(k==='redo') return piaRedo(proto, b.dataset.k);
  if(k==='apply') return piaApplyNow(proto);
  if(k==='undo') return piaUndo(proto);
  if(k==='demanda') return protoParaDemanda(id);
}
async function piaAsk(proto){
  if(!proto) return; const s=piaS(proto.id); if(s.st==='loading') return;
  s.proto=proto; s.st='loading'; s.err=null; s.acts=[]; s.step=0; s.adjOpen=null; piaRepaint(proto.id);
  try{
    const open=piaOpenPins(proto);
    const { shots, crops }=await piaShots(proto, open, s.crit);
    s.step=1; piaRepaint(proto.id);
    const text=await piaRun('olhar', piaPromptOlhar(proto, { crit:s.crit, shots, crops }), { onLine:l=>{ s.acts.push(l); if(s.acts.length>20) s.acts.shift(); piaRepaint(proto.id); } });
    s.props=piaParsePropostas(text, s.proto||proto); s.dec={}; s.adj={}; s.st='props';
  }catch(e){
    if(piaStopped(e)){ s.st='idle'; toast('Parado — seus comentários continuam aí.','info'); }
    else { s.st='erro'; s.err=piaErr(e); console.warn('[proto-ia] olhar:', e); }
  }
  piaRepaint(proto.id);
}
async function piaRedo(proto, key){
  const s=piaS(proto.id); const it=s.props.find(i=>i.key===key); const pedido=String(s.adj[key]||'').trim();
  if(!it) return; if(!pedido){ toast('Escreva o que mudar nesta proposta.','info'); return; }
  const btn=s.root&&s.root.querySelector('[data-pia="redo"]'); if(btn){ btn.disabled=true; btn.textContent='refazendo…'; }
  try{
    const text=await piaRun('olhar', piaPromptOlhar(proto, { crit:false, ajuste:{ pinId:it.pinId, blk:it.blk, titulo:it.titulo, pedido } }), {});
    const novas=piaParsePropostas(text, proto); const nova=novas.find(n=>n.key===key)||(it.crit?novas[0]:null);
    if(!nova){ toast('A IA não devolveu a proposta ajustada — tente de novo.','warn'); }
    else { nova.key=key; s.props=s.props.map(i=>i.key===key?nova:i); s.dec[key]=undefined; s.adjOpen=null; s.adj[key]=''; toast('Proposta refeita.','ok'); }
  }catch(e){ if(!piaStopped(e)) showErr(e,'Não deu pra refazer a proposta'); }
  piaRepaint(proto.id);
}
async function piaApplyNow(proto){
  const s=piaS(proto.id); const cur=await piaCur(proto.id)||proto;
  const r=piaApply(cur, s.props, s.dec, { now:Date.now() });
  if(!r.applied){ toast(r.skipped.length?'Os blocos dessas propostas não existem mais no protótipo — peça pra IA olhar de novo.':'Aceite pelo menos uma proposta.','warn'); return; }
  s.undo={ screens:piaClone(cur.screens), pins:piaClone(cur.pins), version:cur.version };
  try{
    const note='IA: '+r.applied+' '+(r.applied===1?'correção':'correções')+(s.crit?' (comentários + crítica de design)':'');
    if(typeof protoApplyScreens==='function') await protoApplyScreens(proto.id, r.screens, note);
    else await piaSaveFallback(proto.id, r.screens, note);
    const ver=await piaSavePins(proto.id, r.pins);
    s.st='done'; s.applied=r.applied; s.ver=ver||r.version; s.proto=await piaCur(proto.id)||s.proto;
    if(r.skipped.length) toast(r.skipped.length+' proposta(s) não acharam o bloco no protótipo e ficaram de fora.','warn');
    else toast('Versão '+s.ver+' salva · ⌘Z desfaz','ok');
  }catch(e){ s.undo=null; showErr(e,'Não deu pra aplicar as correções'); }
  piaRepaint(proto.id);
}
/** sem a função da outra frente: grava a versão nova direto (mesmo modelo) */
async function piaSaveFallback(id, screens, note){
  const cur=await piaCur(id); if(!cur) throw new Error('protótipo não encontrado');
  cur.screens=screens; cur.version=(+cur.version||1)+1; cur.updatedAt=Date.now();
  cur.history=(cur.history||[]).concat([{ version:cur.version, at:cur.updatedAt, by:'IA', note }]);
  await piaWrite(id, cur);
  try{ window.dispatchEvent(new CustomEvent('sf:proto-salvo', { detail:{ id, version:cur.version } })); }catch(_){ }
}
/** comentários resolvidos pela IA (o protoApplyScreens só grava telas) → mesmo arquivo, mesma versão */
async function piaSavePins(id, pins){
  const cur=await piaCur(id); if(!cur) return 0;
  cur.pins=pins; cur.updatedAt=Date.now();
  await piaWrite(id, cur);
  try{ window.dispatchEvent(new CustomEvent('sf:proto-salvo', { detail:{ id, version:cur.version } })); }catch(_){ }
  return cur.version;
}
async function piaUndo(proto){
  const s=piaS(proto.id); if(!s.undo){ toast('Nada da IA pra desfazer.','info'); return; }
  const u=s.undo; s.undo=null;
  try{
    if(typeof protoApplyScreens==='function') await protoApplyScreens(proto.id, u.screens, 'Desfeito: correções da IA (volta à v'+u.version+')');
    else await piaSaveFallback(proto.id, u.screens, 'Desfeito: correções da IA (volta à v'+u.version+')');
    await piaSavePins(proto.id, u.pins);
    s.st='props'; s.proto=await piaCur(proto.id)||s.proto; toast('Desfeito — o protótipo voltou ao que era na v'+u.version+'.','ok');
  }catch(e){ s.undo=u; showErr(e,'Não deu pra desfazer'); }
  piaRepaint(proto.id);
}
window.protoIA={ panelHtml:piaPanelHtml, wire:piaWire, ask:piaAsk, undo:piaUndo, genHtml:piaGenHtml, genWire:piaGenWire, state:piaS };
window.protoGerarIA=protoGerarIA; window.protoGerarParar=protoGerarParar;

// ---------- 3. transformar em demanda ----------
function piaRefPath(id){ return (typeof lsGet==='function'&&lsGet('pia:exp:'+id))||'docs/prototipos/'; }
async function piaPrints(proto){
  const out=[];
  for(const sc of (proto.screens||[])){ const url=await piaSnap(sc.id); if(!url) continue;
    try{ const f=await piaPutPng(proto.id, 'tela-'+sc.id+'-v'+(proto.version||1)+'.png', url); if(f) out.push(f.abs); }catch(_){ } }
  return out;
}
async function protoParaDemanda(id){
  let proto; try{ proto=await piaCur(id); }catch(_){ proto=null; }
  if(!proto){ toast('Protótipo não encontrado.','warn'); return false; }
  const d=piaDemanda(proto);
  const refs=await piaPrints(proto); const repo=piaRepo();
  if(repo) refs.push(repo+'/.cardume/prototipos/'+id+'/prototipo.json');
  if(typeof ntOpenFormTab!=='function'){ toast('A Nova demanda não abriu agora — tente de novo.','warn'); return false; }
  if(!await ntOpenFormTab()) return false;
  try{
    setNtMode('build');
    $id('ntTitle').value=d.title; $id('ntObj').value=d.objective;
    ntReq=d.reqs.map(r=>r.text+' — '+r.from); renderNtList('ntRequirements', ntReq);
    ntRefs=refs; if(typeof renderNtRefs==='function') renderNtRefs();
    { const p=$id('ntArtProof'); if(p) p.checked=true; }
    if(typeof ntMarkBase==='function') ntMarkBase();
    if(typeof renderTabs==='function') renderTabs();
    PIA.link={ protoId:id, tab:(typeof activeTab!=='undefined')?activeTab:null };
    if(d.open) toast(d.open+' '+(d.open===1?'comentário ainda aberto vai':'comentários ainda abertos vão')+' como pendência da demanda.','warn', { label:'voltar e resolver', fn:()=>{ if(typeof openPrototipo==='function') openPrototipo(id); } });
    else toast('Demanda montada com '+d.reqs.length+' '+(d.reqs.length===1?'item':'itens')+' de “Pronto quando” e os prints do protótipo.','ok');
    return true;
  }catch(e){ showErr(e,'Não consegui montar a demanda do protótipo'); return false; }
}
/** chamado quando a tarefa é criada (32-planner): o Formulário montado por protoParaDemanda liga o protótipo */
async function protoAfterTaskCreated(taskId, tab){
  const l=PIA.link; if(!l || !taskId) return false;
  if(l.tab && tab && l.tab!==tab) return false; // outra aba de Nova demanda
  PIA.link=null; return protoLinkTask(l.protoId, taskId);
}
/** copia o protótipo pra worktree da tarefa (docs/prototipos/<slug>/) e grava o taskId nele */
async function protoLinkTask(protoId, taskId){
  try{
    const path=await invoke('proto_export_to_task', { id:protoId, taskId });
    if(path && typeof lsSet==='function') lsSet('pia:exp:'+protoId, String(path));
    const cur=await piaCur(protoId);
    if(cur){ cur.taskId=taskId; cur.updatedAt=Date.now(); await piaWrite(protoId, cur); try{ window.dispatchEvent(new CustomEvent('sf:proto-salvo', { detail:{ id:protoId, version:cur.version } })); }catch(_){ } }
    PIA.listAt=0; toast('Protótipo ligado à tarefa e copiado pra '+(path?String(path).split('/').slice(-3).join('/'):'docs/prototipos/')+'.','ok');
    return true;
  }catch(e){ showErr(e,'Não consegui copiar o protótipo pra tarefa'); return false; }
}
/** pedido criado pelo chat da Nova demanda com um protótipo rascunhado: referência + resumo + prints no pedido */
async function protoPayloadRef(protoId, payload){
  try{ const proto=await piaCur(protoId); if(!proto||!payload) return;
    const d=piaDemanda(proto);
    payload.objective=[payload.objective||'', 'PROTÓTIPO DE REFERÊNCIA: '+d.objective].filter(Boolean).join('\n\n');
    if(d.reqs.length) payload.requirements=(payload.requirements||[]).concat(d.reqs.map(r=>r.text+' — '+r.from).filter(x=>!(payload.requirements||[]).includes(x)));
    const refs=await piaPrints(proto); const repo=piaRepo(); if(repo) refs.push(repo+'/.cardume/prototipos/'+protoId+'/prototipo.json');
    payload.refs=(payload.refs||[]).concat(refs);
  }catch(e){ console.warn('[proto-ia] referência no pedido:', e); }
}
window.protoParaDemanda=protoParaDemanda; window.protoAfterTaskCreated=protoAfterTaskCreated; window.protoLinkTask=protoLinkTask; window.protoPayloadRef=protoPayloadRef;

// ---------- 4. ponte Nova demanda: "Rascunhar a tela" ----------
async function protoRascunharDaDemanda(text){
  text=String(text||'').trim();
  if(!text){ toast('Descreva a tela na caixa primeiro — a IA rascunha a partir do texto da demanda.','info'); const i=$id('plInput'); if(i) i.focus(); return null; }
  if(typeof protoNew!=='function'){ toast('A aba Protótipo ainda não está disponível nesta versão.','warn'); return null; }
  try{
    const r=await protoNew({ source:'ia', prompt:text });
    const id=(r&&typeof r==='object')?r.id:r;
    if(id && typeof plFields!=='undefined'){ plFields.protoId=id; if(typeof plAutoSave==='function') plAutoSave(); }
    if(id && typeof openPrototipo==='function'){ const st=typeof protoState==='function'?protoState():null; if(!st || st.id!==id) openPrototipo(id); }
    return id||null;
  }catch(e){ showErr(e,'Não deu pra rascunhar a tela'); return null; }
}
window.protoRascunharDaDemanda=protoRascunharDaDemanda;

// ---------- 5. Prévia ⌘4: comparar com o protótipo ----------
function piaListRefresh(force){
  if(PIA.listBusy || (!force && Date.now()-PIA.listAt<15000)) return;
  PIA.listBusy=true;
  Promise.resolve().then(()=>(typeof invokeQuiet==='function'?invokeQuiet:invoke)('proto_list')).then(l=>{
    const sig=JSON.stringify((l||[]).map(x=>[x.id,x.taskId,x.updatedAt]));
    const was=PIA.list?JSON.stringify(PIA.list.map(x=>[x.id,x.taskId,x.updatedAt])):'';
    PIA.list=Array.isArray(l)?l:[]; PIA.listAt=Date.now();
    if(sig!==was && typeof renderWorkspace==='function' && typeof fwMode!=='undefined' && fwMode==='previa') renderWorkspace();
  }).catch(()=>{ PIA.list=PIA.list||[]; PIA.listAt=Date.now(); }).finally(()=>{ PIA.listBusy=false; });
}
/** protótipo ligado à tarefa (o mais novo), do cache — atualiza em segundo plano */
function piaTaskProto(taskId){
  piaListRefresh();
  return ((PIA.list||[]).filter(p=>p&&p.taskId===taskId).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0])||null;
}
function piaC(taskId){ return PIA.cmp[taskId]||(PIA.cmp[taskId]={ on:false, mode:'lado', pos:50, st:'idle', diffs:null, iguais:0, err:null, sent:{}, protoId:null }); }
function piaCmpOn(t){ return !!(t && piaC(t.id).on && piaTaskProto(t.id)); }
function piaCmpToolsHtml(t){
  const p=t&&piaTaskProto(t.id); if(!p) return '';
  const on=piaC(t.id).on;
  return `<button type="button" class="btn sm pia-cmpbtn${on?' on':''}" data-pia-cmp="toggle" aria-pressed="${on}" title="ver a Prévia ao lado da tela do protótipo ligado">Comparar com protótipo</button>`;
}
function piaScreenFor(dev){ return dev==='web'?'desk':'cel'; }
function piaFrame(sc, cls){ return `<div class="pia-pfw ${cls||''}" data-sw="${sc.w}" data-sh="${sc.h}"><iframe class="pia-pf" sandbox="" tabindex="-1" title="Tela do protótipo: ${piaEscA(sc.name||sc.id)}" style="width:${sc.w}px;height:${sc.h}px" srcdoc="${piaEscA(piaDoc(sc.html, sc.css))}"></iframe></div>`; }
function piaFit(root){
  root.querySelectorAll('.pia-pfw').forEach(w=>{ const sw=+w.dataset.sw||1, sh=+w.dataset.sh||1; const W=w.parentElement?w.parentElement.clientWidth:w.clientWidth; if(!W) return;
    const k=Math.min(1.2, W/sw); const f=w.querySelector('iframe'); if(f){ f.style.transform='scale('+k+')'; f.style.transformOrigin='0 0'; } w.style.height=Math.round(sh*k)+'px'; w.style.width=Math.round(sw*k)+'px'; });
}
function piaCmpDiffsHtml(t, c){
  if(c.st==='loading') return `<div class="pia-diffs" aria-live="polite"><span class="pia-spin sm" aria-hidden="true"></span> A IA está comparando a Prévia com o protótipo… <button type="button" class="btn ghost sm" data-pia-cmp="stopdiff">Parar</button></div>`;
  if(c.st==='erro') return `<div class="pia-diffs err" role="alert">Não deu pra comparar: ${piaEsc(c.err&&c.err.msg||'erro sem detalhe')} <button type="button" class="btn sm" data-pia-cmp="diff">Tentar de novo</button> <button type="button" class="btn ghost sm" data-pia-cmp="engine">Usar outra IA</button></div>`;
  if(!c.diffs) return `<div class="pia-diffs"><span class="pia-dim">A IA lista o que a Prévia ainda não tem do protótipo (sob demanda).</span> <button type="button" class="btn sm" data-pia-cmp="diff">Ver diferenças</button></div>`;
  if(!c.diffs.length) return `<div class="pia-diffs ok">✓ Nenhuma diferença que importe${c.iguais?' · '+c.iguais+' itens iguais ao protótipo':''}. <button type="button" class="btn ghost sm" data-pia-cmp="diff">Comparar de novo</button></div>`;
  return `<div class="pia-diffs"><div class="pia-dl">${c.diffs.length} ${c.diffs.length===1?'diferença':'diferenças'}${c.iguais?' · '+c.iguais+' itens iguais ao protótipo':''}</div>`+
    c.diffs.map(d=>`<div class="pia-diff"><span><b>${piaEsc(d.titulo)}</b>${d.detalhe?' · '+piaEsc(d.detalhe):''}</span><button type="button" class="btn sm${c.sent[d.key]?'':' primary'}" data-pia-cmp="send" data-k="${piaEscA(d.key)}"${c.sent[d.key]?' disabled':''}>${c.sent[d.key]?'Mandado ✓':'Mandar pro agente'}</button></div>`).join('')+
    (c.diffs.length>1?`<div class="pia-row"><button type="button" class="btn sm" data-pia-cmp="sendall">Mandar todas (${c.diffs.length})</button><button type="button" class="btn ghost sm" data-pia-cmp="diff">Comparar de novo</button></div>`:'')+`</div>`;
}
/** a comparação dentro da Prévia (chamada pelo mrRender do 79 quando ligada). O iframe da Prévia é o mesmo appRender. */
function piaCmpPaint(t, root){
  const c=piaC(t.id), meta=piaTaskProto(t.id); if(!meta) return;
  const proto=PIA.protos[meta.id];
  if(!proto || (proto.updatedAt||0)<(meta.updatedAt||0)){ if(!c.loading){ c.loading=true; piaRead(meta.id).then(p=>{ PIA.protos[meta.id]=p; }).catch(()=>{ PIA.protos[meta.id]=PIA.protos[meta.id]||null; }).finally(()=>{ c.loading=false; if(typeof renderWorkspace==='function') renderWorkspace(); }); } }
  const stage=root.querySelector('.mr-stage'); if(!stage) return;
  const dev=root.dataset.dev||'web', sid=piaScreenFor(dev);
  const sc=proto&&((proto.screens||[]).find(s=>s.id===sid)||(proto.screens||[])[0]);
  const sig=[meta.id, proto&&proto.version, proto&&proto.updatedAt, dev, c.mode].join('|');
  let box=stage.querySelector('.pia-cmp');
  if(!box || box.dataset.sig!==sig){
    if(box) box.remove();
    const devW=dev==='ios'?390:dev==='and'?412:0;
    const seg=`<div class="te-seg" role="group" aria-label="Modo de comparação"><button type="button" data-pia-cmp="mode" data-v="lado" aria-pressed="${c.mode==='lado'}">Lado a lado</button><button type="button" data-pia-cmp="mode" data-v="sobre" aria-pressed="${c.mode==='sobre'}">Sobrepor</button></div>`;
    const lab=`<span class="pia-dim">Protótipo v${piaEsc(proto?proto.version:meta.version||'')} · ${piaEsc(sc?sc.name:'carregando…')}</span>`;
    const body=!sc?'<div class="pia-dim pia-pad">Carregando o protótipo…</div>':
      c.mode==='lado'
        ?`<div class="pia-side"><figure class="pia-fig" style="${devW?'flex:none;width:'+devW+'px':''}"><figcaption><span class="pia-pill ok">rodando</span> Prévia · ${piaEsc(t.branch||'')}</figcaption><div class="pia-live"></div></figure><figure class="pia-fig" style="${devW?'flex:none;width:'+devW+'px':''}"><figcaption><span class="pia-pill">referência</span> Protótipo · ${piaEsc(proto.title||'')}</figcaption><div class="pia-pbox">${piaFrame(sc)}</div></figure></div>`
        :`<div class="pia-over"><div class="pia-dim">Arraste: esquerda = Prévia real · direita = protótipo</div><div class="pia-ovbox" style="${devW?'width:'+devW+'px':''}"><div class="pia-pbox">${piaFrame(sc)}</div><div class="pia-live pia-clip" style="clip-path:inset(0 ${100-c.pos}% 0 0)"></div><div class="pia-cut" style="left:${c.pos}%"></div></div><input type="range" class="pia-range" min="0" max="100" value="${c.pos}" data-pia-cmp="pos" aria-label="Posição da comparação: Prévia à esquerda, protótipo à direita"></div>`;
    stage.insertAdjacentHTML('afterbegin', `<div class="pia-cmp" data-sig="${piaEscA(sig)}"><div class="pia-cmphd">${seg}${lab}<span class="sp"></span><button type="button" class="btn ghost sm" data-pia-cmp="open">Abrir protótipo</button></div><div class="pia-dhost"></div>${body}</div>`);
    box=stage.querySelector('.pia-cmp');
    requestAnimationFrame(()=>piaFit(box));
    if(!box.__ro && window.ResizeObserver){ box.__ro=new ResizeObserver(()=>piaFit(box)); box.__ro.observe(box); }
  }
  const dh=box.querySelector('.pia-dhost'); const dhtml=piaCmpDiffsHtml(t, c); if(dh && dh.__h!==dhtml){ dh.__h=dhtml; dh.innerHTML=dhtml; }
  const live=box.querySelector('.pia-live'); if(live && typeof appRender==='function') appRender(t.id, live);
  if(c.mode==='sobre' && live){ live.style.position='absolute'; live.style.inset='0'; }
  c.protoId=meta.id;
}
async function piaVerDiffs(t){
  const c=piaC(t.id), meta=piaTaskProto(t.id); if(!meta || c.st==='loading') return;
  c.st='loading'; c.err=null; if(typeof renderWorkspace==='function') renderWorkspace();
  try{
    const proto=PIA.protos[meta.id]||await piaRead(meta.id); PIA.protos[meta.id]=proto;
    const dev=typeof mrDev==='function'?mrDev(t.id):'web', sid=piaScreenFor(dev);
    let realShot=null, realRel=null;
    try{ const st=typeof nvSt==='function'?nvSt(t.id):null;
      if(st && st.frame && typeof nvSnap==='function' && typeof nvShotRect==='function'){ const fr=st.frame.getBoundingClientRect();
        const rect=nvShotRect({ left:Math.max(0,fr.left), top:Math.max(0,fr.top), right:Math.min(innerWidth,fr.right), bottom:Math.min(innerHeight,fr.bottom) }, { x:0, y:0, w:fr.width, h:fr.height });
        if(rect){ const r=await nvSnap(t.id, rect, 'attachment', { text:'proto-real', tag:'pagina' }); if(r){ realRel=r.rel||null; realShot=r.path||(r.rel&&t.worktree?t.worktree+'/'+r.rel:r.rel)||null; } } } }catch(_){ }
    let protoShot=null; try{ const url=await piaSnap(sid); if(url){ const f=await piaPutPng(proto.id, 'compara-'+sid+'-v'+(proto.version||1)+'.png', url); protoShot=f&&f.abs; } }catch(_){ }
    c.ctx={ title:proto.title, version:proto.version, screen:sid, ref:piaRefPath(proto.id), realRel, protoShot };
    const text=await piaRun('diff', piaPromptDiff(proto, sid, { realShot, protoShot, branch:t.branch, dev:typeof mrDevLabel==='function'?mrDevLabel(dev):dev }), { repo:t.worktree||null });
    const r=piaParseDiffs(text); c.diffs=r.diffs; c.iguais=r.iguais; c.sent={}; c.st='idle';
  }catch(e){
    if(piaStopped(e)){ c.st='idle'; }
    else { c.st='erro'; c.err=piaErr(e); }
  }
  if(typeof renderWorkspace==='function') renderWorkspace();
}
async function piaSendDiffs(t, keys){
  const c=piaC(t.id); const L=(c.diffs||[]).filter(d=>keys.includes(d.key) && !c.sent[d.key]); if(!L.length) return;
  const txt=piaDiffAgentText(L, c.ctx||{});
  const ok=typeof tiSend==='function'?await tiSend(t.id, txt):false;
  if(ok){ L.forEach(d=>{ c.sent[d.key]=1; }); toast('Mandado pro terminal da tarefa com a referência do protótipo'+(c.ctx&&c.ctx.realRel?' e o print da Prévia':'')+'.','ok'); }
  if(typeof renderWorkspace==='function') renderWorkspace();
}
document.addEventListener('click', ev=>{
  const b=ev.target.closest&&ev.target.closest('[data-pia-cmp]'); if(!b) return;
  const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(!t) return;
  const c=piaC(t.id), k=b.dataset.piaCmp;
  if(k==='toggle'){ c.on=!c.on; if(c.on) piaListRefresh(true); }
  else if(k==='mode'){ c.mode=b.dataset.v==='sobre'?'sobre':'lado'; }
  else if(k==='diff'){ piaVerDiffs(t); return; }
  else if(k==='stopdiff'){ invoke('proto_ai_stop', { kind:'diff' }).catch(()=>{}); return; }
  else if(k==='engine'){ if(window.suaIaOpenCfg) window.suaIaOpenCfg(); return; }
  else if(k==='send'){ piaSendDiffs(t, [b.dataset.k]); return; }
  else if(k==='sendall'){ piaSendDiffs(t, (c.diffs||[]).map(d=>d.key)); return; }
  else if(k==='open'){ if(c.protoId && typeof openPrototipo==='function') openPrototipo(c.protoId); else toast('A aba Protótipo não está disponível nesta versão.','info'); return; }
  else return;
  if(typeof renderWorkspace==='function') renderWorkspace();
});
document.addEventListener('input', ev=>{
  const r=ev.target; if(!(r && r.dataset && r.dataset.piaCmp==='pos')) return;
  const t=typeof fwTaskObj==='function'?fwTaskObj():null; if(!t) return;
  const c=piaC(t.id); c.pos=+r.value||0; const box=r.closest('.pia-cmp'); if(!box) return;
  const live=box.querySelector('.pia-clip'), cut=box.querySelector('.pia-cut');
  if(live) live.style.clipPath='inset(0 '+(100-c.pos)+'% 0 0)'; if(cut) cut.style.left=c.pos+'%';
});
try{ window.addEventListener('sf:proto-salvo', ev=>{ const id=ev&&ev.detail&&ev.detail.id; if(id){ delete PIA.protos[id]; const s=PIA.s[id]; if(s && s.st!=='loading'){ piaCur(id).then(p=>{ if(p){ s.proto=p; piaRepaint(id); } }).catch(()=>{}); } } PIA.listAt=0; }); }catch(_){ }
