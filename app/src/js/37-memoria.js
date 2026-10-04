/* ===== MEMÓRIA DO PROJETO — o cérebro (notas .md ligadas por [[links]], compatível com Obsidian) =====
   Aba "memoria": lista + busca, nota renderizada com [[links]] clicáveis e backlinks, editor, nova nota,
   grafo, mover entre time/local e "abrir no Obsidian". Os arquivos moram em <repo>/.cardume/memoria/
   (local) e .cardume/memoria/time/ (espelho do cérebro do TIME, tabela brain_notes — sync mais-recente-vence,
   apagar = lápide). Rust: app/src-tauri/src/memoria.rs · motor: src/memory.ts. */

// @puro-inicio — funções sem DOM (testadas em app/tests/memoria.test.mjs)
const MEM_TYPES=['decisão','regra','gotcha','contexto','pessoa','glossário'];
const MEM_KNOWN_KEYS=['title','type','tags','updated','by','origem','atualizada_por'];
function memFold(s){ return String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); }
function memFnv(s){ let h=0x811c9dc5; for(const b of new TextEncoder().encode(s)){ h^=b; h=Math.imul(h,0x01000193)>>>0; } return h.toString(16).padStart(8,'0'); }
// igual ao slugify do motor/Rust (título só com escrita não latina → nota-<hash>)
function memSlug(s){ const o=memFold(s).replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60).replace(/-+$/,''); if(o) return o; const t=String(s==null?'':s).trim(); return t?'nota-'+memFnv(t):'nota'; }
function memYaml(s){ const t=String(s==null?'':s).replace(/\s+/g,' ').trim(); return (/^[\wÀ-ſ][\wÀ-ſ .,()/·-]*$/.test(t) && !/:\s|\s#/.test(t))?t:JSON.stringify(t); }
function memUnquote(v){ const t=String(v).trim(); if(t.length>=2&&t[0]==='"'&&t.endsWith('"')){ try{ return JSON.parse(t); }catch(_){ return t.slice(1,-1); } } if(t.length>=2&&t[0]==="'"&&t.endsWith("'")) return t.slice(1,-1).replace(/''/g,"'"); return t; }
// frontmatter igual ao parseFrontmatter do src/memory.ts
function memParseFm(text){
  const src=String(text==null?'':text).replace(/^﻿/,'').replace(/\r\n/g,'\n'); const data={};
  if(!src.startsWith('---\n')) return { data, body:src };
  const end=src.indexOf('\n---',4); if(end<0) return { data, body:src };
  let body=src.slice(end+4); if(body.startsWith('\n')) body=body.slice(1);
  let last='';
  for(const line of src.slice(4,end).split('\n')){
    const it=line.match(/^\s+-\s+(.*)$/);
    if(it&&last){ const c=data[last]; data[last]=[...(Array.isArray(c)?c:c?[c]:[]), memUnquote(it[1])]; continue; }
    const m=line.match(/^([A-Za-zÀ-ú_][\wÀ-ú-]*)\s*:\s*(.*)$/); if(!m) continue;
    last=m[1]; const v=m[2].trim();
    data[last]=(v.startsWith('[')&&v.endsWith(']'))?v.slice(1,-1).split(',').map(memUnquote).filter(Boolean):memUnquote(v);
  }
  return { data, body };
}
// nota do arquivo → campos do editor (+ chaves que o app não conhece, preservadas no salvar)
function memFromFile(text){
  const { data, body }=memParseFm(text); const s=k=>(Array.isArray(data[k])?data[k].join(', '):String(data[k]==null?'':data[k])).trim();
  const tr=data.tags; const tags=(Array.isArray(tr)?tr:tr?String(tr).split(/[,\s]+/):[]).map(t=>t.replace(/^#/,'').trim()).filter(Boolean);
  const extra={}; for(const k of Object.keys(data)) if(!MEM_KNOWN_KEYS.includes(k)) extra[k]=data[k];
  const t=memFold(s('type')); const type=MEM_TYPES.find(x=>memFold(x)===t)||(/^decis/.test(t)?'decisão':/^glos/.test(t)?'glossário':'contexto');
  return { title:s('title'), type, tags, updated:s('updated'), by:s('by'), origem:s('origem')==='agente'?'agente':'pessoa', atualizadaPor:s('atualizada_por'), extra, body:body.trim() };
}
// mesmo formato do src/memory.ts (serializeNote): frontmatter + chaves extras + corpo
function memSerialize(n){
  const list=v=>'['+(v||[]).map(memYaml).join(', ')+']';
  let extra=''; for(const [k,v] of Object.entries(n.extra||{})) extra+=k+': '+(Array.isArray(v)?list(v):memYaml(v))+'\n';
  return '---\ntitle: '+memYaml(n.title)+'\ntype: '+(n.type||'contexto')+'\ntags: '+list(n.tags)+'\nupdated: '+(n.updated||'')+'\nby: '+memYaml(n.by||'')+'\norigem: '+(n.origem==='agente'?'agente':'pessoa')+'\n'+
    (n.atualizadaPor?'atualizada_por: '+memYaml(n.atualizadaPor)+'\n':'')+extra+'---\n'+String(n.body||'').trim()+'\n';
}
function memToday(d){ d=d||new Date(); const p=x=>String(x).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
// resolve um alvo de [[link]] numa nota (mesmo escopo primeiro; aceita slug, título ou nome do arquivo)
function memResolve(notes, target, scope){
  const s=memSlug(target), f=memFold(String(target).trim());
  const hit=n=>n.slug===s || memSlug(n.slug)===s || memFold(n.title)===f;
  return notes.find(n=>hit(n)&&n.scope===scope) || notes.find(hit) || null;
}
// [[links]] do HTML já renderizado (mdToHtml escapou tudo) → links internos; quebrado → "criar esta nota"
function memLinkify(html, notes, scope){
  return String(html).replace(/\[\[([^\]|#\n<]+)(?:#[^\]|\n<]*)?(?:\|([^\]\n<]+))?\]\]/g,(m,target,alias)=>{
    const label=(alias||target).trim();
    const raw=target.replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const n=memResolve(notes, raw, scope);
    const q=v=>String(v).replace(/"/g,'&quot;');
    if(n) return '<a class="memlink" data-mscope="'+q(n.scope)+'" data-mslug="'+q(n.slug)+'">'+label+'</a>';
    return '<a class="memlink broken" data-mcreate="'+q(target.trim())+'" title="criar esta nota">'+label+'</a>';
  });
}
function memBacklinks(notes, note){
  if(!note) return [];
  return notes.filter(n=>n!==note && (n.links||[]).some(l=>{ const r=memResolve(notes,l,n.scope); return r && r.slug===note.slug && r.scope===note.scope; }));
}
function memFilter(notes, q, type){
  const t=memFold(q||'').split(/\s+/).filter(Boolean);
  return notes.filter(n=>{
    if(type && n.type!==type) return false;
    if(!t.length) return true;
    const hay=memFold([n.title,n.slug,(n.tags||[]).join(' '),n.summary||'',n.body||''].join(' '));
    return t.every(w=>hay.includes(w));
  });
}
// layout por força simples (repulsão + mola + gravidade), determinístico. Custo ~N²·iters: as iterações
// caem com N (teto de ~3M pares por desenho) — cérebro grande não trava a janela.
function memForceIters(N){ return Math.max(12, Math.min(260, Math.floor(3e6/Math.max(1,N*N)))); }
function memForceLayout(nodes, edges, w, h, iters){
  const N=nodes.length; if(!N) return [];
  iters=iters||memForceIters(N);
  const pos=nodes.map((n,i)=>{ const a=i*2.399963, r=Math.sqrt(i+.5)/Math.sqrt(N)*Math.min(w,h)*.42; return { x:w/2+Math.cos(a)*r, y:h/2+Math.sin(a)*r }; });
  const idx={}; nodes.forEach((n,i)=>{ idx[n.id]=i; });
  const E=edges.map(e=>[idx[e.from],idx[e.to]]).filter(e=>e[0]!=null&&e[1]!=null&&e[0]!==e[1]);
  const k=Math.sqrt(w*h/Math.max(N,1))*.55;
  for(let it=0; it<iters; it++){
    const t=(1-it/iters)*k*.35+.5; const d=pos.map(()=>({x:0,y:0}));
    for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){
      let dx=pos[i].x-pos[j].x, dy=pos[i].y-pos[j].y; let dist=Math.hypot(dx,dy)||.01; const f=k*k/dist;
      dx/=dist; dy/=dist; d[i].x+=dx*f; d[i].y+=dy*f; d[j].x-=dx*f; d[j].y-=dy*f; }
    for(const [a,b] of E){ let dx=pos[a].x-pos[b].x, dy=pos[a].y-pos[b].y; const dist=Math.hypot(dx,dy)||.01; const f=dist*dist/k; dx/=dist; dy/=dist; d[a].x-=dx*f; d[a].y-=dy*f; d[b].x+=dx*f; d[b].y+=dy*f; }
    for(let i=0;i<N;i++){ d[i].x+=(w/2-pos[i].x)*.02*k; d[i].y+=(h/2-pos[i].y)*.02*k;
      const l=Math.hypot(d[i].x,d[i].y)||1; pos[i].x+=d[i].x/l*Math.min(l,t); pos[i].y+=d[i].y/l*Math.min(l,t);
      pos[i].x=Math.max(20,Math.min(w-20,pos[i].x)); pos[i].y=Math.max(20,Math.min(h-20,pos[i].y)); }
  }
  return pos;
}
/* Decisão do sync do cérebro do TIME, nota a nota (sem I/O):
   local = notas de .cardume/memoria/time/ ({slug, mtimeMs, body}); rows = brain_notes ({slug, body, updated_at, deleted_at});
   known = slugs sincronizados com sucesso da última vez; localEmpty = espelho vazio (1º sync: só puxa, NUNCA apaga);
   lastSync = quando o último sync completo começou (edição do colega depois disso vence a nossa remoção local).
   → pull (nuvem → arquivo), push (arquivo → nuvem), delLocal (lápide mais nova que o arquivo),
     tombstoneCloud (apagado aqui, fora do app), rename (nota local nova com o MESMO nome de uma do colega:
     vira <slug>-N em vez de sobrescrever), keep (já iguais). */
function memSyncPlan(local, rows, known, localEmpty, lastSync){
  const L={}; (local||[]).forEach(n=>{ L[n.slug]=n; });
  const P={ pull:[], push:[], delLocal:[], tombstoneCloud:[], rename:[], keep:[] };
  const seen=new Set();
  for(const r of rows||[]){
    seen.add(r.slug); const l=L[r.slug]; const t=Date.parse(r.updated_at)||0;
    if(r.deleted_at){
      if(!l) continue;                                     // lápide e nada aqui: nada a fazer
      const td=Date.parse(r.deleted_at)||t;
      if(l.mtimeMs>td+2000) P.push.push(r.slug);           // editei depois da remoção: a edição revive a nota
      else P.delLocal.push(r.slug);                        // remoção mais nova que a minha cópia
      continue;
    }
    if(!l){
      if(!localEmpty && known.has(r.slug) && t<=(lastSync||0)+2000) P.tombstoneCloud.push(r.slug); // apaguei aqui (fora do app)
      else P.pull.push(r.slug);                            // nova do colega, ou editada por ele depois
      continue;
    }
    if(!known.has(r.slug) && String(l.body||'').trim()!==String(r.body||'').trim()){ P.rename.push(r.slug); continue; } // mesmo nome, notas diferentes
    if(t>l.mtimeMs+2000) P.pull.push(r.slug);
    else if(l.mtimeMs>t+2000) P.push.push(r.slug);
    else P.keep.push(r.slug);
  }
  for(const l of local||[]) if(!seen.has(l.slug)) P.push.push(l.slug); // nunca subiu (ou a linha sumiu): sobe
  return P;
}
// resumo da lista em texto corrido: o Rust (summary_of) corta a 1ª linha crua — sem isto a lista mostrava
// "**pnpm** (lockfile `pnpm-lock.ya…" com os asteriscos, crases e [[colchetes]] do markdown
function memPlain(s){
  let t=String(s==null?'':s); const code=[];
  // 1) código primeiro: `__init__.py`, `*.md` e `**x**` dentro de crases ficam como estão
  t=t.replace(/`+([^`\n]*?)`+/g,(m,c)=>{ code.push(c); return '\u0000'+(code.length-1)+'\u0000'; });
  t=t.replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g,(m,a,b)=>(b||a).trim())
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g,'$1');
  // 2) ênfase só com fronteira de palavra dos dois lados (nomes_com_underscore e __init__.py não são ênfase)
  const END='(?=$|\\s|[,;:!?)\\]]|\\.(?:\\s|$))';
  t=t.replace(new RegExp('(^|[\\s(\\[>])(\\*\\*|__)(?=\\S)([^\\n]*?\\S)\\2'+END,'g'),'$1$3')
    .replace(new RegExp('(^|[\\s(\\[>])([*_])(?=[^\\s*_])([^*_\\n]*?[^\\s*_])\\2'+END,'g'),'$1$3')
    .replace(/~~([^~\n]+)~~/g,'$1');
  // 3) o corte do resumo (110 chars) deixa delimitador aberto: "**pnpm (lockfile `pnpm-lo…" — tira só os de abertura órfãos
  t=t.replace(/(^|[\s(\[])(\*\*|__|~~)(?=\S)/g,(m,a,d,i,all)=>all.indexOf(d,i+m.length)<0?a:m).replace(/`+/g,'').replace(/\[\[(?![^\]]*\]\])/g,'');
  t=t.replace(/\u0000(\d+)\u0000/g,(m,n)=>code[+n]);
  return t.replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+|#+\s*)/,'').replace(/\s+/g,' ').trim();
}
// "2026-09-26" → "26/09" (este ano) ou "26/09/2025"; o resto passa como veio
function memDateBR(iso, now){
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/); if(!m) return String(iso||'');
  const y=(now||new Date()).getFullYear();
  return m[3]+'/'+m[2]+(+m[1]===y?'':'/'+m[1]);
}
// erro do disco (Rust devolve o io::Error em inglês: "No such file or directory (os error 2)") → frase em pt-BR.
// O que o catálogo global já traduz (permissão, disco cheio) e o que já vem em português passa como veio.
const MEM_IO_ERR=[
  [/no such file or directory|os error 2\b|\bENOENT\b|cannot find the (file|path) specified|os error 3\b/i, 'o arquivo ou a pasta da memória não existe mais (foi movido ou apagado fora do app) — recarregue a Memória'],
  [/read-only file system|os error 30\b|\bEROFS\b/i, 'a pasta do projeto está só leitura (disco protegido ou montado sem escrita)'],
  [/is a directory|os error 21\b/i, 'no lugar da nota existe uma pasta com o mesmo nome'],
  [/not a directory|os error 20\b/i, 'no lugar da pasta da memória existe um arquivo com o mesmo nome'],
  [/file exists|os error 17\b|os error 183\b|already exists/i, 'já existe uma nota com esse nome'],
  [/directory not empty|os error 66\b|os error 39\b|os error 145\b|directory is not empty/i, 'a pasta não está vazia'],
  [/stream did not contain valid utf-8|invalid utf-8/i, 'a nota não está em texto UTF-8 (foi salva por outro programa num formato que o app não lê)'],
];
function memErrText(e){
  const raw=String((e&&e.message)||e||'').trim();
  for(const [re,msg] of MEM_IO_ERR) if(re.test(raw)) return msg;
  return raw;
}
// pro showErr: o texto traduzido + o cru original ("ver detalhes" mantém o "(os error N)" pra quem for investigar).
// Acesso negado do Windows (os error 5) vai pro catálogo global de permissão.
function memErr(e){
  const raw=String((e&&e.message)||e||'').trim();
  if(/access is denied|os error 5\b/i.test(raw)) return { message:'Permission denied — '+raw, raw };
  const t=memErrText(e); return t===raw ? e : { message:t, raw };
}
// ---- aprendizados para revisar (fila da retro do fim da tarefa: .cardume/aprendizado/pendentes.json) ----
function memLEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// rótulo do tipo: nota (com o tipo dela), skill nova ou atualização de uma skill aprendida que já existe
function memLearnLabel(it){
  if(it && it.kind==='persona') return 'persona nova';
  if(it && it.kind==='skill'){ const s=it.skill||{}; return s.acao==='atualizar'?'atualiza a skill '+(s.nome||''):'skill nova'; }
  return 'nota · '+((it&&it.nota&&it.nota.type)||'contexto');
}
// P9 (mesa 03/10): o aprendizado chega como FRASE em português com o nome do agente dono; skill, versão e corpo
// só em "ver detalhes". Fonte única do cartão: Memória, ficha do agente (61-meu-time) e etapa Retro da tarefa.
const MEM_ART={ vega:'A', iris:'A', nyx:'A', aria:'A', lumen:'A', cobalt:'O' }; // artigo dos agentes do catálogo padrão
function memLearnWho(it){
  const id=String((it&&it.agente)||'').trim(); if(!id) return null;
  const name=String((it&&it.agenteNome)||'').trim() || id.charAt(0).toUpperCase()+id.slice(1);
  return { id, name, art:MEM_ART[id]||'' };
}
function memLearnSentence(it){
  const w=memLearnWho(it), sk=it&&it.kind==='skill', d=sk?((it&&it.skill)||{}):((it&&it.nota)||{});
  const low=s=>{ s=String(s||'').replace(/\s+/g,' ').trim().replace(/[.;:!]+$/,''); return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(s)?s.charAt(0).toLowerCase()+s.slice(1):s; };
  // F5: persona sugerida pela retro (só com a P12 madura) — a frase diz o porquê; o texto e o diff ficam em "ver detalhes"
  if(it && it.kind==='persona') return (w ? (w.art?w.art+' ':'')+w.name : 'O agente')+' vai mudar o jeito de trabalhar'+((it.persona||{}).porque?', porque '+low(it.persona.porque):'')+'.';
  const tx=sk ? 'um jeito de fazer: '+String(d.nome||'').replace(/-/g,' ')+(d.descricao?' — '+low(d.descricao):'') : low(d.title);
  return (w ? (w.art?w.art+' ':'')+w.name : 'O projeto')+' vai lembrar'+(sk?' ':': ')+tx+'.';
}
// o: { editing:{ a, b } } — o cartão em modo Editar (o texto que a pessoa está mudando)
// de onde veio: a tarefa da retro, ou "compartilhado pelo time por Ana" (F5 · P17, trazido do time)
function memLearnSrc(it){ return it&&it.origem==='time' ? memLEsc(it.taskTitle||'compartilhado pelo time') : 'da tarefa '+(it.taskTitle?'"'+memLEsc(it.taskTitle)+'"':memLEsc(it.taskId||'')); }
// F5: o cartão da persona sugerida — só "Guardar pra X" (persona é do agente: não existe "só no projeto"), Editar o texto
// novo e Descartar; o diff antes → depois em "ver detalhes" (agLineDiff do 61-meu-time, quando carregado)
function memPersonaCard(it, o){
  const p=it.persona||{}, id=memLEsc(it.id), w=memLearnWho(it), ed=o.editing;
  const diff=(typeof agLineDiff==='function')?agLineDiff(p.antes||'', ed?ed.b:(p.texto||'')).map(l=>'<span class="d'+(l.t==='+'?'a':l.t==='-'?'r':'c')+'">'+memLEsc((l.t==='='?'  ':l.t+' ')+l.s)+'</span>').join('\n'):memLEsc(p.texto||'');
  const edit=ed?'<div class="memledit"><label>A persona nova (o texto inteiro)<textarea class="in" id="le-b-'+id+'" data-leditb rows="8">'+memLEsc(ed.b)+'</textarea></label></div>':'';
  return '<article class="memlcard" data-lid="'+id+'">'+
    '<p class="memlsent">'+memLEsc(memLearnSentence(it))+'</p>'+
    '<div class="memlsrc dim">'+memLearnSrc(it)+'</div>'+
    edit+
    '<div class="memlacts">'+(w?'<button class="btn sm primary" data-laccept="'+id+'" data-como="agente">Guardar pra '+memLEsc(w.name)+'</button>':'')+
      (ed?'<button class="btn sm" data-ledit="'+id+'" data-off="1">cancelar edição</button>':'<button class="btn sm" data-ledit="'+id+'">Editar</button>')+'<button class="btn sm" data-ldiscard="'+id+'">Descartar</button></div>'+
    '<details class="memldet"><summary>ver detalhes</summary>'+
      '<div class="memlhd"><span class="membadge nota">persona nova</span>'+(w?' <span class="dim">· dono: '+memLEsc(w.id)+(it.papel?' ('+memLEsc(it.papel)+')':'')+'</span>':'')+'</div>'+
      '<pre class="agf-diff memlbody">'+diff+'</pre>'+
      (w?'<div class="memlwhy dim">guardar troca a persona de '+memLEsc(w.name)+' e cria uma versão nova (dá pra voltar com 1 clique). A retro só sugere isso pra quem já tem '+'10 tarefas medidas na versão atual.</div>':'')+
    '</details>'+
  '</article>';
}
function memLearnCard(it, o){
  o=o||{};
  if(it && it.kind==='persona') return memPersonaCard(it, o);
  const sk=it.kind==='skill', d=sk?(it.skill||{}):(it.nota||{});
  const title=sk?(d.nome||''):(d.title||''), body=sk?(d.corpo||''):(d.body||'');
  const id=memLEsc(it.id), w=memLearnWho(it);
  const ed=o.editing;
  // ids estáveis: um repaint (custo, faixa) devolve o foco pro campo que a pessoa estava digitando
  const edit=ed?'<div class="memledit"><label>'+(sk?'Quando usar':'O que lembrar')+'<input class="in" id="le-a-'+id+'" data-ledita value="'+memLEsc(ed.a)+'"></label><label>'+(sk?'Como fazer':'Detalhe')+'<textarea class="in" id="le-b-'+id+'" data-leditb rows="5">'+memLEsc(ed.b)+'</textarea></label></div>':'';
  const keep=w?'<button class="btn sm primary" data-laccept="'+id+'" data-como="agente">Guardar pra '+memLEsc(w.name)+'</button><button class="btn sm" data-lproj="'+id+'">Só no projeto</button>'
    :'<button class="btn sm primary" data-laccept="'+id+'" data-como="projeto">Guardar no projeto</button>';
  return '<article class="memlcard" data-lid="'+id+'">'+
    '<p class="memlsent">'+memLEsc(memLearnSentence(it))+'</p>'+
    '<div class="memlsrc dim">'+memLearnSrc(it)+'</div>'+
    edit+
    '<div class="memlacts">'+keep+(ed?'<button class="btn sm" data-ledit="'+id+'" data-off="1">cancelar edição</button>':'<button class="btn sm" data-ledit="'+id+'">Editar</button>')+'<button class="btn sm" data-ldiscard="'+id+'">Descartar</button></div>'+
    '<details class="memldet"><summary>ver detalhes</summary>'+
      '<div class="memlhd"><span class="membadge '+(sk?'skill':'nota')+'">'+memLEsc(memLearnLabel(it))+'</span><b>'+memLEsc(title)+'</b>'+(w?' <span class="dim">· dono: '+memLEsc(w.id)+(it.papel?' ('+memLEsc(it.papel)+')':'')+'</span>':'')+'</div>'+
      (sk&&d.descricao?'<div class="memldesc">'+memLEsc(d.descricao)+'</div>':'')+
      '<pre class="memlbody">'+memLEsc(body)+'</pre>'+
      (sk&&d.porque?'<div class="memlwhy dim">por quê: '+memLEsc(d.porque)+'</div>':'')+
      (w?'<div class="memlwhy dim">guardar pra '+memLEsc(w.name)+' cria uma versão nova dela (dá pra voltar com 1 clique)</div>':'')+
      (sk&&d.acao==='atualizar'&&it.atual!=null?'<details class="memlcur"><summary>versão atual (aceitar substitui o corpo inteiro)</summary><pre class="memlbody">'+memLEsc(it.atual)+'</pre></details>':'')+
    '</details>'+
  '</article>';
}
function memLearnHtml(items, edits){
  const n=(items||[]).length; if(!n) return '';
  return '<details class="memlearn" open><summary>Aprendizados para revisar ('+n+') <span class="dim">· o que a retro do fim das tarefas propôs — nada entra no cérebro nem vira skill sem o seu aceite</span></summary>'+
    '<div class="memlgrid">'+items.map(it=>memLearnCard(it, { editing:edits&&edits[it.id] })).join('')+'</div></details>';
}
// o que muda a contagem da fila: troca de projeto ou evento novo "aprendizado…" que o motor grava ao enfileirar
function memLearnSigOf(snap){ return (snap&&snap.repo||'')+'|'+((snap&&snap.events)||[]).filter(e=>/^aprendizado/.test(String(e&&e.text||''))).map(e=>e.id).join(','); }
// @puro-fim

const MEM_COLORS={ 'decisão':'var(--info)', regra:'var(--ok)', gotcha:'var(--warn)', contexto:'var(--muted)', pessoa:'var(--purple)', 'glossário':'var(--cyan)' };
// cor de cada tipo de nota = token do tema. O canvas não entende var(): memCss resolve o token UMA vez por tema (cache
// MEM_PAL, limpo no 'sf-theme', quando o grafo também repinta) — nada de getComputedStyle por nó a cada pintura
// @mem-cor-puro-inicio (testado em app/tests/tema-movimento.test.mjs)
const MEM_HEX={ 'decisão':'var(--info)', regra:'var(--ok)', gotcha:'var(--warn)', contexto:'var(--muted)', pessoa:'var(--purple)', 'glossário':'var(--cyan)' };
let MEM_PAL={};
function memCss(v, a){ const m=String(v||'').match(/^var\((--[\w-]+)\)$/); let c=v;
  if(m){ c=MEM_PAL[m[1]]; if(c===undefined){ try{ c=getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()||'gray'; }catch(_){ c='gray'; } MEM_PAL[m[1]]=c; } }
  const h=String(c).match(/^#([0-9a-f]{6})$/i); if(a==null || !h) return c; const n=parseInt(h[1],16); return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; }
// @mem-cor-puro-fim
if(typeof window!=='undefined' && window.addEventListener) window.addEventListener('sf-theme', ()=>{ MEM_PAL={}; if(typeof memG!=='undefined' && memG) memPaint(); });
const MEM_IC={
  brain:'<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.4A2 2 0 0 0 4.2 12 2 2 0 0 0 8 12.6V3.6A2 2 0 0 0 6 2.8zM10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.4 2 2 0 0 1-1.5 3.8A2 2 0 0 1 8 12.6" stroke-linejoin="round"/>',
  plus:'<path d="M8 3.5v9M3.5 8h9"/>',
  graph:'<circle cx="4" cy="11.5" r="1.7"/><circle cx="12" cy="11" r="1.7"/><circle cx="8" cy="4" r="1.7"/><path d="M5 10l2.2-4.4M11 9.6L8.9 5.5M5.7 11.4h4.6"/>',
  list:'<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><path d="M2.6 4.5h.05M2.6 8h.05M2.6 11.5h.05" stroke-width="1.8"/>',
  ext:'<path d="M9 3h4v4M13 3L7.5 8.5"/><path d="M11.5 9.5v3.2H3.3V4.5h3.2"/>',
  edit:'<path d="M10.6 2.9l2.5 2.5-7.3 7.3H3.3v-2.5z" stroke-linejoin="round"/>',
  move:'<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
  trash:'<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.8 4.5l.6 8.5h5.2l.6-8.5"/>',
  sync:'<path d="M12.8 6.5A5 5 0 0 0 3.6 5M3.2 9.5a5 5 0 0 0 9.2 1.5"/><path d="M3.4 2.6V5h2.4M12.6 13.4V11h-2.4"/>',
};
function memIc(n,sz){ sz=sz||13; return '<svg viewBox="0 0 16 16" width="'+sz+'" height="'+sz+'" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">'+(MEM_IC[n]||'')+'</svg>'; }
function memEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const MEM={ notes:[], learn:[], mode:'local', explicit:false, root:'', hasTeam:false, sel:null, q:'', type:'', view:'lista', edit:null, repo:'', syncMsg:'' };
function memSeenKey(){ return 'memSeen:'+(MEM.repo||state.repo||''); }
function memSeen(){ try{ return JSON.parse(lsGet(memSeenKey())||'{}')||{}; }catch(_){ return {}; } }
function memIsNew(n){ return n.origem==='agente' && (memSeen()[n.scope+':'+n.slug]||0) < n.mtimeMs; }
function memMarkSeen(n){ if(!n) return; const s=memSeen(); s[n.scope+':'+n.slug]=n.mtimeMs; lsSet(memSeenKey(), JSON.stringify(s)); }
function memWho(){
  try{ const p=cloudData&&cloudData.profileByUser&&cloudData.profileByUser[cloudUserId()]; if(p&&(p.name||p.email)) return p.name||p.email; }catch(_){ }
  return 'você (nesta máquina)';
}
function memSelNote(){ return MEM.sel ? MEM.notes.find(n=>n.scope===MEM.sel.scope && n.slug===MEM.sel.slug)||null : null; }
function memVisible(){ const o=$id('memOverlay'); return !!(o && o.style.display!=='none'); }

async function memLoad(repo){
  repo=repo||MEM.repo||state.repo;
  let r;
  try{ r=await invoke('memory_list',{ repo, withBody:true })||{}; }
  catch(e){ const t=memErrText(e); if(t===String((e&&e.message)||e||'').trim()) throw e; const x=new Error('Não consegui ler a memória — '+t); x.ldHuman=true; throw x; }
  MEM.notes=r.notes||[]; MEM.mode=r.mode||'local'; MEM.explicit=!!r.explicitMode; MEM.root=r.root||''; MEM.repo=repo;
  try{ MEM.learn=await invoke('learn_pending',{ repo })||[]; }catch(_){ MEM.learn=[]; } // fila é extra: falhar não esconde as notas
  if(repo===state.repo) memLearnBadge(MEM.learn.length);
}
// selo "N aprendizados pra revisar" no item Memória do menu (e o ponto no botão "mais") — sem poll próprio:
// refresh() chama memLearnTick a cada snapshot e ele só lê a fila quando a assinatura muda
let memLearnSig=null;
function memLearnBadge(n){
  window.memLearnN=n;
  const b=$id('memBtn'); if(!b) return;
  let el=b.querySelector('.memlbadge');
  if(!el){ el=document.createElement('span'); el.className='memlbadge'; b.appendChild(el); }
  el.textContent=n>99?'99+':String(n); el.style.display=n>0?'':'none';
  el.title=n+' aprendizado'+(n===1?'':'s')+' pra revisar';
  const md=$id('moreDot'); if(md && n>0) md.style.display='block';
}
async function memLearnTick(snap){
  const sig=memLearnSigOf(snap); if(sig===memLearnSig) return; memLearnSig=sig;
  if(!snap||!snap.repo){ memLearnBadge(0); return; }
  try{ const l=await invoke('learn_pending',{ repo:snap.repo })||[]; if(state.repo===snap.repo) memLearnBadge(l.length); }catch(_){ }
}
window.memLearnTick=memLearnTick;
async function memTeamAvailable(){ try{ return !!(SB.configured() && SB.sess() && cloudData && cloudData.org && await prefsKey()); }catch(_){ return false; } }

async function openMemoria(){
  const ov=$id('memOverlay'); if(!ov) return;
  if(!state.repo){ toast('Abra um projeto primeiro.','warn'); return; }
  if(MEM.repo && MEM.repo!==state.repo){ MEM.sel=null; MEM.edit=null; MEM.q=''; MEM.type=''; }
  ovShow(ov);
  // pinta lista + nota em esqueleto na hora (se já havia notas na tela, mantém elas até a leitura nova chegar)
  // F4 · P13: o curador roda AO ABRIR (no máximo 1×/dia — o resto do dia usa o guardado); falhar não esconde as notas
  // (o curador não segura as notas: pinta quando chegar, igual ao sync do time)
  await loadInto($id('memBody'), 'nota', async()=>{ await memLoad(state.repo); MEM.hasTeam=await memTeamAvailable(); }, ()=>{
    memRender();
    if(typeof curLoad==='function'){ const r=state.repo; curLoad(r).then(()=>{ if(memVisible() && MEM.repo===r) memRender(); }).catch(()=>{}); }
    if(MEM.hasTeam) memTeamSync().then(ch=>{ if(ch) memRefresh(); });
  }, { label:'lendo a memória do projeto', ctx:'Não consegui ler a memória', keep:MEM.notes.length>0 && MEM.repo===state.repo });
}
window.openMemoria=openMemoria;
// recarrega e redesenha sem perder o que está sendo digitado
async function memRefresh(){ if(!memVisible() || !MEM.repo) return; memCaptureEdit(); try{ await memLoad(MEM.repo); }catch(_){ return; } memRender(); }

function memModeSeg(id){
  const opts=[['time','Time','sincroniza com o time (padrão quando o projeto está num time)'],['local','Local','só nesta máquina; os agentes ainda leem o time'],['so-local','Só local','os agentes ignoram o cérebro do time']];
  return '<div class="memseg" id="'+id+'" role="radiogroup" aria-label="Onde salvar as memórias novas">'+opts.map(([v,l,t])=>{
    const dis=v==='time' && !MEM.hasTeam;
    return '<button role="radio" aria-checked="'+(MEM.mode===v)+'" class="'+(MEM.mode===v?'on':'')+'" data-mmode="'+v+'" title="'+memEsc(dis?'entre num time (Conta e time) num projeto com git remote pra usar o cérebro do time':t)+'"'+(dis?' disabled':'')+'>'+l+'</button>'; }).join('')+'</div>';
}
async function memSetMode(mode, repo){
  try{ await invoke('memory_set_mode',{ repo:repo||MEM.repo||state.repo, mode }); MEM.mode=mode; MEM.explicit=true;
    toast(mode==='time'?'Memórias novas vão pro cérebro do time.':mode==='local'?'Memórias novas ficam só nesta máquina.':'Modo só local: os agentes ignoram o cérebro do time.','ok');
  }catch(e){ showErr(memErr(e),'Não consegui trocar o modo'); }
}
function memWireMode(root, repoOf){ if(!root) return; root.querySelectorAll('[data-mmode]').forEach(b=>b.onclick=async()=>{ await memSetMode(b.dataset.mmode, repoOf&&repoOf()); memRender(); memPrefsRender(); }); }

// o editor aberto guarda o que foi digitado no estado ANTES de qualquer redesenho (sync, modo, filtros…)
function memCaptureEdit(){
  const e=MEM.edit; if(!e) return;
  const t=$id('meTitle'), ty=$id('meType'), tg=$id('meTags'), b=$id('meBody');
  if(t) e.title=t.value; if(ty) e.type=ty.value; if(tg) e.tags=tg.value.split(/[,\s]+/).map(x=>x.replace(/^#/,'').trim()).filter(Boolean); if(b) e.body=b.value;
}

// F4 (G1, D16, mesa tela 12): Projeto › Memória — cabeçalho de seção, "onde salvar" numa barra (mora SÓ aqui), e três
// visões: Notas · Grafo · Pra revisar. "Pra revisar" é a dona ÚNICA de aprendizados, curador, "o que cada agente lembra",
// "Do time" e esquecidos — as notas não descem mais pra baixo da dobra.
const MEM_TYPE_PT={ gotcha:'armadilha' }; // o valor gravado continua 'gotcha'; a tela fala português
function memTypeLabel(t){ return MEM_TYPE_PT[t]||t; }
function memRender(){
  const body=$id('memBody'); if(!body) return;
  memCaptureEdit();
  if(MEM.view!=='grafo' && MEM.view!=='revisar') MEM.view='lista';
  const list=memFilter(MEM.notes, MEM.q, MEM.type);
  const nNew=MEM.notes.filter(memIsNew).length;
  const sel=memSelNote();
  const nRev=(MEM.learn||[]).length;
  const tabs=(typeof pageTabs==='function')?pageTabs('mview', [['lista','Notas',MEM.notes.length],['grafo','Grafo'],['revisar','Pra revisar',nRev||null,nRev>0]], MEM.view):'';
  const revisar='<div class="memrev">'+
      '<div class="pgsh3" style="margin-top:0"><h3>Aprendizados</h3><span>'+(nRev?nRev+' esperando você · ':'')+'nada entra sem o seu sim</span></div>'+
      (nRev?memLearnHtml(MEM.learn, LEARN_EDIT):'<p class="pgnote">Nenhum aprendizado esperando. Quando a retro de uma tarefa propuser algo, aparece aqui.</p>')+
      '<div class="pgsh3"><h3>Arrumar a memória</h3><span>sugestões sem IA, revistas no máximo uma vez por dia</span></div>'+
      (typeof curHtml==='function'?curHtml(null):'')+
      '<div class="pgsh3"><h3>O que cada agente lembra</h3><span>voltar, esquecer, compartilhar com o time e os esquecidos — por agente</span></div>'+
      '<div id="memAgHost"></div>'+
    '</div>';
  body.innerHTML=
    '<div class="memwrap">'+
    '<div class="pgsec-h"><div><h2>Memória</h2><p>O que os agentes sabem deste projeto: notas ligadas entre si que eles leem e escrevem. Aprendizados e arrumação só entram com o seu sim.</p></div><span class="grow"></span>'+
      '<button class="btn sm" id="memObs" title="Abre a pasta .cardume/memoria como cofre do Obsidian (links e grafo funcionam lá também)">'+memIc('ext')+'Abrir no Obsidian</button>'+
      (MEM.hasTeam?'<button class="btn sm" id="memSync" title="Sincronizar o cérebro do time agora" aria-label="Sincronizar">'+memIc('sync')+'</button>':'')+
      '<button class="btn primary sm" id="memNew">'+memIc('plus')+'Nova nota</button></div>'+
    '<div class="pgtool"><span class="memlbl">Memórias novas vão para</span>'+memModeSeg('memMode')+'<span class="grow"></span><span class="dim memsub">'+MEM.notes.length+' nota'+(MEM.notes.length===1?'':'s')+(nNew?' · <span class="memnewtxt">'+nNew+' nova'+(nNew===1?'':'s')+'</span>':'')+(MEM.syncMsg?' · '+memEsc(MEM.syncMsg):'')+'</span></div>'+
    tabs+
    (MEM.view==='revisar'?revisar:
    '<div class="memgrid'+(MEM.view==='grafo'?' isgraph':'')+'">'+
      '<aside class="memside">'+
        '<input class="in" id="memQ" placeholder="buscar nas notas…" value="'+memEsc(MEM.q)+'" spellcheck="false" aria-label="Buscar nas notas">'+
        '<div class="memchips">'+['',...MEM_TYPES].map(t=>'<button class="memchip'+(MEM.type===t?' on':'')+'" data-mtype="'+t+'">'+(t?'<i style="background:'+MEM_COLORS[t]+'"></i>'+memTypeLabel(t):'todas')+'</button>').join('')+'</div>'+
        '<div class="memlist" id="memList">'+(list.length?list.map(n=>memRow(n,sel)).join(''):'<div class="memempty">'+(MEM.notes.length?'Nada bate com a busca.':'Ainda sem memória. Os agentes gravam aqui o que aprendem (correções no chat, decisões e armadilhas do fim das tarefas) — ou crie uma nota.')+'</div>')+'</div>'+
      '</aside>'+
      '<section class="memmain" id="memMain">'+(MEM.view==='grafo'?'<div class="memgraph"><canvas id="memCanvas"></canvas><div class="memlegend">'+MEM_TYPES.map(t=>'<span><i style="background:'+MEM_COLORS[t]+'"></i>'+memTypeLabel(t)+'</span>').join('')+'<span><i class="ghost"></i>link quebrado</span></div></div>':memMainHtml(sel))+'</section>'+
    '</div>')+'</div>';
  memWire(body);
  if(MEM.view==='grafo') memDrawGraph();
  if(MEM.view==='revisar' && typeof agMemHostRender==='function') agMemHostRender($id('memAgHost'));
}
function memRow(n, sel){
  const on=sel && sel.slug===n.slug && sel.scope===n.scope;
  return '<button class="memrow'+(on?' on':'')+'" data-mscope="'+memEsc(n.scope)+'" data-mslug="'+memEsc(n.slug)+'">'+
    '<span class="memrt"><i class="memdot" style="background:'+(MEM_COLORS[n.type]||'var(--muted)')+'"></i><b>'+memEsc(n.title)+'</b>'+(memIsNew(n)?'<span class="membadge new">nova</span>':'')+'</span>'+
    '<span class="memrm"><span class="membadge '+(n.scope==='time'?'time':'local')+'">'+n.scope+'</span>'+memEsc(memTypeLabel(n.type))+(n.updated?' · '+memEsc(memDateBR(n.updated)):'')+'</span>'+
    (n.summary?'<span class="memrs">'+memEsc(memPlain(n.summary))+'</span>':'')+'</button>';
}
function memMainHtml(n){
  if(MEM.edit) return memEditorHtml();
  if(!n) return '<div class="memempty big">'+memIc('brain',28)+'<p>Escolha uma nota à esquerda.</p><p class="dim">Cada nota é um arquivo .md com frontmatter, ligada às outras por <code>[[links]]</code>. Os agentes de tarefa, o planner, o chat do projeto e o orquestrador recebem o índice e as notas relevantes a cada conversa.</p></div>';
  const back=memBacklinks(MEM.notes, n);
  const html=memLinkify(mdToHtml(n.body||'*(vazia)*'), MEM.notes, n.scope);
  const other=n.scope==='time'?'local':'time';
  const canMove=other==='local' || MEM.hasTeam;
  return '<article class="memnote">'+
    '<div class="memnh"><h2>'+memEsc(n.title)+'</h2>'+
      '<div class="memacts"><button class="btn" id="memEdit">'+memIc('edit')+'Editar</button>'+
      (canMove?'<button class="btn" id="memMove" title="Mover pro cérebro '+(other==='time'?'do time (sincroniza com todos)':'local (só nesta máquina)')+'">'+memIc('move')+'Mover pro '+(other==='time'?'time':'local')+'</button>':'')+
      '<button class="btn" id="memDel" aria-label="Apagar nota" title="Apagar nota">'+memIc('trash')+'</button></div></div>'+
    '<div class="memmeta"><span class="membadge type" style="--c:'+(MEM_COLORS[n.type]||'var(--muted)')+'">'+memEsc(memTypeLabel(n.type))+'</span><span class="membadge '+(n.scope==='time'?'time':'local')+'">'+n.scope+'</span>'+(memIsNew(n)?'<span class="membadge new">nova</span>':'')+
      (n.secret?'<span class="membadge warn" title="Parece conter chave/senha/.env — não sobe pro time">segredo?</span>':'')+
      (n.tags||[]).map(t=>'<span class="memtag">#'+memEsc(t)+'</span>').join('')+
      '<span class="dim">'+(n.by?'por '+memEsc(n.by):'')+(n.atualizadaPor?' · atualizada por '+memEsc(n.atualizadaPor):'')+(n.updated?' · '+memEsc(memDateBR(n.updated)):'')+'</span></div>'+
    '<div class="mdview memmd">'+html+'</div>'+
    '<div class="memback"><div class="memlbl">citada por</div>'+(back.length?back.map(b=>'<a class="memlink" data-mscope="'+memEsc(b.scope)+'" data-mslug="'+memEsc(b.slug)+'">'+memEsc(b.title)+'</a>').join(''):'<span class="dim">nenhuma nota liga pra esta ainda</span>')+'</div>'+
    // R8: o caminho do arquivo é jargão pra quem não programa — fica recolhido em "onde fica este arquivo" (útil pro Obsidian)
    '<details class="dim memfile"><summary>onde fica este arquivo</summary><span class="mono">'+memEsc((n.scope==='time'?'.cardume/memoria/time/':'.cardume/memoria/')+n.slug+'.md')+'</span></details>'+
  '</article>';
}
function memEditorHtml(){
  const e=MEM.edit;
  return '<div class="memedit">'+
    '<div class="memnh"><h2>'+(e.slug?'Editar nota':'Nova nota')+'</h2><span class="dim">'+(e.scope==='time'?'cérebro do time':'cérebro local')+'</span></div>'+
    '<label class="memf"><span>Título</span><input class="in" id="meTitle" value="'+memEsc(e.title)+'" placeholder="ex.: Usar pnpm, nunca npm"></label>'+
    '<div class="memfrow"><label class="memf"><span>Tipo</span><select class="in" id="meType">'+MEM_TYPES.map(t=>'<option value="'+t+'"'+(t===e.type?' selected':'')+'>'+memTypeLabel(t)+'</option>').join('')+'</select></label>'+
    '<label class="memf" style="flex:1"><span>Tags</span><input class="in" id="meTags" value="'+memEsc((e.tags||[]).join(', '))+'" placeholder="ferramentas, ci"></label></div>'+
    '<label class="memf"><span>Conteúdo · use [[nome-da-nota]] pra ligar notas</span><textarea class="in ta mono" id="meBody" rows="14">'+memEsc(e.body)+'</textarea></label>'+
    '<div class="memfoot"><span class="dim" id="meMsg"></span><span style="flex:1"></span><button class="btn" id="meCancel">cancelar</button><button class="btn primary" id="meSave">salvar</button></div>'+
  '</div>';
}
function memWire(body){
  memWireMode(body.querySelector('#memMode'), ()=>MEM.repo);
  body.querySelectorAll('[data-mview],[data-pgtab^="mview:"]').forEach(b=>b.onclick=()=>{ MEM.view=b.dataset.mview||b.dataset.pgtab.split(':')[1]; memRender(); });
  body.querySelectorAll('[data-mtype]').forEach(b=>b.onclick=()=>{ MEM.type=b.dataset.mtype; memRender(); });
  const q=body.querySelector('#memQ'); if(q){ q.oninput=()=>{ MEM.q=q.value; const l=$id('memList'); const sel=memSelNote(); const f=memFilter(MEM.notes,MEM.q,MEM.type); if(l){ l.innerHTML=f.length?f.map(n=>memRow(n,sel)).join(''):'<div class="memempty">Nada bate com a busca.</div>'; memWireLinks(l); } }; }
  memWireLinks(body);
  memWireLearn(body);
  if(typeof curWire==='function') curWire(body, { repo:()=>MEM.repo, after:async()=>{ await memRefresh(); } });
  bindClick('memNew', ()=>memStartEdit(null));
  bindClick('memObs', async()=>{ try{ const how=await invoke('memory_open_obsidian',{ repo:MEM.repo }); if(how==='pasta') toast('Abri a pasta da memória. No Obsidian: "Abrir pasta como cofre" → escolha .cardume/memoria (depois disso este botão abre direto no Obsidian).','warn'); }catch(e){ showErr(memErr(e),'Não consegui abrir no Obsidian'); } });
  bindClick('memSync', async()=>{ MEM.syncMsg='sincronizando…'; memRender(); const r=await memTeamSync(); MEM.syncMsg=r===false&&memLastSyncErr?'não sincronizou':'sincronizado'; await memRefresh(); });
  bindClick('memEdit', ()=>memStartEdit(memSelNote()));
  bindClick('memMove', memMoveSel);
  bindClick('memDel', memDeleteSel);
  if(MEM.edit){
    const ta=$id('meBody'); if(ta && typeof mountEditor==='function') mountEditor(ta,{ markdown:true });
    bindClick('meCancel', ()=>{ MEM.edit=null; memRender(); });
    bindClick('meSave', memSaveEdit);
    const t=$id('meTitle'); if(t && !MEM.edit.slug && !MEM.edit.focused){ MEM.edit.focused=true; setTimeout(()=>t.focus(),30); }
  }
}
// ---- os 4 botões do cartão (Memória, ficha do agente e etapa Retro usam o MESMO caminho) ----
const LEARN_EDIT={}; // id → { a, b } enquanto a pessoa edita o cartão antes de guardar
function memWireLearn(root){ learnWire(root, { repo:()=>MEM.repo, items:()=>MEM.learn, guard:memRepoChanged, after:async(repo)=>{ await memLoad(repo); memRender(); }, repaint:memRender }); }
// ctx: { repo(), items(), after(repo, r), repaint(), guard()? }
function learnWire(root, ctx){
  const find=id=>(ctx.items()||[]).find(x=>x.id===id);
  root.querySelectorAll('[data-laccept]').forEach(b=>b.onclick=()=>learnAct(ctx, b.dataset.laccept, b.dataset.como||'agente', b));
  root.querySelectorAll('[data-lproj]').forEach(b=>b.onclick=()=>learnAct(ctx, b.dataset.lproj, 'projeto', b));
  root.querySelectorAll('[data-ldiscard]').forEach(b=>b.onclick=()=>learnAct(ctx, b.dataset.ldiscard, 'descartar', b));
  root.querySelectorAll('[data-ledit]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.ledit, it=find(id); if(!it) return;
    if(b.dataset.off){ delete LEARN_EDIT[id]; ctx.repaint(); return; }
    const sk=it.kind==='skill', d=sk?(it.skill||{}):(it.nota||{});
    LEARN_EDIT[id]=it.kind==='persona'?{ a:'', b:(it.persona&&it.persona.texto)||'' }:{ a:sk?(d.descricao||''):(d.title||''), b:sk?(d.corpo||''):(d.body||'') };
    ctx.repaint();
    const card=[...document.querySelectorAll('.memlcard')].find(c=>c.dataset.lid===id); const f=card&&card.querySelector('[data-ledita],[data-leditb]'); if(f) f.focus();
  });
  root.querySelectorAll('.memlcard').forEach(card=>{ const id=card.dataset.lid; const e=LEARN_EDIT[id]; if(!e) return;
    const a=card.querySelector('[data-ledita]'), bb=card.querySelector('[data-leditb]');
    if(a) a.oninput=()=>{ e.a=a.value; }; if(bb) bb.oninput=()=>{ e.b=bb.value; }; });
}
// guardar (pro agente dono ou só no projeto) ou descartar; aceitar sempre oferece "voltar pro jeito antigo" a 1 clique
async function learnAct(ctx, id, act, btn){
  if(ctx.guard && ctx.guard()) return;
  const repo=ctx.repo(); const card=btn&&btn.closest('.memlcard'); const it=(ctx.items()||[]).find(x=>x.id===id);
  if(card) card.querySelectorAll('button').forEach(x=>x.disabled=true);
  try{
    if(act==='descartar'){ await invoke('learn_discard',{ repo, id }); delete LEARN_EDIT[id]; if(typeof cicLearn!=='undefined') for(const k in cicLearn) delete cicLearn[k]; await ctx.after(repo, null); return; }
    const e=LEARN_EDIT[id]; let edited=null;
    if(e && it){ edited=it.kind==='persona'?{ texto:e.b }:it.kind==='skill'?{ descricao:e.a, corpo:e.b }:{ title:e.a, body:e.b }; }
    const r=await invoke('learn_accept',{ repo, id, edited, como:act });
    delete LEARN_EDIT[id];
    if(typeof cicLearn!=='undefined') for(const k in cicLearn) delete cicLearn[k]; // a etapa Retro da tarefa relê a fila
    const w=act==='agente'?memLearnWho(it||{}):null;
    const undo=r&&r.kind==='persona'&&r.action==='persona'?async()=>{ try{ await invoke('agent_revert',{ repo, agentId:r.agentId||r.agente, reason:'voltou logo depois de aceitar' }); toast('Voltou pra persona de antes — virou uma versão nova.','ok'); if(ctx&&ctx.after) await ctx.after(repo, null); }catch(err){ showErr(err, 'Não consegui voltar'); } }
      :r&&r.kind==='skill'?()=>memLearnRevert(repo, r.name, 'voltou logo depois de aceitar', ctx)
      :(r&&r.action==='lembra'&&w)?()=>learnForget(repo, w.id, 'nota', id, 'voltou logo depois de aceitar', ctx, 'voltar'):null;
    const msg=r&&r.kind==='persona'&&w?(w.name+(r.action==='unchanged'?' já trabalhava assim — nada mudou.':' mudou o jeito de trabalhar'+(r.agentVersion?' (agora v'+r.agentVersion+')':'')+' — dá pra voltar com 1 clique.'))
      :w?(w.name+' vai lembrar disso'+(r&&r.agentVersion?' (agora v'+r.agentVersion+')':'')+' — nas próximas tarefas, só '+w.name+' recebe isso.')
      :r&&r.kind==='skill'?'Guardado no projeto — as próximas tarefas usam.'
      :r&&r.action==='unchanged'?'O cérebro já tinha isso — nada mudou.':'Guardado no cérebro do projeto'+(r&&r.action==='updated'?' (juntei com a nota de mesmo título)':'')+'.';
    toast(msg,'ok', undo?{ label:'voltar pro jeito antigo', fn:undo }:undefined);
    if(r && r.slug && typeof MEM!=='undefined') MEM.sel={ scope:r.scope, slug:r.slug };
    await ctx.after(repo, r);
    if(r && r.scope==='time' && typeof memTeamSync==='function') memTeamSync().then(ch=>{ if(ch) memRefresh(); });
  }catch(e){
    showErr(memErr(e), act==='descartar'?'Não consegui descartar o aprendizado':'Não consegui guardar o aprendizado');
    if(card) card.querySelectorAll('button').forEach(x=>x.disabled=false);
  }
}
async function memLearnRevert(repo, name, reason, ctx){
  try{
    const r=await invoke('learn_revert',{ repo, name, reason:reason||'' });
    toast(r&&r.action==='arquivada'?'Voltou pro jeito antigo: '+name.replace(/-/g,' ')+' saiu das próximas tarefas (o texto fica no histórico).':'Voltou pro jeito antigo: '+name.replace(/-/g,' ')+' está exatamente como era.','ok');
    if(ctx && ctx.after) await ctx.after(repo, null);
    else if(MEM.repo===repo){ await memLoad(repo); memRender(); }
  }catch(e){ showErr(memErr(e), 'Não consegui voltar pro jeito antigo'); }
}
// "esquecer" (e o "voltar" de uma nota do agente): nunca apaga — marca/arquiva e o agente ganha versão nova
// change: 'esquecer' (padrão) ou 'voltar' (desfazer o aceite de uma nota — fica registrado como volta)
async function learnForget(repo, agentId, kind, key, reason, ctx, change){
  try{
    await invoke('agent_forget',{ repo, agentId, kind, key, reason:reason||'', change:change||'esquecer' });
    toast(change==='voltar'?'Voltou pro jeito antigo — não vai mais pras próximas tarefas (fica no histórico).':'Pronto — não vai mais pras próximas tarefas (fica no histórico).','ok');
    if(ctx && ctx.after) await ctx.after(repo, null);
  }catch(e){ showErr(memErr(e), 'Não consegui esquecer'); }
}
function memWireLinks(root){
  root.querySelectorAll('[data-mslug]').forEach(a=>a.onclick=(ev)=>{ ev.preventDefault(); memOpenNote(a.dataset.mscope, a.dataset.mslug); });
  root.querySelectorAll('[data-mcreate]').forEach(a=>a.onclick=(ev)=>{ ev.preventDefault(); const t=a.dataset.mcreate; memStartEdit(null, { title:t.replace(/[-_]+/g,' ').replace(/^./,c=>c.toUpperCase()), slug:memSlug(t) }); });
}
function memOpenNote(scope, slug){
  MEM.edit=null; // o editor aberto é descartado ao trocar de nota (mesmo padrão das outras abas)
  MEM.sel={ scope, slug }; MEM.view='lista';
  const n=memSelNote(); if(n) memMarkSeen(n);
  memRender();
  const r=document.querySelector('.memrow.on'); if(r && r.scrollIntoView) r.scrollIntoView({ block:'nearest' });
}
// o projeto da aba mudou (troca de projeto na barra lateral)? recarrega em vez de gravar no projeto errado
function memRepoChanged(){ if(state.repo && MEM.repo && state.repo!==MEM.repo){ toast('Você trocou de projeto — recarreguei a Memória do projeto atual.','warn'); MEM.edit=null; MEM.sel=null; openMemoria(); return true; } return false; }

async function memStartEdit(n, preset){
  if(memRepoChanged()) return;
  if(n){
    let r;
    try{ r=await invoke('memory_read',{ repo:MEM.repo, scope:n.scope, slug:n.slug }); }catch(e){ showErr(memErr(e),'Não consegui abrir a nota'); return; }
    const f=memFromFile(r.content); // conteúdo FRESCO do arquivo (não o da lista) + chaves extras preservadas
    MEM.edit={ slug:n.slug, scope:n.scope, title:f.title||n.title, type:f.type, tags:f.tags, body:f.body, mtime:r.mtimeMs||0, by:f.by, origem:f.origem, atualizadaPor:f.atualizadaPor, extra:f.extra };
  } else {
    const scope=MEM.mode==='time' && MEM.hasTeam ? 'time' : 'local';
    MEM.edit={ slug:null, newSlug:(preset&&preset.slug)||null, scope, title:(preset&&preset.title)||'', type:'contexto', tags:[], body:'', mtime:0, extra:{} };
  }
  MEM.view='lista'; memRender();
}
async function memSaveEdit(){
  memCaptureEdit();
  const e=MEM.edit; if(!e) return;
  if(memRepoChanged()) return;
  const title=(e.title||'').trim(), body=e.body||'';
  if(!title){ $id('meMsg').textContent='dê um título pra nota'; $id('meTitle').focus(); return; }
  if(!body.trim()){ $id('meMsg').textContent='a nota está vazia'; return; }
  const who=memWho(), repo=MEM.repo;
  const note={ title, type:e.type, tags:e.tags||[], updated:memToday(), body, extra:e.extra||{},
    by:e.slug&&e.by?e.by:who, origem:e.slug&&e.by?(e.origem||'pessoa'):'pessoa',
    atualizadaPor:e.slug&&e.by&&e.by!==who?who:(e.atualizadaPor||'') };
  const b=$id('meSave'); b.disabled=true; b.textContent='salvando…';
  try{
    // nota NOVA no time: puxa as do time antes, pra não pegar o nome de uma nota de colega ainda não baixada
    if(!e.slug && e.scope==='time' && MEM.hasTeam) await memTeamSync();
    const r=await invoke('memory_write',{ repo, scope:e.scope, slug:e.slug||e.newSlug||null, content:memSerialize(note), expectMtime:e.mtime||null, create:!e.slug });
    if(r.conflict) toast('Um agente atualizou esta nota enquanto você editava — a sua versão (a mais recente) foi salva.','warn');
    else toast('Nota salva · os agentes veem na próxima leitura.','ok');
    MEM.edit=null; MEM.sel={ scope:r.scope, slug:r.slug };
    await memLoad(repo); const n=memSelNote(); if(n) memMarkSeen(n);
    memRender();
    if(r.scope==='time') memTeamSync().then(ch=>{ if(ch) memRefresh(); });
  }catch(err){ showErr(memErr(err),'Não consegui salvar a nota'); const bb=$id('meSave'); if(bb){ bb.disabled=false; bb.textContent='salvar'; } }
}
async function memMoveSel(){
  if(memRepoChanged()) return;
  const n=memSelNote(); if(!n) return;
  const to=n.scope==='time'?'local':'time', repo=MEM.repo;
  if(to==='local' && !await askYes('A nota sai do cérebro do time (some pros colegas) e fica só nesta máquina. Mover?','Mover pro local')) return;
  try{
    if(to==='time') await memTeamSync(); // nome livre no time (a nota de um colega com o mesmo nome já está aqui)
    const r=await invoke('memory_move',{ repo, slug:n.slug, from:n.scope, to });
    if(to==='local') await memCloudTombstone(repo, n.slug);
    MEM.sel={ scope:r.scope, slug:r.slug }; await memLoad(repo); memRender(); toast(to==='time'?'Nota agora é do time.':'Nota agora é só local.','ok');
    memTeamSync();
  }catch(e){ showErr(memErr(e),'Não consegui mover a nota'); }
}
async function memDeleteSel(){
  if(memRepoChanged()) return;
  const n=memSelNote(); if(!n) return; const repo=MEM.repo;
  if(!await askYes('Apagar "'+n.title+'"? '+(n.scope==='time'?'Ela some do cérebro do time pra todos (quem editar depois revive a nota).':'Não dá pra desfazer.'),'Apagar nota')) return;
  try{ await invoke('memory_delete',{ repo, scope:n.scope, slug:n.slug }); if(n.scope==='time') await memCloudTombstone(repo, n.slug); MEM.sel=null; await memLoad(repo); memRender(); }
  catch(e){ showErr(memErr(e),'Não consegui apagar a nota'); }
}

// ---- grafo (canvas com pan/zoom; clique abre a nota; nó fantasma = link quebrado → criar) ----
let memG=null;
function memDrawGraph(){
  const cv=$id('memCanvas'); if(!cv) return;
  const box=cv.parentElement.getBoundingClientRect(); const W=Math.max(300,box.width), H=Math.max(300,box.height);
  const dpr=window.devicePixelRatio||1; cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px';
  const notes=MEM.notes; const nodes=notes.map(n=>({ id:n.scope+':'+n.slug, n }));
  const edges=[], ghosts={};
  for(const n of notes) for(const l of (n.links||[])){ const r=memResolve(notes,l,n.scope); if(r) edges.push({ from:n.scope+':'+n.slug, to:r.scope+':'+r.slug }); else { const gid='?:'+l; if(!ghosts[gid]){ ghosts[gid]={ id:gid, ghost:l }; nodes.push(ghosts[gid]); } edges.push({ from:n.scope+':'+n.slug, to:gid }); } }
  const pos=memForceLayout(nodes, edges, W, H);
  const deg={}; edges.forEach(e=>{ deg[e.from]=(deg[e.from]||0)+1; deg[e.to]=(deg[e.to]||0)+1; });
  memG={ nodes, edges, pos, deg, W, H, dpr, tx:0, ty:0, k:1, hover:-1 };
  memPaint(); memWireCanvas(cv);
}
function memPaint(){
  const g=memG, cv=$id('memCanvas'); if(!g||!cv) return; const c=cv.getContext('2d');
  c.setTransform(g.dpr,0,0,g.dpr,0,0); c.clearRect(0,0,g.W,g.H);
  c.translate(g.tx,g.ty); c.scale(g.k,g.k);
  const idx={}; g.nodes.forEach((n,i)=>{ idx[n.id]=i; });
  const sel=MEM.sel?MEM.sel.scope+':'+MEM.sel.slug:'';
  c.lineWidth=1/g.k;
  for(const e of g.edges){ const a=g.pos[idx[e.from]], b=g.pos[idx[e.to]]; if(!a||!b) continue;
    const hot=g.hover>=0 && (idx[e.from]===g.hover||idx[e.to]===g.hover);
    c.strokeStyle=hot?memCss('var(--accent)', .7):memCss('var(--text)', .14); c.setLineDash(g.nodes[idx[e.to]].ghost?[3,3]:[]);
    c.beginPath(); c.moveTo(a.x,a.y); c.lineTo(b.x,b.y); c.stroke(); }
  c.setLineDash([]);
  g.nodes.forEach((nd,i)=>{ const p=g.pos[i]; const r=4+Math.min(8,Math.sqrt(g.deg[nd.id]||0)*2.2);
    c.beginPath(); c.arc(p.x,p.y,r,0,Math.PI*2);
    if(nd.ghost){ c.strokeStyle=memCss('var(--muted)', .7); c.stroke(); }
    else { c.fillStyle=memCss(MEM_HEX[nd.n.type]||'var(--muted)'); c.fill(); if(nd.id===sel||i===g.hover){ c.strokeStyle=memCss('var(--text)'); c.lineWidth=2/g.k; c.stroke(); c.lineWidth=1/g.k; } }
    if(g.k>.6 || i===g.hover){ c.fillStyle=nd.ghost?memCss('var(--muted)', .8):memCss('var(--text)', .88); c.font=(11/Math.max(g.k,.8))+'px \'Public Sans\',system-ui,sans-serif'; c.textAlign='center';
      const label=nd.ghost?('+ '+nd.ghost):nd.n.title; c.fillText(label.length>34?label.slice(0,33)+'…':label, p.x, p.y+r+12/Math.max(g.k,.8)); }
  });
}
function memHit(ev){
  const g=memG, cv=$id('memCanvas'); if(!g||!cv) return -1; const b=cv.getBoundingClientRect();
  const x=(ev.clientX-b.left-g.tx)/g.k, y=(ev.clientY-b.top-g.ty)/g.k;
  let best=-1, bd=14/g.k; g.pos.forEach((p,i)=>{ const d=Math.hypot(p.x-x,p.y-y); if(d<bd){ bd=d; best=i; } }); return best;
}
function memWireCanvas(cv){
  let drag=null, moved=false;
  cv.onmousedown=ev=>{ drag={ x:ev.clientX, y:ev.clientY, tx:memG.tx, ty:memG.ty }; moved=false; };
  cv.onmousemove=ev=>{ if(drag){ const dx=ev.clientX-drag.x, dy=ev.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>3) moved=true; memG.tx=drag.tx+dx; memG.ty=drag.ty+dy; memPaint(); return; }
    const h=memHit(ev); if(h!==memG.hover){ memG.hover=h; cv.style.cursor=h>=0?'pointer':'grab'; memPaint(); } };
  cv.onmouseup=ev=>{ const was=drag; drag=null; if(!was||moved) return; const i=memHit(ev); if(i<0) return; const nd=memG.nodes[i];
    if(nd.ghost) memStartEdit(null,{ title:nd.ghost.replace(/-/g,' ').replace(/^./,c=>c.toUpperCase()), slug:nd.ghost });
    else memOpenNote(nd.n.scope, nd.n.slug); };
  cv.onmouseleave=()=>{ drag=null; if(memG.hover>=0){ memG.hover=-1; memPaint(); } };
  cv.onwheel=ev=>{ ev.preventDefault(); const b=cv.getBoundingClientRect(); const mx=ev.clientX-b.left, my=ev.clientY-b.top;
    const k2=Math.max(.3,Math.min(3,memG.k*(ev.deltaY<0?1.1:1/1.1))); memG.tx=mx-(mx-memG.tx)*k2/memG.k; memG.ty=my-(my-memG.ty)*k2/memG.k; memG.k=k2; memPaint(); };
}

// ---- cérebro do TIME: .cardume/memoria/time/ ⇄ brain_notes (mais recente vence; apagar = lápide) ----
let memSyncBusy=false, memLastSyncErr='';
const MEM_PAGE=500;
async function memCloudCtx(repo){
  if(!repo || !(SB.configured() && SB.sess() && cloudData && cloudData.org)) return null;
  const k=await prefsKey(); if(!k || state.repo!==repo) return null; // prefsKey lê o projeto ATIVO
  // lê/lapida pela forma nova E a antiga desta máquina (alias de ssh); grava sempre na nova (k.repo)
  const ks=r=>({ knownKey:'memKnown:'+k.orgId+':'+r+':'+repo, lastKey:'memLast:'+k.orgId+':'+r+':'+repo });
  const cur=ks(k.repo);
  if(k.ids && k.ids.legacy && k.ids.legacy!==k.repo){ const old=ks(k.ids.legacy); // chaves locais migram uma vez
    lsMigrateKey(old.knownKey, cur.knownKey, lsGet, lsSet); lsMigrateKey(old.lastKey, cur.lastKey, lsGet, lsSet); }
  return { ...k, q:'org_id=eq.'+k.orgId+'&'+remoteInQ('repo', k.ids||{ remote:k.repo }), ...cur };
}
// apagar/mover pra local na aba: lápide na nuvem NA HORA (não espera o sync inferir)
async function memCloudTombstone(repo, slug){
  try{ const c=await memCloudCtx(repo); if(!c) return;
    await sbFetch('/rest/v1/brain_notes?'+c.q+'&slug=eq.'+encodeURIComponent(slug),{ method:'PATCH', body:JSON.stringify({ deleted_at:new Date().toISOString() }) });
  }catch(e){ console.warn('memCloudTombstone', e); }
}
async function memTeamSync(){
  if(memSyncBusy) return false; memSyncBusy=true; memLastSyncErr='';
  const repo=state.repo; // o sync inteiro é PRESO a este projeto
  let changed=false, aborted=false, secrets=0;
  let c=null, known=new Set(); const ok=new Set(), failed=new Set();
  const alive=()=>{ if(state.repo!==repo){ aborted=true; return false; } return true; };
  try{
    c=await memCloudCtx(repo); if(!c) return false;
    try{ known=new Set(JSON.parse(lsGet(c.knownKey)||'[]')); }catch(_){ known=new Set(); }
    const lastSync=+(lsGet(c.lastKey)||0);
    const startedAt=Date.now();
    const info=await invoke('memory_list',{ repo, withBody:true });
    const local=(info.notes||[]).filter(n=>n.scope==='time'); const L={}; local.forEach(n=>{ L[n.slug]=n; });
    // TODAS as páginas antes de decidir qualquer coisa (decidir com metade da nuvem apagaria o resto)
    const rows=[];
    for(let off=0;;off+=MEM_PAGE){
      const page=await sbGet('brain_notes?select=repo,slug,title,type,tags,body,by,origem,updated_at,deleted_at&'+c.q+'&order=slug&limit='+MEM_PAGE+'&offset='+off)||[];
      rows.push(...page); if(page.length<MEM_PAGE) break;
    }
    // nova + antiga: por slug fica a mais recente; as que só existem na antiga sobem pra nova no fim
    const merged=remoteMergeRows(rows, c.ids||{ remote:c.repo }, 'repo', 'slug'); rows.length=0; rows.push(...merged.rows);
    if(!alive()) return false;
    const R={}; rows.forEach(r=>{ R[r.slug]=r; });
    const plan=memSyncPlan(local, rows, known, local.length===0, lastSync);
    plan.keep.forEach(s=>ok.add(s));
    const pull=async(r, extra)=>invoke('memory_write',{ repo, scope:'time', slug:r.slug, setMtimeMs:Date.parse(r.updated_at)||null,
      content:memSerialize({ title:r.title, type:r.type, tags:r.tags||[], updated:String(r.updated_at||'').slice(0,10), by:r.by, origem:r.origem, body:r.body, extra:extra||{} }) });
    const extraOf=async slug=>{ try{ return memFromFile((await invoke('memory_read',{ repo, scope:'time', slug })).content).extra; }catch(_){ return {}; } };
    const push=async n=>{
      const rows2=await sbFetch('/rest/v1/brain_notes?on_conflict=org_id,repo,slug',{ method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=representation' },
        body:JSON.stringify({ org_id:c.orgId, repo:c.repo, slug:n.slug, title:n.title, type:n.type, tags:n.tags||[], body:n.body||'', by:n.by||'', origem:n.origem||'pessoa', deleted_at:null }) });
      // o servidor carimba updated_at: o arquivo passa a ter essa data (senão o próximo sync "puxaria" de volta)
      const at=rows2&&rows2[0]&&Date.parse(rows2[0].updated_at);
      if(at){ const cur=await invoke('memory_read',{ repo, scope:'time', slug:n.slug }); await invoke('memory_write',{ repo, scope:'time', slug:n.slug, content:cur.content, setMtimeMs:at }); }
    };
    const step=async(slug, fn)=>{ if(!alive()) return false; try{ await fn(); return true; }catch(e){ console.warn('memTeamSync', slug, e); memLastSyncErr=String(e&&e.message||e); failed.add(slug); return false; } };
    for(const s of plan.pull){ if(await step(s, async()=>pull(R[s], L[s]?await extraOf(s):{}))){ ok.add(s); changed=true; } }
    for(const s of plan.push){ const n=L[s]; if(!n) continue; if(n.secret){ secrets++; continue; } if(await step(s, ()=>push(n))) ok.add(s); }
    for(const s of plan.delLocal){ if(await step(s, ()=>invoke('memory_delete',{ repo, scope:'time', slug:s }))) changed=true; }
    for(const s of plan.tombstoneCloud){ await step(s, ()=>sbFetch('/rest/v1/brain_notes?'+c.q+'&slug=eq.'+encodeURIComponent(s),{ method:'PATCH', body:JSON.stringify({ deleted_at:new Date().toISOString() }) })); }
    for(const s of plan.rename){ // mesmo nome, notas diferentes: a minha vira <slug>-N; a do colega fica com o nome
      const n=L[s]; if(!n || n.secret){ if(n) secrets++; continue; }
      await step(s, async()=>{
        const cur=await invoke('memory_read',{ repo, scope:'time', slug:s });
        const w=await invoke('memory_write',{ repo, scope:'time', slug:s, content:cur.content, create:true });
        await pull(R[s], {});
        ok.add(s); changed=true;
        const f=memFromFile(cur.content);
        await push({ slug:w.slug, title:f.title||n.title, type:n.type, tags:f.tags, body:f.body, by:f.by, origem:f.origem });
        ok.add(w.slug);
      });
    }
    // migração: nota viva que só existe na forma antiga do remote ganha cópia na forma nova (o time passa a ver)
    const skip=new Set([...plan.tombstoneCloud, ...plan.delLocal]);
    for(const s of merged.legacyOnly){ const r=R[s]; if(!r || r.deleted_at || skip.has(s)) continue;
      await step(s, ()=>sbFetch('/rest/v1/brain_notes?on_conflict=org_id,repo,slug',{ method:'POST', headers:{ 'Prefer':'resolution=ignore-duplicates' },
        body:JSON.stringify({ org_id:c.orgId, repo:c.repo, slug:r.slug, title:r.title, type:r.type, tags:r.tags||[], body:r.body||'', by:r.by||'', origem:r.origem||'pessoa', deleted_at:null }) })); }
    if(secrets) toast(secrets+' nota(s) do time parecem conter segredo (chave/senha/.env) e NÃO subiram pra nuvem — abra a Memória pra revisar.','warn');
    // D1: projeto num time → as memórias novas vão pro time por padrão (até a pessoa escolher outra coisa)
    if(alive() && !info.explicitMode && info.mode!=='time'){
      await invoke('memory_set_mode',{ repo, mode:'time' }).catch(()=>{});
      if(MEM.repo===repo){ MEM.mode='time'; MEM.explicit=true; changed=true; }
    }
    if(!aborted) lsSet(c.lastKey, String(startedAt));
    return changed;
  }catch(e){ console.warn('memTeamSync', e); memLastSyncErr=String(e&&e.message||e); return false; }
  finally{
    // "conhecidas" = só as confirmadas agora (2xx) + as que falharam e já eram conhecidas (tentam de novo)
    if(c){ const next=new Set(ok); for(const s of known) if(failed.has(s) || aborted) next.add(s); lsSet(c.knownKey, JSON.stringify([...next])); }
    memSyncBusy=false;
  }
}
window.memTeamSync=memTeamSync;
setTimeout(()=>{ memTeamSync().then(ch=>{ if(ch) memRefresh(); }).catch(()=>{}); }, 20000);
setInterval(()=>{ memTeamSync().then(ch=>{ if(ch) memRefresh(); }).catch(()=>{}); }, 10*60*1000);

// ---- Preferências do projeto: o mesmo seletor "onde salvar as memórias novas" ----
async function memPrefsRender(){
  const h=$id('prefsMemHost'); if(!h) return;
  const repo=state.repo; if(!repo){ h.innerHTML=''; return; }
  try{ const r=await invoke('memory_list',{ repo }); if(MEM.repo!==repo){ MEM.mode=r.mode||'local'; MEM.explicit=!!r.explicitMode; } else { MEM.mode=r.mode||MEM.mode; }
    MEM.hasTeam=await memTeamAvailable();
    h.innerHTML='<div class="memprefs"><div class="seclbl2">Memória do projeto</div><div class="dim" style="font-size:var(--fs-sm);margin:4px 0 8px">Onde as memórias novas (dos agentes e as suas) são salvas. Os agentes leem o cérebro local e o do time juntos — menos no modo "só local". '+(r.notes||[]).length+' nota(s) hoje · <a href="#" id="prefsMemOpen">abrir a Memória</a></div>'+memModeSeg('prefsMemMode')+'</div>';
    memWireMode(h.querySelector('#prefsMemMode'), ()=>repo);
    const a=h.querySelector('#prefsMemOpen'); if(a) a.onclick=ev=>{ ev.preventDefault(); if(window.openTab) window.openTab('memoria'); else openMemoria(); };
  }catch(_){ h.innerHTML=''; }
}
window.memPrefsRender=memPrefsRender;

bindClick('memBtn', ()=>{ if(window.openTab) window.openTab('memoria'); else openMemoria(); });
{ const ov=$id('memOverlay'); if(ov) ov.addEventListener('click',e=>{ if(e.target.id==='memOverlay') ovHide('memOverlay'); }); }
bindClick('memClose', ()=>ovHide('memOverlay'));
{ let t=null; window.addEventListener('resize', ()=>{ clearTimeout(t); t=setTimeout(()=>{ if(MEM.view==='grafo' && $id('memCanvas') && memVisible()) memDrawGraph(); }, 200); }); }
