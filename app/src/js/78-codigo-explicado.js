// Starfork — 78-codigo-explicado
// ===== CÓDIGO EXPLICADO (⌘2) — o diff POR TRECHO com o porquê de cada um (redesenho "Semana", 14/10 —
// _bmad-output/redesenho-foco/codigo-explicado.md e mesa-semana-app.md §7) =====
// Os arquivos alterados ficam numa lista à esquerda (agrupada; gerados e assets recolhidos); cada hunk do diff aparece ao lado do PORQUÊ dele, nesta ordem de fonte:
//   1. o que o agente registrou (tool register_change_reason → .cardume/artifacts/.starfork/change-reasons.json);
//   2. o "o que fiz" do mapa requisito → trechos (map_requirement, requirements.json) quando o trecho é de um requisito;
//   3. inferido da conversa: o texto do assistente logo antes do Edit/Write daquele arquivo (transcript — term_history);
//   4. mensagem do commit (branch com um commit só) ou o corpo do PR;
//   5. nada: "sem explicação registrada · perguntar" (cita as linhas no terminal e pede o registro retroativo).
// Em cima de cada arquivo, "O que mudou neste arquivo e por quê" (dos motivos dos trechos — nenhuma chamada nova à IA;
// "explicar com IA" continua a um clique, o ai_file_why de sempre).
// CONVERSA NO TRECHO: clique no nº da linha, ⇧clique estende (ou "Perguntar sobre este trecho", pelo teclado). Abaixo do
// trecho abre o compositor com `@arquivo:i-f`: "Perguntar sobre isso" manda `@arquivo:i-f pergunta` pro PTY da tarefa
// (tiSend — entra na fila se a IA estiver no meio de um passo) e o fio fica preso ao hunk: a pergunta e a resposta, lida
// do transcript; "Colar no terminal ⌘L" só digita a referência no prompt (sem Enter); "Pedir alteração ⌘⇧L" manda
// `Altere @arquivo:i-f: pedido`. Uma fonte só: tudo isso está também no terminal (é o mesmo PTY). "Virar nota da memória"
// grava uma nota do time com a origem. Os fios ficam com a tarefa (.trecho-conversas.json nos artefatos, oculto).
// Fontes únicas: diffHunks (20), tiSend/tiType (64), reqRows (27), personChip (08), memSerialize (37), toast/showErr.

// @cx-puro-inicio (puro: só esc/escA — testado em app/tests/codigo-explicado.test.mjs)
const CX_MAX_ROWS=4000; // linhas de diff pintadas por arquivo (o resto: "ver o arquivo inteiro" no Código antigo)
/** Faixa "14-15" | "14" | [14,15] → { a, b } | null */
function cxRange(v){
  if(Array.isArray(v) && v.length){ const a=+v[0], b=+v[v.length-1]; return a>0&&b>=a?{ a, b }:null; }
  const m=String(v==null?'':v).trim().match(/^(\d+)(?:\s*[-–—:]\s*(\d+))?$/); if(!m) return null;
  const a=+m[1], b=m[2]?+m[2]:a; return a>0&&b>=a?{ a, b }:null;
}
function cxOverlap(r, a, b){ return !!r && r.a<=b && r.b>=a; }
/** Faixa do hunk no arquivo NOVO (linhas com nº novo); hunk só de remoção = a posição onde estava. */
function cxHunkSpan(h){ const ns=(h.rows||[]).filter(r=>r.n).map(r=>r.n); return ns.length?{ a:Math.min(...ns), b:Math.max(...ns) }:{ a:h.n||1, b:h.n||1, delOnly:true }; }
/** "@src/a.ts:14-15" */
function cxRef(file, a, b){ return '@'+String(file||'')+':'+(a===b?a:a+'-'+b); }
/** caminho → igual ao do agente (sem ./) */
function cxSameFile(x, y){ const n=s=>String(s||'').replace(/^\.\//,''); return n(x)===n(y) || n(x).endsWith('/'+n(y)) || n(y).endsWith('/'+n(x)); }
/**
 * O porquê de UM trecho. o: { file, span:{a,b}, reasons:[{file,range,requirement,reason,covered_by,ts}],
 * reqs:[{text, did, code:[{file,lines}], tests:[{name}]}], hist:[{k,ts,text,name,arg}], commits:[{subject}], prBody }
 * → { req:'R3'|null, reqText, why, covered, src:'agente'|'mapa'|'conversa'|'commit'|'pr'|'', ts }
 */
function cxWhyOf(o){
  const reasons=(o.reasons||[]).filter(r=>r && cxSameFile(r.file, o.file) && cxOverlap(cxRange(r.range), o.span.a, o.span.b));
  const reqs=o.reqs||[];
  const reqIdx=(label)=>{ const m=String(label||'').match(/^R(\d+)$/i); return m?(+m[1]-1):-1; };
  // requisito do trecho: o que o agente disse no porquê, senão o mapa requisito → trechos
  let ri=-1;
  const r0=reasons.length?reasons[reasons.length-1]:null;
  if(r0 && r0.requirement) ri=reqIdx(r0.requirement);
  if(ri<0) ri=reqs.findIndex(q=>(q.code||[]).some(c=>cxSameFile(c.file, o.file) && (c.lines==null||c.lines===''?true:cxOverlap(cxRange(c.lines), o.span.a, o.span.b))));
  const req=ri>=0?'R'+(ri+1):null, reqText=ri>=0&&reqs[ri]?String(reqs[ri].text||''):'';
  const testOf=()=>{ const q=ri>=0?reqs[ri]:null; const t=q&&Array.isArray(q.tests)?q.tests.find(x=>x&&x.name):null; return t?String(t.name):''; };
  if(r0) return { req, reqText, why:String(r0.reason||''), covered:String(r0.covered_by||'')||testOf(), src:'agente', ts:+r0.ts||0 };
  if(ri>=0 && reqs[ri] && String(reqs[ri].did||'').trim()) return { req, reqText, why:String(reqs[ri].did).trim(), covered:testOf(), src:'mapa', ts:0 };
  // transcript: a última fala do assistente ANTES do último Edit/Write deste arquivo
  const H=o.hist||[]; let say=null, ts=0;
  for(let i=H.length-1;i>=0;i--){ const it=H[i]; if(!it || it.k!=='edit' || !cxSameFile(it.arg, o.file)) continue;
    for(let j=i-1;j>=0 && j>=i-12;j--){ const p=H[j]; if(p.k==='you') break; if(p.k==='say' && String(p.text||'').trim()){ say=String(p.text).trim(); ts=+p.ts||+it.ts||0; break; } }
    if(say) break; }
  if(say) return { req, reqText, why:cxClip(say, 420), covered:testOf(), src:'conversa', ts };
  const cm=(o.commits||[]).filter(c=>c && String(c.subject||'').trim().split(/\s+/).length>=3);
  if(cm.length===1) return { req, reqText, why:String(cm[0].subject).trim(), covered:testOf(), src:'commit', ts:0 };
  const pb=String(o.prBody||'').split('\n').map(s=>s.replace(/^[#>*\-\s]+/,'').trim()).find(s=>s.split(/\s+/).length>=4);
  if(pb) return { req, reqText, why:cxClip(pb, 300), covered:testOf(), src:'pr', ts:0 };
  return { req, reqText, why:'', covered:testOf(), src:'', ts:0 };
}
function cxClip(s, n){ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'…':s; }
const CX_SRC_LABEL={ agente:'registrado pelo agente', mapa:'do mapa do requisito (o que o agente disse que fez)', conversa:'inferido da conversa (o agente não registrou)', commit:'da mensagem do commit', pr:'do corpo do PR', '':'' };
/** "7ª resposta da IA" de um instante: quantas falas suas vieram antes dele (cada uma rendeu uma resposta). */
function cxTurnAt(hist, ts){ if(!(ts>0)) return 0; let n=0; for(const it of hist||[]){ if(it && it.k==='you' && (+it.ts||0)<=ts) n++; } return n; }
/** Resumo do arquivo a partir dos motivos dos trechos (sem chamar a IA): até 2 frases distintas. */
function cxFileSummary(whys){
  const seen=new Set(), out=[];
  for(const w of whys||[]){ if(!w || !w.why || w.src==='') continue; const k=w.why.toLowerCase(); if(seen.has(k)) continue; seen.add(k); out.push(cxClip(w.why, 220)); if(out.length>=2) break; }
  return out.join(' ');
}
/**
 * A resposta da IA a uma pergunta do trecho, lida do transcript: a fala SUA que contém a referência (depois de `since`)
 * e as falas do assistente até a sua próxima. → { found, text, done } (done = já veio uma fala sua depois, ou parou).
 */
function cxAnswerOf(hist, ref, since, busy){
  const H=hist||[]; let i=-1;
  for(let k=H.length-1;k>=0;k--){ const it=H[k]; if(it && it.k==='you' && String(it.text||'').includes(ref) && (+it.ts||0)>=since-60000){ i=k; break; } }
  if(i<0) return { found:false, text:'', done:false };
  const parts=[]; let done=false;
  for(let k=i+1;k<H.length;k++){ const it=H[k]; if(it.k==='you'){ done=true; break; } if(it.k==='say' && String(it.text||'').trim()) parts.push(String(it.text).trim()); }
  if(!busy && parts.length) done=true;
  return { found:true, text:parts.join('\n\n'), done };
}
/** O texto que cada botão manda pro terminal. kind: 'ask' | 'paste' | 'alt' | 'why' */
function cxPtyText(kind, ref, txt){
  const q=String(txt==null?'':txt).replace(/\s+/g,' ').trim();
  if(kind==='alt') return q?'Altere '+ref+': '+q:'';
  if(kind==='why') return ref+' Por que este trecho mudou? Responda em 1–2 frases citando arquivo:linha e o requisito, e registre com register_change_reason.';
  if(kind==='paste') return ref+' '+(q?q+' ':'');
  return q?ref+' '+q:'';
}
// Muitos arquivos (ex.: 245 de um pacote de assets de jogo): a lista à esquerda agrupa em Código / Testes / Config e
// outros / Gerados, assets e binários (este recolhido). Binário, gerado e lixo nunca abrem sozinhos nem pedem diff.
const CX_BIN_RE=/\.(png|jpe?g|gif|webp|bmp|ico|icns|svgz|tiff?|psd|xcf|ase|aseprite|zip|gz|tgz|bz2|xz|7z|rar|jar|mp3|wav|ogg|flac|m4a|mp4|mov|webm|avi|ttf|otf|woff2?|eot|pdf|bin|exe|dll|so|dylib|wasm|glb|gltf|fbx|blend|obj)$/i;
function cxIsBin(f){ const p=String((f&&f.path)||''); return CX_BIN_RE.test(p) || (!!f && !f.add && !f.del && !!f.binary); }
// linguagem de programação (o que vira "Código"); json/yaml/toml/md/txt ficam em Config e outros
const CX_CODE_RE=/\.(m?[jt]sx?|c[jt]s|vue|svelte|astro|py|rb|go|rs|java|kt|kts|swift|m|mm|c|cc|cpp|h|hpp|cs|php|scala|ex|exs|dart|lua|sql|css|scss|sass|less|html?|gd|gdshader|sh)$/i;
const CX_HUGE=3000; // texto com mais linhas adicionadas que isso = quase certamente gerado (mapa exportado, bundle, dump)
const CX_JUNK_RE=/(^|\/)(__MACOSX\/|\._[^/]*$|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/;
const CX_GEN_RE=/(^|\/)(node_modules|dist|build|vendor|_tmp|tmp|\.next|\.nuxt|coverage|target)\/|(^|\/)(public|static)\/(.*\/)?assets\/|\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock)$/;
const CX_TEST_RE=/(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$/i;
const CX_CONF_RE=/(^|\/)(\.[^/]+|[^/]*\.config\.[^/]+|Dockerfile[^/]*|Makefile)$/i;
/** O que é o arquivo: 'junk' (lixo de zip/SO) | 'gen' (gerado, assets, binário, enorme) | 'test' | 'code' | 'other' */
function cxKind(f){
  const p=String((f&&f.path)||'').replace(/^\.\//,'');
  if(CX_JUNK_RE.test(p)) return 'junk';
  if(cxIsBin(f) || CX_GEN_RE.test(p) || (+(f&&f.add)||0)>CX_HUGE) return 'gen';
  if(CX_TEST_RE.test(p)) return 'test';
  if(CX_CODE_RE.test(p) && !CX_CONF_RE.test(p)) return 'code';
  return 'other';
}
/** Texto grande demais pra pintar de cara (resumo + "mostrar mesmo assim"). */
function cxIsHuge(f){ return !!f && !cxIsBin(f) && ((+f.add||0)+(+f.del||0))>CX_HUGE; }
const CX_GROUPS=[{ k:'code', label:'Código' },{ k:'test', label:'Testes' },{ k:'other', label:'Config e outros' },{ k:'gen', label:'Gerados, assets e binários' }];
const CX_KIND_RANK={ code:0, test:1, other:2, gen:3, junk:4 };
const cxSize=f=>(+f.add||0)+(+f.del||0);
/** Ordem da lista: Código → Testes → Config → Gerados (texto antes de binário) → lixo; mais mudado no topo, estável. */
function cxOrderFiles(files){
  return (files||[]).map((f,i)=>({ f, i, k:CX_KIND_RANK[cxKind(f)], b:cxIsBin(f)?1:0 }))
    .sort((x,y)=>(x.k-y.k)||(x.b-y.b)||(cxSize(y.f)-cxSize(x.f))||(x.i-y.i)).map(x=>x.f);
}
/** Grupos da lista à esquerda (o lixo mora no fim de "Gerados"); só os grupos com arquivo. */
function cxGroupFiles(files){
  const ord=cxOrderFiles(files);
  return CX_GROUPS.map(g=>({ k:g.k, label:g.label, files:ord.filter(f=>{ const k=cxKind(f); return k===g.k || (g.k==='gen' && k==='junk'); }) })).filter(g=>g.files.length);
}
/** O que abre por padrão: o código com mais mudança fora de "Gerados"; sem isso, o primeiro que não é lixo. */
function cxDefaultFile(files){
  const ord=cxOrderFiles(files);
  const f=ord.find(x=>cxKind(x)!=='gen' && cxKind(x)!=='junk') || ord.find(x=>cxKind(x)!=='junk' && !cxIsBin(x) && !cxIsHuge(x)) || ord.find(x=>cxKind(x)!=='junk') || null;
  return f?f.path:null;
}
/** "src/game/sprites.ts" → { dir:'src/game/', name:'sprites.ts' } */
function cxSplitPath(p){ p=String(p||''); const i=p.lastIndexOf('/'); return { dir:i>=0?p.slice(0,i+1):'', name:i>=0?p.slice(i+1):p }; }
/** Próximo/anterior numa lista de caminhos (J/K): para nas pontas. */
function cxStep(paths, cur, d){ const L=paths||[]; if(!L.length) return null; const i=L.indexOf(cur); if(i<0) return L[d>0?0:L.length-1]; return L[Math.max(0, Math.min(L.length-1, i+d))]; }
/** Tecla da navegação da etapa (sem modificador; nunca com foco em campo/terminal): 'next'|'prev'|'hnext'|'hprev'|'find'|'nav'|'' */
function cxNavKey(e, inField, inNav){
  if(!e || inField || e.metaKey || e.ctrlKey || e.altKey) return '';
  const k=String(e.key||'');
  if(k==='j'||k==='J') return 'next'; if(k==='k'||k==='K') return 'prev';
  if(inNav && k==='ArrowDown') return 'next'; if(inNav && k==='ArrowUp') return 'prev';
  if(k==='n'||k==='N') return 'hnext'; if(k==='p'||k==='P') return 'hprev';
  if(k==='/') return 'find'; if(k==='a'||k==='A') return 'nav';
  return '';
}
// @cx-puro-fim

// ---------------------------------------------------------------- estado e dados
const CX={ navQ:{}, genOpen:{}, force:{}, data:{}, reasons:{}, hist:{}, commits:{}, threads:{}, thLoaded:{}, file:{}, filt:{}, seen:{}, sel:null, selTxt:'', alt:null, altTxt:'', reply:{}, sig:'', loadingAt:{} };
function cxOn(){ return typeof TE!=='undefined' && TE.on; }
function cxCodeFiles(){ return cxOrderFiles((typeof fwFiles!=='undefined'?fwFiles:[]).filter(f=>f && !f.doc && f.source!=='doc')); }
function cxThreads(taskId){ return CX.threads[taskId]||(CX.threads[taskId]=[]); }
/** Contagens pra lateral (75): trechos conhecidos e conversas abertas. */
function cxCounts(taskId){
  const d=CX.data[taskId]; let hunks=0;
  if(d) for(const p in d.files){ const f=d.files[p]; if(f && f.hunks) hunks+=f.hunks.length; }
  return { hunks, threads:(CX.threads[taskId]||[]).length };
}
function cxTurnCount(taskId){ const h=CX.hist[taskId]; return h&&h.items?h.items.filter(x=>x.k==='you').length:0; }
// diff de cada arquivo (mesma chave de cache do Código antigo: muda quando +/− do arquivo muda)
function cxDiffs(t, openPath){
  const all=cxCodeFiles(), files=all.filter(f=>{ const k=cxKind(f); return k!=='gen' && k!=='junk'; }).slice(0, 40);
  const o=all.find(f=>f.path===openPath);
  if(o && !files.includes(o) && cxKind(o)!=='junk' && !cxIsBin(o) && (!cxIsHuge(o) || CX.force[t.id+'|'+o.path])) files.push(o);
  const d=CX.data[t.id]||(CX.data[t.id]={ files:{} });
  let pending=0;
  for(const f of files){
    const key=t.id+':'+f.path+'#'+(f.add||0)+':'+(f.del||0);
    const cur=d.files[f.path];
    if(cur && cur.key===key) continue;
    if(cur && cur.loading===key){ pending++; continue; }
    d.files[f.path]={ key, loading:key, hunks:cur&&cur.hunks||null, err:'' };
    pending++;
    const raw=(typeof fwDiffCache!=='undefined')?fwDiffCache[key]:undefined;
    const done=(txt, err)=>{ const x=d.files[f.path]; if(!x || x.loading!==key) return;
      x.loading=''; x.err=err||''; x.hunks=err?[]:diffHunks(txt||'').hunks; cxRepaint(t.id); };
    if(typeof raw==='string'){ done(raw, ''); continue; }
    invoke('file_diff',{ taskId:t.id, path:f.path }).then(txt=>{ if(typeof fwDiffCache!=='undefined') fwDiffCache[key]=txt||''; done(txt, ''); })
      .catch(e=>done('', String(e&&e.message||e)));
  }
  return pending;
}
// porquês registrados, transcript e commits: relidos com calma enquanto a etapa está na tela (ou um fio espera resposta)
function cxLoadAux(t, force){
  const now=Date.now(), id=t.id;
  if(force || !(now-(CX.loadingAt[id+':r']||0)<8000)){ CX.loadingAt[id+':r']=now;
    invokeQuiet('read_artifact',{ taskId:id, name:'.starfork/change-reasons.json' }).then(c=>{ let a=[]; try{ a=JSON.parse((c&&c.text)||'[]'); }catch(_){ } const s=JSON.stringify(a); if(s!==(CX.reasons[id]||{}).sig){ CX.reasons[id]={ list:Array.isArray(a)?a:[], sig:s }; cxRepaint(id); } })
      .catch(()=>{ if(!CX.reasons[id]){ CX.reasons[id]={ list:[], sig:'[]' }; cxRepaint(id); } }); }
  if(force || !(now-(CX.loadingAt[id+':h']||0)<4000)){ CX.loadingAt[id+':h']=now;
    const h=CX.hist[id];
    invokeQuiet('term_history',{ taskId:id, since:(h&&h.stamp)||null }).then(r=>{ if(!r || r.unchanged) return; CX.hist[id]={ items:Array.isArray(r.items)?r.items:[], stamp:r.stamp||'' }; cxAnswersTick(id); cxRepaint(id); }).catch(()=>{}); }
  if(CX.commits[id]===undefined){ CX.commits[id]=null; invokeQuiet('task_commits',{ taskId:id }).then(c=>{ CX.commits[id]=Array.isArray(c)?c:[]; cxRepaint(id); }).catch(()=>{ CX.commits[id]=[]; }); }
  if(!CX.thLoaded[id]){ CX.thLoaded[id]=1;
    invokeQuiet('read_artifact',{ taskId:id, name:'.trecho-conversas.json' }).then(c=>{ let a=[]; try{ a=JSON.parse((c&&c.text)||'[]'); }catch(_){ } if(Array.isArray(a) && a.length && !(CX.threads[id]||[]).length){ CX.threads[id]=a; cxRepaint(id); } }).catch(()=>{}); }
}
let cxSaveT=null;
function cxSaveThreads(taskId){ clearTimeout(cxSaveT); cxSaveT=setTimeout(()=>{ invokeQuiet('write_artifact',{ taskId, name:'.trecho-conversas.json', content:JSON.stringify(cxThreads(taskId).slice(-80), null, 1) }).catch(()=>{}); }, 600); }
function cxRepaint(taskId){ if(typeof teLive==='function' && typeof fwTask!=='undefined' && fwTask===taskId){ const tt=fwTaskObj(); if(tt && typeof teRailPaint==='function' && typeof TE!=='undefined' && TE.on) teRailPaint(tt); } if(typeof fwTask!=='undefined' && fwTask===taskId && typeof fwMode!=='undefined' && fwMode==='codigo' && cxOn()){ const t=fwTaskObj(), m=$id('fwMain'); if(t && m) cxRender(t, m); } }
/** Respostas que chegaram no transcript: grudam no fio do trecho (mesmo com a etapa fora da tela). */
function cxAnswersTick(taskId){
  const L=CX.threads[taskId]; if(!L || !L.length) return;
  const h=CX.hist[taskId]; if(!h) return;
  const t=(state.tasks||[]).find(x=>x.id===taskId);
  const busy=!!(t && (t.busy || ACTIVE_ST.has(t.status) || t.status==='thinking')) || !!(typeof TI!=='undefined' && TI.stat[taskId] && TI.stat[taskId].busy);
  let changed=false;
  for(const th of L){ for(const m of th.msgs||[]){ if(m.who!=='voce' || m.answered) continue;
    const a=cxAnswerOf(h.items, m.ref||th.ref, m.at||0, busy);
    const nx=th.msgs[th.msgs.indexOf(m)+1];
    if(a.found && a.text && (!nx || nx.who!=='ia')){ th.msgs.splice(th.msgs.indexOf(m)+1, 0, { who:'ia', text:a.text, at:Date.now() }); changed=true; }
    else if(a.found && a.text && nx && nx.who==='ia' && nx.text!==a.text){ nx.text=a.text; changed=true; }
    if(a.done && a.text){ m.answered=true; changed=true; } } }
  if(changed) cxSaveThreads(taskId);
}

// ---------------------------------------------------------------- render
function cxAgentName(t){ const n=String((t&&t.agent)||'agente'); return n.charAt(0).toUpperCase()+n.slice(1); }
function cxModelName(t){ const m=(typeof tiTaskModel==='function')?tiTaskModel(t):(t.model||''); return (typeof boardModelName==='function'?boardModelName(m):'')||''; }
function cxWhyHtml(t, w, hist, fi, hk, span){
  const reqB=w.req?`<span class="cx-req" title="${escA(w.reqText)}">${esc(w.req)}</span>`:'<span class="cx-req out" title="o trecho não liga a nenhum requisito">fora</span>';
  const title=w.req?esc(w.reqText||w.req):'Fora dos requisitos';
  if(!w.why) return `<aside class="cx-why"><div class="cx-wh">${reqB}<b>${title}</b></div><p class="cx-none">sem explicação registrada</p>`+
    `<button type="button" class="btn sm" data-cx="why" data-f="${escA(fi)}" data-hk="${escA(hk)}" data-a="${span.a}" data-b="${span.b}" title="cita as linhas no terminal e pede o porquê — a IA registra a resposta">perguntar</button></aside>`;
  const turn=cxTurnAt(hist, w.ts);
  const when=w.ts?new Date(w.ts).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' }):'';
  return `<aside class="cx-why"><div class="cx-wh">${reqB}<b>${title}</b></div><p>${esc(w.why)}</p>`+
    (w.covered?`<div class="cx-cov">Coberto por <span class="mono">${esc(w.covered)}</span></div>`:'')+
    ((turn||when)?`<div class="cx-when">${turn?'Decidido na '+turn+'ª resposta da IA':'Decidido'}${when?', às '+esc(when):''} · <button type="button" class="lnk" data-cx="conv">ver na conversa</button></div>`:'')+
    `<div class="cx-src${w.src==='agente'?'':' inf'}">${esc(CX_SRC_LABEL[w.src]||'')}</div></aside>`;
}
function cxRowsHtml(fi, hk, h, sel){
  let out='', n=0;
  for(const r of h.rows){ if(++n>CX_MAX_ROWS) break;
    const inSel=sel && r.n && r.n>=sel.a && r.n<=sel.b;
    const num=r.n?`<button type="button" class="cx-n" tabindex="-1" data-cx="ln" data-f="${escA(fi)}" data-hk="${escA(hk)}" data-n="${r.n}" title="selecionar a linha ${r.n} (⇧ clique estende)">${r.n}</button>`:`<span class="cx-n del">${r.o||''}</span>`;
    out+=`<div class="cx-ln ${r.t}${inSel?' cx-on':''}">${num}<span class="cx-s" aria-hidden="true">${r.t==='add'?'+':r.t==='del'?'−':''}</span><span class="cx-t">${esc(r.text)||' '}</span></div>`; }
  return out;
}
function cxComposerHtml(ref){
  return `<div class="cx-comp" role="region" aria-label="Linhas selecionadas"><div class="cx-ch"><span class="mono cx-ref">${esc(ref)}</span><span class="cx-dim">linhas selecionadas</span><span class="sp"></span><button type="button" class="cx-x" data-cx="clear" aria-label="Limpar a seleção">${IC.x||'×'}</button></div>`+
    `<textarea id="cxQ" class="in cx-ta" rows="2" placeholder="pergunte sobre essas linhas…" aria-label="Pergunta sobre o trecho">${esc(CX.selTxt||'')}</textarea>`+
    `<div class="cx-ca"><button type="button" class="btn primary sm" data-cx="ask">Perguntar sobre isso</button><button type="button" class="btn sm" data-cx="paste" title="digita a referência no prompt do terminal, sem Enter">Colar no terminal <span class="kbd">⌘L</span></button><button type="button" class="btn ghost sm" data-cx="altsel">Pedir alteração <span class="kbd">⌘⇧L</span></button></div></div>`;
}
function cxThreadHtml(t, th, idx){
  const me=(typeof cloudUserId==='function' && cloudUserId())?personChip(cloudUserId(),{ short:true }):'<b>Você</b>';
  const ag=cxAgentName(t), model=cxModelName(t);
  const msgs=(th.msgs||[]).map(m=>m.who==='ia'
    ? `<div class="cx-msg ia"><span class="cx-av" aria-hidden="true">${esc(ag.charAt(0))}</span><div><div class="cx-mh"><b>${esc(ag)}</b><span class="cx-tag">IA${model?' · '+esc(model):''}</span><span class="cx-dim">responde sobre ${esc(String(th.ref).split('/').pop())}</span></div><div class="cx-mb mdlite">${typeof mdToHtml==='function'?mdToHtml(m.text):esc(m.text)}</div></div></div>`
    : m.who==='alt' ? `<div class="cx-sent">${IC.check||'✓'}<span>Pedido enviado ao terminal: <span class="mono">${esc(m.text)}</span>${m.queued?' · <b>na fila</b>: entra quando a IA terminar o passo':''}</span></div>`
    : m.who==='nota' ? `<div class="cx-sent">${TE_IC.note}<span>Virou nota da memória do time · origem: ${esc(m.text)}</span></div>`
    : `<div class="cx-msg"><span class="cx-me">${me}</span><div><div class="cx-mh"><span class="cx-dim">${esc(new Date(m.at||Date.now()).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' }))}${m.queued?' · na fila':''}</span></div><p>${esc(m.q)}</p></div></div>`).join('');
  const last=(th.msgs||[])[th.msgs.length-1]||{};
  const waiting=last.who==='voce' && !last.answered;
  const alt=CX.alt===th.id;
  const acts=alt
    ? `<div class="cx-alt"><input class="in" id="cxAlt" value="${escA(CX.altTxt||'')}" placeholder="o que mudar nessas linhas…" aria-label="Pedido de alteração"><button type="button" class="btn primary sm" data-cx="altsend" data-th="${escA(th.id)}">Mandar pro terminal</button><button type="button" class="btn ghost sm" data-cx="altoff">Cancelar</button></div>`
    : `<div class="cx-acts"><button type="button" class="btn primary sm" data-cx="alt" data-th="${escA(th.id)}">Pedir alteração aqui</button><button type="button" class="btn ghost sm" data-cx="note" data-th="${escA(th.id)}"${th.noted?' disabled':''}>Virar nota da memória</button><input class="in cx-reply" data-th="${escA(th.id)}" value="${escA(CX.reply[th.id]||'')}" placeholder="Responder…" aria-label="Responder no fio"></div>`;
  return `<section class="cx-thread" id="cxth-${idx}" aria-label="Conversa sobre ${escA(th.ref)}"><div class="cx-th">${TE_IC.term}<b>Conversa sobre <span class="mono">${esc(String(th.ref).replace(/^@/,''))}</span></b><span class="cx-dim">· também está na Conversa da tarefa</span><span class="sp"></span><button type="button" class="btn ghost sm" data-cx="conv">Ver no terminal</button></div>`+
    msgs+(waiting?`<div class="cx-msg ia typing"><span class="cx-av" aria-hidden="true">${esc(ag.charAt(0))}</span><p class="cx-dim">${esc(ag)} está respondendo no terminal…</p></div>`:'')+acts+`</section>`;
}
// Lista recolhida/aberta: lembrada por tarefa (e a última escolha vale pras tarefas sem escolha própria).
function cxNavOff(taskId){ try{ const m=JSON.parse(localStorage.getItem('sf.cx.navOff')||'{}'); return taskId in m ? !!m[taskId] : !!m._last; }catch(_){ return false; } }
function cxNavSet(taskId, off){ try{ const m=JSON.parse(localStorage.getItem('sf.cx.navOff')||'{}'); m[taskId]=off?1:0; m._last=off?1:0; const ks=Object.keys(m); if(ks.length>200) delete m[ks[0]]; localStorage.setItem('sf.cx.navOff', JSON.stringify(m)); }catch(_){ } }
const CX_KIND_TAG={ junk:'lixo', gen:'gerado' };
/** Lista de arquivos à esquerda: filtro (/), grupos, nome em destaque + pasta, +/−, marcadores. */
function cxNavHtml(t, files, openPath, outOf, threads){
  const q=String(CX.navQ[t.id]||'').trim().toLowerCase();
  const genOpen=!!CX.genOpen[t.id] || (openPath && ['gen','junk'].includes(cxKind(files.find(f=>f.path===openPath)||{})));
  const row=x=>{ const k=cxKind(x), sp=cxSplitPath(x.path), n=threads.filter(th=>th.file===x.path).length, bin=cxIsBin(x);
    const tag=bin?'binário':cxIsHuge(x)?'enorme':(CX_KIND_TAG[k]||'');
    const nums=bin?'':`<span class="cx-a">+${x.add||0}</span><span class="cx-d">−${x.del||0}</span>`;
    return `<button type="button" class="cx-row${k==='junk'?' junk':''}" data-cx="file" data-f="${escA(x.path)}" data-q="${escA(x.path.toLowerCase())}" aria-current="${x.path===openPath?'true':'false'}" title="${escA(x.path)}"${q&&!x.path.toLowerCase().includes(q)?' hidden':''}>`+
      `<span class="cx-r1"><span class="cx-rf">${esc(sp.name)}</span>${CX.seen[t.id+'|'+x.path]?`<span class="cx-seen" aria-label="visto" title="visto">${IC.check||'✓'}</span>`:''}${outOf[x.path]?'<span class="cx-w" title="tem trecho fora dos requisitos" aria-label="fora dos requisitos"></span>':''}${n?`<span class="cx-tc" title="${n} ${n===1?'conversa':'conversas'} neste arquivo">${TE_IC.term}${n}</span>`:''}<span class="sp"></span>${nums}</span>`+
      `<span class="cx-r2"><span class="cx-rd"><bdi>${sp.dir?esc(sp.dir.replace(/\/$/,'')):'raiz'}</bdi></span>${tag?`<span class="cx-rk">${tag}</span>`:''}</span></button>`; };
  const groups=cxGroupFiles(files).map(g=>{
    const head=g.k==='gen'
      ? `<button type="button" class="cx-gh cx-ghb" data-cx="gen" aria-expanded="${genOpen}"><span class="cx-gc" aria-hidden="true">${genOpen?(IC.cleft||'‹'):(IC.cright||'›')}</span>${esc(g.label)}<span class="cx-gn">${g.files.length}</span></button>`
      : `<div class="cx-gh">${esc(g.label)}<span class="cx-gn">${g.files.length}</span></div>`;
    const vis=!q || g.files.some(x=>x.path.toLowerCase().includes(q));
    return `<div class="cx-g" data-g="${g.k}"${vis?'':' hidden'}>${head}<div class="cx-gb"${g.k==='gen'&&!genOpen?' hidden':''}>${g.files.map(row).join('')}</div></div>`; }).join('');
  const none=q && !files.some(x=>x.path.toLowerCase().includes(q));
  return `<nav class="cx-nav${q?' filtering':''}" aria-label="Arquivos alterados"><div class="cx-navh"><input class="in cx-nq" id="cxNavQ" type="search" placeholder="Filtrar ${files.length} ${files.length===1?'arquivo':'arquivos'}" aria-label="Filtrar arquivos (atalho /)" autocomplete="off" spellcheck="false" value="${escA(CX.navQ[t.id]||'')}"><span class="kbd cx-nk" aria-hidden="true">/</span>`+
    `<button type="button" class="cx-ntog" data-cx="nav" aria-label="Recolher a lista de arquivos" title="Recolher a lista (A)">${IC.cleft||'‹'}</button></div>`+
    `<div class="cx-nlist" id="cxNavList">${groups}<div class="cx-nnone cx-dim"${none?'':' hidden'}>Nenhum arquivo com “${esc(q)}”.</div></div>`+
    `<div class="cx-nfoot cx-dim"><span class="kbd">J</span><span class="kbd">K</span> arquivo · <span class="kbd">N</span><span class="kbd">P</span> trecho</div></nav>`;
}
/** Filtro sem repintar (cada tecla): esconde linhas e grupos; filtrando, "Gerados" abre sozinho. */
function cxNavFilter(main, taskId, v){
  CX.navQ[taskId]=v; const q=String(v||'').trim().toLowerCase();
  const nav=main.querySelector('.cx-nav'); if(!nav) return;
  nav.classList.toggle('filtering', !!q);
  let any=false;
  nav.querySelectorAll('.cx-g').forEach(g=>{ let n=0; g.querySelectorAll('.cx-row').forEach(r=>{ const h=!!q && !r.dataset.q.includes(q); r.hidden=h; if(!h) n++; }); g.hidden=!n; if(n) any=true; });
  const no=nav.querySelector('.cx-nnone'); if(no){ no.hidden=!q || any; no.textContent=q&&!any?'Nenhum arquivo com “'+v.trim()+'”.':''; }
}
/** Caminhos na ordem da lista que dá pra percorrer com J/K (respeita o filtro e o grupo recolhido). */
function cxNavPaths(main){
  const nav=main.querySelector('.cx-nav');
  if(!nav){ const t=cxTask(), go=t&&CX.genOpen[t.id]; return cxOrderFiles(cxCodeFiles()).filter(f=>{ const k=cxKind(f); return k!=='junk' && (go || k!=='gen'); }).map(f=>f.path); }
  const filtering=nav.classList.contains('filtering');
  return [...nav.querySelectorAll('.cx-row')].filter(r=>!r.hidden && !r.closest('.cx-g[hidden]') && (filtering || !r.closest('.cx-gb[hidden]'))).map(r=>r.dataset.f);
}
/** A superfície inteira (chamada pelo renderWorkspace no modo etapas). Só troca o DOM quando o conteúdo mudou. */
function cxRender(t, main){
  const files=cxCodeFiles();
  const cur=files.some(f=>f.path===CX.file[t.id]) ? CX.file[t.id] : cxDefaultFile(files);
  cxDiffs(t, cur); cxLoadAux(t, false);
  const d=CX.data[t.id]||{ files:{} };
  const rows=typeof reqRows==='function'?reqRows(t):[];
  const reqs=rows.map(r=>({ text:r.text, did:r.did, code:r.code||[], tests:r.tests||[] }));
  const reasons=(CX.reasons[t.id]||{}).list||[], hist=(CX.hist[t.id]||{}).items||[];
  const pr=(typeof prCache!=='undefined' && prCache[t.id])||null;
  const hasMap=reasons.some(r=>r&&r.requirement) || reqs.some(r=>(r.code||[]).length);
  let html;
  if(!files.length){
    html=`<div class="cx-empty"><div class="cx-et">${(typeof fwFilesLoading!=='undefined'&&fwFilesLoading)?'Carregando os arquivos…':'Nenhum arquivo mudou ainda'}</div><div class="cx-dim">Quando a IA editar algo, cada trecho aparece aqui com o motivo da mudança.</div></div>`;
  } else {
    const f=files.find(x=>x.path===cur)||files[0]; CX.file[t.id]=f.path;
    const kind=cxKind(f), fk=t.id+'|'+f.path, huge=cxIsHuge(f) && !CX.force[fk];
    const fd=d.files[f.path]||{};
    const filt=CX.filt[t.id]||'todos';
    const threads=cxThreads(t.id);
    // porquê de cada hunk de cada arquivo (conta "fora" e o resumo do arquivo)
    const whyAll={}, outOf={}; let nOut=0;
    for(const x of files){ const xd=d.files[x.path]; if(!xd||!xd.hunks) continue;
      whyAll[x.path]=xd.hunks.map(h=>{ const span=cxHunkSpan(h); return { span, w:cxWhyOf({ file:x.path, span, reasons, reqs, hist, commits:CX.commits[t.id]||[], prBody:pr&&pr.body }) }; });
      if(hasMap){ const n=whyAll[x.path].filter(y=>!y.w.req).length; nOut+=n; if(n) outOf[x.path]=1; } }
    const seg=hasMap?`<div class="te-seg cx-filt" role="group" aria-label="Filtrar trechos"><button type="button" data-cx="filt" data-v="todos" aria-pressed="${filt==='todos'}">Todos os trechos</button><button type="button" data-cx="filt" data-v="fora" aria-pressed="${filt==='fora'}">Fora dos requisitos · ${nOut}</button></div>`:'';
    const wl=whyAll[f.path]||[];
    const sum=cxFileSummary(wl.map(y=>y.w));
    const ai=(typeof fwWhyCache!=='undefined')?fwWhyCache[fk]:undefined;
    const quiet=kind==='junk' || cxIsBin(f) || huge;
    const sumTx=sum?esc(sum):(ai&&ai.md)?(typeof mdToHtml==='function'?mdToHtml(ai.md):esc(ai.md)):ai===null?'<span class="cx-dim">lendo o diff e escrevendo a explicação…</span>':'<span class="cx-dim">o agente ainda não registrou o porquê dos trechos deste arquivo.</span>';
    const fsum=quiet?'':`<div class="cx-fsum"><div class="cx-fsb"><div class="cx-fst">O que mudou neste arquivo e por quê</div><div class="cx-fsx">${sumTx}</div></div><div class="cx-fsa">${!sum&&!(ai&&ai.md)&&ai!==null?`<button type="button" class="btn sm" data-cx="aiwhy" title="a IA lê o diff deste arquivo e explica (usa créditos)">explicar com IA</button>`:''}<button type="button" class="btn sm" data-cx="seen">${CX.seen[fk]?(IC.check||'✓')+' Visto':'Marcar como visto'}</button></div></div>`;
    let hunks='';
    const nLines=((+f.add||0)+(+f.del||0)).toLocaleString('pt-BR');
    if(kind==='junk') hunks=`<div class="cx-empty"><div class="cx-et">Arquivo de sistema, nada pra revisar</div><div class="cx-dim">${esc(f.path)} · sobra de zip do macOS ou do sistema (__MACOSX, ._*, .DS_Store). Vale tirar do commit.</div></div>`;
    else if(cxIsBin(f)) hunks=`<div class="cx-empty"><div class="cx-et">Arquivo binário</div><div class="cx-dim">${esc(f.path)} · sem diff de texto pra explicar trecho a trecho.</div></div>`;
    else if(huge) hunks=`<div class="cx-empty cx-big"><div class="cx-et">Arquivo grande (${nLines} linhas), provavelmente gerado</div><div class="cx-dim mono">${esc(f.path)}</div><div class="cx-dim">Pintar tudo deixa a tela lenta. Se pedir, o diff mostra até ${CX_MAX_ROWS.toLocaleString('pt-BR')} linhas por trecho.</div><button type="button" class="btn sm" data-cx="force">Mostrar mesmo assim</button></div>`;
    else if(fd.loading && !fd.hunks) hunks=typeof skeletonHtml==='function'?skeletonHtml('tabela',{ n:6, cols:2, inline:true, label:'carregando as mudanças' }):'<div class="cx-dim">carregando…</div>';
    else if(fd.err) hunks=`<div class="cx-empty"><div class="cx-et">não consegui gerar o diff deste arquivo</div><div class="cx-dim" title="${escA(fd.err.slice(0,400))}">${esc(typeof errShort==='function'?errShort(fd.err):fd.err)}</div></div>`;
    else if(fd.hunks && !fd.hunks.length) hunks='<div class="cx-empty"><div class="cx-dim">sem diferenças neste arquivo em relação à base</div></div>';
    else if(fd.hunks){
      fd.hunks.forEach((h,i)=>{
        const y=wl[i]||{ span:cxHunkSpan(h), w:{ why:'' } };
        if(filt==='fora' && hasMap && y.w.req) return;
        const hk=String(y.span.a);
        const sel=CX.sel && CX.sel.task===t.id && CX.sel.file===f.path && CX.sel.hk===hk ? { a:Math.min(CX.sel.a,CX.sel.b), b:Math.max(CX.sel.a,CX.sel.b) } : null;
        const ths=threads.filter(th=>th.file===f.path && th.hk===hk);
        const mark=ths.length?`<button type="button" class="cx-hmark" data-cx="goth" data-i="${threads.indexOf(ths[0])}">${TE_IC.term}${ths.length} ${ths.length===1?'conversa':'conversas'}</button>`:'';
        const lbl=y.span.delOnly?'linha '+y.span.a+' · só remoções':y.span.a===y.span.b?'linha '+y.span.a:'linhas '+y.span.a+'–'+y.span.b;
        const cut=h.rows.length>CX_MAX_ROWS?`<div class="cx-cut">mostrando ${CX_MAX_ROWS.toLocaleString('pt-BR')} de ${h.rows.length.toLocaleString('pt-BR')} linhas deste trecho</div>`:'';
        hunks+=`<div class="cx-hw"><div class="cx-hunk${hasMap&&!y.w.req?' out':''}"><div class="cx-diff"><div class="cx-hh"><span>${esc(lbl)}</span>${h.ctx?`<span class="mono cx-dim cx-ctx">${esc(h.ctx)}</span>`:''}<span class="sp"></span>${mark}<button type="button" class="lnk cx-askh" data-cx="hsel" data-f="${escA(f.path)}" data-hk="${escA(hk)}" data-a="${y.span.a}" data-b="${y.span.b}">perguntar sobre este trecho</button></div>${cxRowsHtml(f.path, hk, h, sel)}${cut}</div>${cxWhyHtml(t, y.w, hist, f.path, hk, y.span)}</div>`+
          (sel?cxComposerHtml(cxRef(f.path, sel.a, sel.b)):'')+ths.map(th=>cxThreadHtml(t, th, threads.indexOf(th))).join('')+`</div>`;
      });
      if(!hunks) hunks='<div class="cx-empty"><div class="cx-dim">Nenhum trecho fora dos requisitos neste arquivo.</div></div>';
    }
    const off=cxNavOff(t.id), sp=cxSplitPath(f.path);
    const nav=off?'':cxNavHtml(t, files, f.path, outOf, threads);
    const open=off?`<button type="button" class="cx-ntog on" data-cx="nav" aria-label="Mostrar a lista de arquivos" title="Mostrar a lista (A)">${IC.cright||'›'}<span>Arquivos · ${files.length}</span></button>`:'';
    const bar=`<div class="cx-bar">${open}<div class="cx-cur" title="${escA(f.path)}"><span class="cx-cd"><bdi>${esc(sp.dir)}</bdi></span><b class="cx-cn">${esc(sp.name)}</b>${cxIsBin(f)?'':`<span class="cx-a">+${f.add||0}</span><span class="cx-d">−${f.del||0}</span>`}</div>${seg}</div>`;
    html=`<div class="cx${off?' nav-off':''}" data-cx-task="${escA(t.id)}">${nav}<div class="cx-body">${bar}`+
      `<div class="cx-scroll" id="cxScroll">${fsum}${hunks}${quiet?'':'<div class="cx-hint">Clique no número da linha para selecionar, ⇧ clique para estender. "Perguntar sobre isso" abre uma conversa presa ao trecho; a mesma conversa aparece no terminal.</div>'}</div></div></div>`;
  }
  if(main.__cxHtml===html && main.querySelector('.cx,.cx-empty')) return;
  // repintar sem perder o que a pessoa está escrevendo (compositor, pedido, resposta, filtro) nem a rolagem
  const ae=document.activeElement, keep=ae && main.contains(ae) ? { id:ae.id, th:ae.dataset&&ae.dataset.th, f:ae.classList&&ae.classList.contains('cx-row')?ae.dataset.f:null, s:ae.selectionStart, e:ae.selectionEnd } : null;
  const sc=$id('cxScroll'), top=sc?sc.scrollTop:0, nl=$id('cxNavList'), ntop=nl?nl.scrollTop:0;
  main.__cxHtml=html; main.innerHTML=html;
  const sc2=$id('cxScroll'); if(sc2) sc2.scrollTop=top;
  const nl2=$id('cxNavList'); if(nl2) nl2.scrollTop=ntop;
  if(keep){ const el=keep.id?$id(keep.id):keep.th?main.querySelector(`.cx-reply[data-th="${CSS.escape(keep.th)}"]`):keep.f?main.querySelector(`.cx-row[data-f="${CSS.escape(keep.f)}"]`):null; if(el){ el.focus({ preventScroll:true }); try{ if(keep.s!=null) el.setSelectionRange(keep.s, keep.e); }catch(_){ } } }
  cxWire(t, main);
}
function cxWire(t, main){
  if(main.__cxWired===t.id) return; main.__cxWired=t.id;
  main.addEventListener('click', (e)=>cxClick(e, main));
  main.addEventListener('input', (e)=>{ const el=e.target; if(el.id==='cxNavQ'){ const tt=cxTask(); if(tt) cxNavFilter(main, tt.id, el.value); return; } if(el.id==='cxQ') CX.selTxt=el.value; else if(el.id==='cxAlt') CX.altTxt=el.value; else if(el.classList && el.classList.contains('cx-reply')) CX.reply[el.dataset.th]=el.value; });
  main.addEventListener('keydown', (e)=>{
    const el=e.target;
    if(el.id==='cxNavQ'){ // filtro: Enter abre o primeiro, ↓ desce pra lista, Esc limpa (e depois sai)
      const first=cxNavPaths(main)[0];
      if(e.key==='Enter' && first){ e.preventDefault(); cxAct('file', { dataset:{ f:first } }); }
      else if(e.key==='ArrowDown'){ e.preventDefault(); const r=first&&main.querySelector(`.cx-row[data-f="${CSS.escape(first)}"]`); if(r) r.focus(); }
      else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); if(el.value){ el.value=''; const tt=cxTask(); if(tt) cxNavFilter(main, tt.id, ''); } else el.blur(); }
      return; }
    if(el.id==='cxQ' && e.key==='Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey){ e.preventDefault(); cxAct('ask'); }
    else if(el.id==='cxAlt' && e.key==='Enter'){ e.preventDefault(); cxAct('altsend', el.closest('.cx-thread') && el.closest('.cx-thread').querySelector('[data-cx="altsend"]')); }
    else if(el.classList && el.classList.contains('cx-reply') && e.key==='Enter'){ e.preventDefault(); cxReply(el.dataset.th, el.value); }
    else if(e.key==='Escape' && CX.sel && (el.id==='cxQ' || !/INPUT|TEXTAREA/.test(el.tagName))){ e.preventDefault(); e.stopPropagation(); CX.sel=null; cxRepaint(t.id); }
  });
}
function cxTask(){ const t=typeof fwTaskObj==='function'?fwTaskObj():null; return t&&fwMode==='codigo'&&cxOn()?t:null; }
function cxClick(e, main){
  const b=e.target.closest('[data-cx]'); if(!b || !main.contains(b)) return;
  cxAct(b.dataset.cx, b, e);
}
async function cxAct(k, b, e){
  const t=cxTask(); if(!t) return;
  const ds=(b&&b.dataset)||{};
  if(k==='file'){ if(!ds.f) return; const nav=document.activeElement && document.activeElement.closest && document.activeElement.closest('.cx-nav');
    CX.file[t.id]=ds.f; CX.sel=null; const s=$id('cxScroll'); if(s) s.scrollTop=0; cxRepaint(t.id);
    const r=document.querySelector(`#fwMain .cx-row[data-f="${CSS.escape(ds.f)}"]`); if(r){ r.scrollIntoView({ block:'nearest' }); if(nav) r.focus({ preventScroll:true }); }
    return; }
  if(k==='nav'){ const off=!cxNavOff(t.id); cxNavSet(t.id, off); cxRepaint(t.id); setTimeout(()=>{ const el=off?document.querySelector('#fwMain .cx-bar [data-cx="nav"]'):$id('cxNavQ'); if(el) el.focus({ preventScroll:true }); }, 0); return; }
  if(k==='gen'){ CX.genOpen[t.id]=!CX.genOpen[t.id]; cxRepaint(t.id); return; }
  if(k==='force'){ CX.force[t.id+'|'+CX.file[t.id]]=1; cxRepaint(t.id); return; }
  if(k==='filt'){ CX.filt[t.id]=ds.v; cxRepaint(t.id); return; }
  if(k==='seen'){ const kk=t.id+'|'+CX.file[t.id]; CX.seen[kk]=!CX.seen[kk]; cxRepaint(t.id); return; }
  if(k==='aiwhy'){ if(typeof fwAskWhy==='function'){ fwAskWhy(t.id, CX.file[t.id]); } return; }
  if(k==='conv'){ if(typeof teGo==='function') teGo('conversa'); return; }
  if(k==='ln'){ const n=+ds.n; const same=CX.sel && CX.sel.task===t.id && CX.sel.file===ds.f && CX.sel.hk===ds.hk;
    if(e && e.shiftKey && same) CX.sel.b=n; else CX.sel={ task:t.id, file:ds.f, hk:ds.hk, a:n, b:n };
    cxRepaint(t.id); setTimeout(()=>{ const q=$id('cxQ'); if(q) q.focus({ preventScroll:true }); }, 0); return; }
  if(k==='hsel'){ CX.sel={ task:t.id, file:ds.f, hk:ds.hk, a:+ds.a, b:+ds.b }; cxRepaint(t.id); setTimeout(()=>{ const q=$id('cxQ'); if(q){ q.focus({ preventScroll:true }); q.scrollIntoView({ block:'nearest' }); } }, 0); return; }
  if(k==='clear'){ CX.sel=null; cxRepaint(t.id); return; }
  if(k==='goth'){ const el=$id('cxth-'+ds.i); if(el) el.scrollIntoView(typeof scrollOpts==='function'?scrollOpts('center'):{ block:'center' }); return; }
  if(k==='why'){ const ref=cxRef(ds.f, +ds.a, +ds.b); if(await cxSend(t, cxPtyText('why', ref))){ cxThreadPush(t, { file:ds.f, hk:ds.hk, a:+ds.a, b:+ds.b, ref }, { who:'voce', q:'Por que este trecho mudou?', ref, at:Date.now(), queued:cxBusy(t) }); } return; }
  if(k==='ask'||k==='paste'||k==='altsel'){
    const s=CX.sel; if(!s || s.task!==t.id){ toast('selecione as linhas primeiro (clique no número da linha)','info'); return; }
    const a=Math.min(s.a,s.b), bb=Math.max(s.a,s.b), ref=cxRef(s.file, a, bb), q=String(($id('cxQ')||{}).value||CX.selTxt||'').trim();
    if(k==='paste'){ if(typeof tiType==='function') tiType(t.id, cxPtyText('paste', ref, q)); CX.sel=null; CX.selTxt=''; toast('referência colada no terminal da tarefa — nada foi enviado ainda','ok'); if(typeof teGo==='function') teGo('conversa'); return; }
    if(k==='altsel'){ if(!q){ toast('escreva o que mudar nessas linhas','info'); const el=$id('cxQ'); if(el) el.focus(); return; }
      const tx=cxPtyText('alt', ref, q); const busy=cxBusy(t);
      if(await cxSend(t, tx)){ cxThreadPush(t, { file:s.file, hk:s.hk, a, b:bb, ref }, { who:'alt', text:tx, at:Date.now(), queued:busy }); CX.sel=null; CX.selTxt=''; toast(busy?'pedido na fila do terminal — entra quando a IA terminar o passo':'pedido enviado ao terminal','ok'); }
      return; }
    if(!q){ toast('escreva a pergunta sobre essas linhas','info'); const el=$id('cxQ'); if(el) el.focus(); return; }
    const busy=cxBusy(t);
    if(await cxSend(t, cxPtyText('ask', ref, q))){ cxThreadPush(t, { file:s.file, hk:s.hk, a, b:bb, ref }, { who:'voce', q, ref, at:Date.now(), queued:busy }); CX.sel=null; CX.selTxt=''; }
    return; }
  if(k==='alt'){ CX.alt=ds.th; CX.altTxt=''; cxRepaint(t.id); setTimeout(()=>{ const el=$id('cxAlt'); if(el) el.focus(); }, 0); return; }
  if(k==='altoff'){ CX.alt=null; cxRepaint(t.id); return; }
  if(k==='altsend'){ const th=cxThreads(t.id).find(x=>x.id===ds.th); const q=String(($id('cxAlt')||{}).value||CX.altTxt||'').trim(); if(!th) return;
    if(!q){ toast('escreva o que mudar','info'); return; }
    const tx=cxPtyText('alt', th.ref, q), busy=cxBusy(t);
    if(await cxSend(t, tx)){ th.msgs.push({ who:'alt', text:tx, at:Date.now(), queued:busy }); CX.alt=null; CX.altTxt=''; cxSaveThreads(t.id); cxRepaint(t.id); toast(busy?'pedido na fila do terminal — entra quando a IA terminar o passo':'pedido enviado ao terminal','ok'); }
    return; }
  if(k==='note'){ const th=cxThreads(t.id).find(x=>x.id===ds.th); if(th) cxToMemory(t, th, b); return; }
}
function cxBusy(t){ return !!(t.busy || ACTIVE_ST.has(t.status) || t.status==='thinking' || (typeof TI!=='undefined' && TI.stat[t.id] && TI.stat[t.id].busy)); }
/** Manda pro PTY da tarefa (o MESMO caminho dos chips e botões do terminal integrado). */
async function cxSend(t, text){
  if(!text) return false;
  if(typeof tiSend!=='function'){ toast('o terminal desta tarefa não está disponível','warn'); return false; }
  return !!(await tiSend(t.id, text));
}
function cxThreadPush(t, at, msg){
  const L=cxThreads(t.id);
  let th=L.find(x=>x.file===at.file && x.hk===at.hk && x.ref===at.ref);
  if(!th){ th={ id:'th'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), file:at.file, hk:at.hk, a:at.a, b:at.b, ref:at.ref, msgs:[] }; L.push(th); }
  th.msgs.push(msg); cxSaveThreads(t.id); CX.loadingAt[t.id+':h']=0; cxRepaint(t.id);
  setTimeout(()=>{ const el=$id('cxth-'+L.indexOf(th)); if(el) el.scrollIntoView({ block:'nearest' }); }, 30);
  if(typeof teLive==='function') teLive(t);
}
async function cxReply(thId, txt){
  const t=cxTask(); if(!t) return; const th=cxThreads(t.id).find(x=>x.id===thId); const q=String(txt||'').trim(); if(!th || !q) return;
  const busy=cxBusy(t);
  if(await cxSend(t, cxPtyText('ask', th.ref, q))){ th.msgs.push({ who:'voce', q, ref:th.ref, at:Date.now(), queued:busy }); CX.reply[thId]=''; cxSaveThreads(t.id); cxRepaint(t.id); }
}
/** "Virar nota da memória": nota do TIME com a origem (a pergunta + a resposta do fio). */
async function cxToMemory(t, th, btn){
  const q=(th.msgs.find(m=>m.who==='voce')||{}).q||'', a=(th.msgs.find(m=>m.who==='ia')||{}).text||'';
  if(!a){ toast('espere a resposta da IA — a nota leva a pergunta e a resposta','info'); return; }
  const code=(typeof teCodeOf==='function')?teCodeOf(t):'';
  const origem='conversa no trecho '+String(th.ref).replace(/^@/,'').split('/').pop()+(code?' ('+code+')':'');
  const note={ title:cxClip(q.replace(/\?+$/,''), 80)||('Sobre '+th.ref), type:'contexto', tags:['conversa-no-trecho'], updated:typeof memToday==='function'?memToday():'', body:`${a}\n\n— Pergunta: ${q}\n— Trecho: ${th.ref.replace(/^@/,'')}`,
    by:typeof memWho==='function'?memWho():'', origem:'pessoa', extra:{ fonte:origem } };
  if(btn) btn.disabled=true;
  try{
    if(typeof memSerialize!=='function') throw new Error('memória indisponível');
    await invoke('memory_write',{ repo:state.repo, scope:'time', slug:null, content:memSerialize(note), expectMtime:null, create:true });
    th.noted=true; th.msgs.push({ who:'nota', text:origem, at:Date.now() }); cxSaveThreads(t.id); cxRepaint(t.id);
    toast('Virou nota da memória do time', 'ok', { label:'ver', fn:()=>openTab('memoria') });
    if(typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(err){ if(btn) btn.disabled=false; showErr(err, 'Não consegui criar a nota'); }
}
/** Poll da tarefa aberta (75 teLive): com fio esperando resposta, relê o transcript mesmo fora da etapa. */
function cxLive(t){
  const L=CX.threads[t.id]; const waiting=!!(L && L.some(th=>(th.msgs||[]).some(m=>m.who==='voce' && !m.answered)));
  if(waiting || (fwMode==='codigo' && cxOn())) cxLoadAux(t, false);
}
// ⌘L / ⌘⇧L com linhas selecionadas (fora do terminal — lá as teclas são do shell)
window.addEventListener('keydown', (e)=>{
  if(!CX.sel || !cxTask()) return;
  if(e.target && e.target.closest && e.target.closest('.xterm')) return;
  const mac=typeof osKind==='function'?osKind()==='mac':true;
  if(!(mac?e.metaKey:e.ctrlKey) || e.altKey || String(e.key).toLowerCase()!=='l') return;
  e.preventDefault(); e.stopPropagation();
  cxAct(e.shiftKey?'altsel':'paste');
}, true);
// J/K (↑/↓ dentro da lista) troca de arquivo, N/P pula de trecho, / filtra, A recolhe a lista — nunca com o foco em campo ou
// no terminal (lá as teclas são da pessoa/do shell).
function cxHunkJump(d){
  const sc=$id('cxScroll'); if(!sc) return; const top=sc.getBoundingClientRect().top;
  const ys=[...sc.querySelectorAll('.cx-hw')].map(h=>h.getBoundingClientRect().top-top);
  const y=d>0?ys.find(v=>v>8):ys.filter(v=>v<-8).pop();
  if(y==null) return; sc.scrollTop=sc.scrollTop+y-6;
}
window.addEventListener('keydown', (e)=>{
  const t=cxTask(); if(!t || e.defaultPrevented) return;
  const main=$id('fwMain'); if(!main || !main.querySelector('.cx') || !main.offsetParent) return;
  const el=e.target||{};
  const inField=!!(el.closest && el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],.xterm,[role="dialog"],[role="menu"]')) || el.isContentEditable===true;
  const k=cxNavKey(e, inField, !!(el.closest && el.closest('.cx-nav')));
  if(!k) return;
  e.preventDefault();
  if(k==='next'||k==='prev'){ const p=cxStep(cxNavPaths(main), CX.file[t.id], k==='next'?1:-1); if(p && p!==CX.file[t.id]) cxAct('file', { dataset:{ f:p } }); return; }
  if(k==='hnext'||k==='hprev'){ cxHunkJump(k==='hnext'?1:-1); return; }
  if(k==='nav'){ cxAct('nav', null); return; }
  if(k==='find'){ if(cxNavOff(t.id)){ cxNavSet(t.id, false); cxRepaint(t.id); } setTimeout(()=>{ const q=$id('cxNavQ'); if(q){ q.focus(); q.select(); } }, 0); }
});
