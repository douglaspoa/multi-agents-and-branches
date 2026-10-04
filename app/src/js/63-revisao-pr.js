// Starfork — 63-revisao-pr: abas REVISÃO (por requisito) e PR ("pronto pra integrar?") da tarefa (dono, 03/10).
// Revisão: você revisa o que foi PEDIDO — cada requisito com o que o agente diz que fez, a prova, os testes e SÓ os
// trechos daquele requisito (comentário do revisor preso ao trecho). O que mudou e não é de nenhum requisito fica em
// "Fora dos requisitos" (escopo que vazou). O mapa trecho→requisito vem do agente (requirements.json: code/tests/did,
// ou a tool MCP map_requirement); sem isso, só o que ele CITOU nas provas (arquivo:linha) liga — o resto fica "não
// classificado", com aviso. Nunca inventa ligação. "Aceito" por requisito vive no sqlite (review_state_get/set) e
// entra no portão do merge. PR: 5 portões no topo, cada vermelho com a própria saída; "Integrar na main" só abre com
// tudo verde e diz o que falta.

// @revpr-puro-inicio (testado em app/tests/revisao-pr.test.mjs)
function rvNorm(x){ return String(x||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function rvHash(s){ let h=5381; s=String(s||''); for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0; return (h>>>0).toString(36); }
// "12-30" | "12" | "12–30" | [12,30] → {a,b}; vazio = arquivo inteiro (null); lixo → undefined
function rvParseRange(v){
  if(v==null || v==='') return null;
  if(Array.isArray(v)){ const a=+v[0], b=+v[v.length-1]; return a>0&&b>=a?{a,b}:undefined; }
  const m=String(v).trim().match(/^(\d+)(?:\s*[-–—:]\s*(\d+))?$/); if(!m) return undefined;
  const a=+m[1], b=m[2]?+m[2]:a; return a>0&&b>=a?{a,b}:undefined;
}
// caminho citado → o arquivo alterado que ele nomeia (exato; senão o ÚNICO que termina com ele). Ambíguo → null.
function rvResolvePath(cited, paths){
  const c=String(cited||'').trim().replace(/\\/g,'/').replace(/^(\.\/)+/,'').replace(/^\/+/,''); if(!c) return null;
  if(paths.includes(c)) return c;
  const m=paths.filter(p=>p.endsWith('/'+c)); return m.length===1?m[0]:null;
}
// faixa de linhas (arquivo NOVO) do que o trecho ADICIONOU; só remoção → as linhas em volta do ponto onde saiu
function rvHunkRange(h){
  const rows=h.rows||[], add=rows.filter(r=>r.t==='add').map(r=>r.n);
  const ns=add.length?add:rows.filter(r=>r.n).map(r=>r.n); // só remoção: o contexto em volta de onde saiu
  if(ns.length) return { a:Math.min(...ns), b:Math.max(...ns) };
  const p=Math.max(1,(h.n||1)-1); return { a:p, b:p+1 };
}
// identidade do trecho: arquivo + linhas adicionadas/removidas (sobrevive a deslocamento de linha)
function rvHunkKey(path, h){ return path+'#'+rvHash((h.rows||[]).filter(r=>r.t!=='ctx').map(r=>(r.t==='add'?'+':'-')+r.text).join('\n')); }
// "src/a.ts", "src/a.ts:12", "a.ts:12-30" citados num texto livre (prova, nota, item do revisor)
function rvCites(text){
  const out=[], re=/([A-Za-z0-9_@\-][A-Za-z0-9_@.\-\/]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:\s*[-–]\s*(\d+))?)?/g; let m;
  const s=String(text||''); while((m=re.exec(s))) out.push({ file:m[1], a:m[2]?+m[2]:0, b:m[3]?+m[3]:(m[2]?+m[2]:0) });
  return out;
}
// files: [{ path, hunks:[diffHunks().hunks…] }] → refs [{ path, hi, key, a, b, add, del }]
function rvRefsOf(files){
  const out=[];
  for(const f of files||[]){ const seen={};
    (f.hunks||[]).forEach((h,hi)=>{ const r=rvHunkRange(h); let key=rvHunkKey(f.path,h);
      seen[key]=(seen[key]||0)+1; if(seen[key]>1) key+='~'+seen[key]; // o MESMO trecho em 2 lugares do arquivo não vira um só
      out.push({ path:f.path, hi, key, a:r.a, b:r.b, add:h.rows.filter(x=>x.t==='add').length, del:h.rows.filter(x=>x.t==='del').length }); }); }
  return out;
}
const rvOverlap=(r, a, b, pad)=>r.a<=b+(pad||0) && r.b>=a-(pad||0);
/**
 * Mapa trecho → requisito. reqs: [{ text, code:[{file,lines}], evidence:[], note, did }].
 * 1) `code` registrado pelo agente manda (arquivo sem faixa = todos os trechos do arquivo);
 * 2) requisito sem `code`: só o que ele CITOU (evidência/nota/"o que fiz") com arquivo[:linha] → ligação "estimada";
 * 3) sobrou trecho: se o agente registrou o mapa (algum `code` não vazio) → "fora dos requisitos"; senão → "não classificado".
 */
function rvMap(reqs, files){
  const refs=rvRefsOf(files), paths=[...new Set(refs.map(r=>r.path))];
  const explicit=(reqs||[]).some(r=>Array.isArray(r.code) && r.code.length>0);
  const byReq=(reqs||[]).map(()=>[]), taken=new Set();
  const add=(i, ref, how)=>{ if(byReq[i].some(x=>x.key===ref.key)) return; byReq[i].push({ ...ref, how }); taken.add(ref.key); };
  (reqs||[]).forEach((r,i)=>{
    if(Array.isArray(r.code) && r.code.length){
      for(const c of r.code){ const p=rvResolvePath(c&&c.file, paths); if(!p) continue; const rg=rvParseRange(c.lines); if(rg===undefined) continue;
        refs.filter(x=>x.path===p && (!rg || rvOverlap(x, rg.a, rg.b, 0))).forEach(x=>add(i, x, 'agente')); }
      return;
    }
    const txt=[...(Array.isArray(r.evidence)?r.evidence:[]), r.note||'', r.did||''].join('\n');
    for(const c of rvCites(txt)){ const p=rvResolvePath(c.file, paths); if(!p) continue;
      refs.filter(x=>x.path===p && (!c.a || rvOverlap(x, c.a, c.b, 2))).forEach(x=>add(i, x, 'estimado')); }
  });
  const rest=refs.filter(x=>!taken.has(x.key));
  return { explicit, byReq, out:explicit?rest:[], unc:explicit?[]:rest, total:refs.length };
}
// assinatura do que você aceitou (os trechos do requisito): mudou depois → o aceite deixa de valer
function rvSig(refs){ return rvHash((refs||[]).map(r=>r.key).sort().join('|')); }
// estado do aceite: 'acc' (vale) · 'stale' (o código do requisito mudou depois) · '' (não aceito).
// sigReady=false (diffs ainda carregando): não derruba o aceite à toa
function rvAccOf(entry, sig, sigReady){ if(!entry) return ''; if(sigReady && entry.sig!=null && entry.sig!==sig) return 'stale'; return 'acc'; }
// itens do "muda" do revisor → preso ao trecho (arquivo:linha dentro dele; só arquivo e 1 trecho nele) ou solto
function rvPinItems(items, files){
  const refs=rvRefsOf(files), paths=[...new Set(refs.map(r=>r.path))], pins={}, loose=[];
  for(const it of items||[]){
    let ref=null;
    for(const c of rvCites(it)){ const p=rvResolvePath(c.file, paths); if(!p) continue;
      const inFile=refs.filter(x=>x.path===p);
      ref=c.a ? inFile.find(x=>rvOverlap(x, c.a, c.b, 3))||null : (inFile.length===1?inFile[0]:null);
      if(ref) break; }
    if(ref) (pins[ref.key]=pins[ref.key]||[]).push(String(it)); else loose.push(String(it));
  }
  return { pins, loose };
}
// ---- os 5 portões do PR. st: ok · bad (vermelho, bloqueia) · wn (falta, bloqueia) · run (andando, não bloqueia) · na (não se aplica)
function rvGatesOf(x){
  const G=[];
  const p=x.proof||{};
  G.push(p.st==='none'||!p.n ? { id:'prova', label:'Requisitos com prova', st:'na', val:'tarefa sem requisitos' }
    : p.st==='loading' ? { id:'prova', label:'Requisitos com prova', st:'wn', val:'conferindo as provas…', why:'conferir as provas' }
    : p.st==='proven' ? { id:'prova', label:'Requisitos com prova', st:'ok', val:`${p.n}/${p.n} com prova` }
    : p.st==='override' ? { id:'prova', label:'Requisitos com prova', st:'ok', val:`${p.n-p.missing}/${p.n} · liberado com motivo` }
    : { id:'prova', label:'Requisitos com prova', st:'bad', val:`${p.n-p.missing}/${p.n} com prova`, why:`prova de ${p.missing===1?'1 requisito':p.missing+' requisitos'}` });
  const a=x.acc||{};
  G.push(a.loading ? { id:'aceite', label:'Você aceitou', st:'wn', val:'carregando suas decisões…', why:'carregar suas decisões' }
    : !a.n ? { id:'aceite', label:'Você aceitou', st:'na', val:'nada a aceitar' }
    : a.done>=a.n ? { id:'aceite', label:'Você aceitou', st:'ok', val:`${a.n} de ${a.n}` }
    : { id:'aceite', label:'Você aceitou', st:'wn', val:`${a.done} de ${a.n}`+(a.stale?` · ${a.stale} mudou depois`:''), why:`você aceitar ${a.n-a.done===1?(a.first||'1 requisito'):(a.n-a.done)+' requisitos'}` });
  const r=x.rev||{}, last=(r.rounds||[]).slice(-1)[0];
  G.push(r.override ? { id:'revisor', label:'Revisor', st:'ok', val:'seguiu sem nova revisão (motivo no PR)' }
    : last&&last.verdict==='aprova' ? { id:'revisor', label:'Revisor', st:'ok', val:`aprovou na rodada ${last.round}` }
    : last&&last.verdict==='muda' ? { id:'revisor', label:'Revisor', st:'bad', val:`pediu ${last.items.length===1?'1 mudança':last.items.length+' mudanças'} (rodada ${last.round})`, why:'o revisor aprovar' }
    : last ? { id:'revisor', label:'Revisor', st:'wn', val:`veredito ilegível (rodada ${last.round})`, why:'um veredito legível do revisor' }
    : r.has ? { id:'revisor', label:'Revisor', st:'wn', val:'ainda não revisou', why:'a revisão' }
    : { id:'revisor', label:'Revisor', st:'na', val:'sem revisor nesta tarefa' });
  const pr=x.pr||{}, tot=+pr.checksTotal||0, fail=+pr.checksFail||0, pend=+pr.checksPending||0;
  G.push(!tot ? { id:'checks', label:'Checagens do GitHub', st:'na', val:'nenhuma configurada' }
    : fail ? { id:'checks', label:'Checagens do GitHub', st:'bad', val:`${tot-fail-pend} de ${tot}`+((pr.failing||[]).length?` · ${pr.failing.slice(0,2).join(', ')} falhou`:` · ${fail} falhou`), why:'as checagens passarem' }
    : pend ? { id:'checks', label:'Checagens do GitHub', st:'run', val:`${tot-pend} de ${tot} · ${pend} rodando` }
    : { id:'checks', label:'Checagens do GitHub', st:'ok', val:`${tot} de ${tot} passaram` });
  G.push(pr.mergeable==='CONFLICTING' ? { id:'conflito', label:'Conflitos', st:'bad', val:`conflita com a ${pr.base||'base'}`, why:'resolver o conflito' }
    : pr.mergeable==='MERGEABLE' ? { id:'conflito', label:'Conflitos', st:'ok', val:`nenhum com a ${pr.base||'base'}` }
    : { id:'conflito', label:'Conflitos', st:'run', val:'o GitHub ainda está conferindo' });
  return G;
}
const rvGateBlocks=g=>g.st==='bad'||g.st==='wn';
// "Falta: a prova de 1 requisito, você aceitar R3 e as checagens passarem." ('' = nada falta)
function rvMissingText(gates, extra){
  const w=(gates||[]).filter(rvGateBlocks).map(g=>g.why||g.label.toLowerCase()); if(extra) w.push(extra);
  if(!w.length) return '';
  return 'Falta: '+(w.length===1?w[0]:w.slice(0,-1).join(', ')+' e '+w[w.length-1])+'.';
}
// saída de cada portão vermelho (a página do PR liga os data-prvx)
function prvGateExit(g, first){
  if(g.st!=='bad' && g.st!=='wn') return '';
  if(g.id==='prova') return `<button type="button" class="lnk" data-prvx="prova">pedir a prova ao agente</button><button type="button" class="lnk sec" data-prvx="semprova">aprovar sem prova…</button>`;
  if(g.id==='aceite') return `<button type="button" class="lnk" data-prvx="aceite">revisar ${esc(first?'R'+(first.i+1):'')}</button>`;
  if(g.id==='revisor') return g.st==='bad'?`<button type="button" class="lnk" data-prvx="revisor">ver o que ele pediu</button>`:'';
  if(g.id==='checks') return `<button type="button" class="lnk" data-prvx="checks">pedir correção ao agente</button>`;
  if(g.id==='conflito') return `<button type="button" class="lnk" data-prvx="conflito">resolver com IA</button>`;
  return '';
}
// @revpr-puro-fim

// ---------- estado (por tarefa) ----------
const rvSel={};   // taskId → 'r0'…'rN' | 'out' | 'unc'
const rvViewM={}; // taskId → 'req' | 'diff' (o "ver diff completo" mantém o diff de antes)
const rvSt={};    // taskId → { acc:{ reqNorm:{at,sig,noProof?} }, out:{ hunkKey:'keep'|'undo' } } | null (carregando)
const rvUi={};    // taskId → { ask:'r1'|'', draft:'', loose:false, noProof:'' }
const rvLoading={}; // taskId → nº de diffs em voo
function rvViewOf(taskId){ return rvViewM[taskId]==='diff'?'diff':'req'; }
function rvUiOf(id){ return rvUi[id]||(rvUi[id]={ ask:'', draft:'', loose:false }); }
function rvRerender(taskId){ if(typeof fwTask!=='undefined' && fwTask===taskId && (fwMode==='revisao'||fwMode==='pr') && typeof renderWorkspace==='function') renderWorkspace(); }
function rvStEnsure(taskId){
  if(rvSt[taskId]!==undefined) return;
  rvSt[taskId]=null;
  invokeQuiet('review_state_get',{ taskId }).then(j=>{ let v=null; try{ v=j?JSON.parse(j):null; }catch(_){ v=null; }
    rvSt[taskId]={ acc:(v&&v.acc)||{}, out:(v&&v.out)||{} }; })
    .catch(e=>{ rvSt[taskId]={ acc:{}, out:{}, err:String(e&&e.message||e) }; })
    .finally(()=>rvRerender(taskId));
}
async function rvStSave(taskId){
  const s=rvSt[taskId]; if(!s) return false;
  // a leitura falhou: gravar agora apagaria as decisões que estão no banco — recarrega antes
  if(s.err){ toast('suas decisões desta tarefa não carregaram — tentando de novo; faça a decisão outra vez em seguida','warn'); delete rvSt[taskId]; rvStEnsure(taskId); return false; }
  try{ await invoke('review_state_set',{ taskId, json:JSON.stringify({ acc:s.acc, out:s.out }) }); return true; }
  catch(e){ showErr(e, 'Não consegui guardar a sua decisão da revisão'); return false; }
}
// arquivos de CÓDIGO da tarefa (sem anexos/artefatos do Starfork)
const RV_MAX_FILES=400;
function rvCodeFilesAll(){ return (fwFiles||[]).filter(f=>!f.doc && !/^\.cardume\//.test(f.path)); }
function rvCodeFiles(){ return rvCodeFilesAll().slice(0,RV_MAX_FILES); }
// diffs de todos os arquivos (mesmo cache do Código/diff completo: 1 busca por versão do arquivo), 4 em voo
function rvDiffsEnsure(t){
  const want=rvCodeFiles().filter(f=>fwDiffCache[fwDiffKey(t, f.path)]===undefined);
  if(!want.length || rvLoading[t.id]) return;
  rvLoading[t.id]=want.length;
  let i=0; const next=()=>{ if(i>=want.length) return Promise.resolve(); const f=want[i++], key=fwDiffKey(t, f.path); fwDiffCache[key]=null;
    return invoke('file_diff',{ taskId:t.id, path:f.path }).then(d=>{ fwDiffCache[key]=d||''; }).catch(e=>{ fwDiffCache[key]={ err:String(e&&e.message||e) }; }).then(next); };
  Promise.all([next(),next(),next(),next()]).finally(()=>{ delete rvLoading[t.id]; rvRerender(t.id); });
}
// → { files:[{path,hunks}], errs:[path], ready }
// → { files:[{path,hunks}], errs:[path], bin:[path] (mudou mas sem trecho de texto), cut:n (além do limite), ready }
// ready=false enquanto falta diff OU algum falhou OU a lista de arquivos falhou: o aceite não grava assinatura incompleta
function rvDiffsOf(t){
  const files=[], errs=[], bin=[]; let ready=!fwFilesLoading && !fwFilesErr;
  for(const f of rvCodeFiles()){ const d=fwDiffCache[fwDiffKey(t, f.path)];
    if(d==null){ ready=false; continue; }
    if(typeof d==='object'){ errs.push(f.path); ready=false; continue; }
    if(!d.trim()) continue;
    const hs=diffHunks(d).hunks; if(hs.length) files.push({ path:f.path, hunks:hs }); else bin.push(f.path); }
  return { files, errs, bin, cut:Math.max(0, rvCodeFilesAll().length-RV_MAX_FILES), ready };
}
// tudo o que as duas abas precisam, num lugar só
function rvModel(t){
  fwReqProofsEnsure(t.id); rvStEnsure(t.id); rvDiffsEnsure(t);
  const rows=(typeof reqRows==='function')?reqRows(t):[];
  const df=rvDiffsOf(t), map=rvMap(rows, df.files), pinsAll=rvReviewPins(t, df.files);
  const st=rvSt[t.id]||{ acc:{}, out:{} };
  const reqs=rows.map((r,i)=>{ const refs=map.byReq[i], sig=rvSig(refs);
    return { ...r, i, refs, sig, acc:rvAccOf(st.acc[rvNorm(r.text)], sig, df.ready), accEntry:st.acc[rvNorm(r.text)]||null }; });
  return { rows:reqs, map, df, st, pins:pinsAll, loaded:rvSt[t.id]!=null && reqProofCache[t.id]!==undefined };
}
function rvRounds(t){ const sp=t.spec||{}; return Array.isArray(sp.reviewRounds)?sp.reviewRounds:[]; }
function rvReviewPins(t, files){ const last=rvRounds(t).slice(-1)[0]; return last && last.verdict==='muda' ? { ...rvPinItems(last.items||[], files), round:last.round, reviewer:last.reviewer } : { pins:{}, loose:[], round:0 }; }
function rvHasReviewer(t){ return (t.roles||[]).some(r=>r.role==='reviewer'); }

// ---------- REVISÃO por requisito ----------
const RV_IMG=/\.(png|jpe?g|gif|webp)$/i, RV_VID=/\.(mp4|m4v|mov|webm)$/i;
function rvKeyOf(t, m){ let k=rvSel[t.id]; const ok=k==='out'?m.map.out.length:k==='unc'?m.map.unc.length:(k&&m.rows[+k.slice(1)]);
  if(!ok){ const first=m.rows.findIndex(r=>r.acc!=='acc'); k=m.rows.length?('r'+(first>=0?first:0)):(m.map.out.length?'out':'unc'); }
  return k; }
function rvStatusOf(r){ return r.acc==='acc'?'acc':r.st==='ok'&&r.evidence.length?'ok':'no'; }
function rvSmallOf(r){
  if(r.status==='deferred') return 'adiado por decisão sua';
  if(r.acc==='acc') return r.accEntry&&r.accEntry.noProof?'você aceitou sem prova':'você aceitou';
  if(r.acc==='stale') return 'mudou depois do seu aceite';
  if(r.st==='ok'&&r.evidence.length) return 'com prova · falta você aceitar';
  return r.st==='blk'?'sem prova · o agente marcou como travado':'sem prova';
}
function rvListHtml(t, m, sel){
  const n=r=>r.refs.length;
  let h=`<h5 class="rvh">Requisitos</h5>`;
  h+=m.rows.map(r=>{ const s=rvStatusOf(r);
    return `<button type="button" class="rvi${sel==='r'+r.i?' on':''}" data-rvsel="r${r.i}" aria-current="${sel==='r'+r.i?'true':'false'}"><span class="rvck ${s}${r.acc==='stale'?' stale':''}" aria-hidden="true">${s==='acc'?IC.check:''}</span><span class="rvit"><b>R${r.i+1} ${esc(r.text)}</b><small>${esc(rvSmallOf(r))}</small></span><span class="rvn">${m.df.ready||n(r)?nPl(n(r),'trecho'):'…'}</span></button>`; }).join('');
  if(m.map.out.length){ const files=[...new Set(m.map.out.map(x=>x.path.split('/').pop()))];
    h+=`<h5 class="rvh">Fora dos requisitos</h5><button type="button" class="rvi out${sel==='out'?' on':''}" data-rvsel="out"><span class="rvck out" aria-hidden="true"></span><span class="rvit"><b>Mudanças sem requisito</b><small>${esc(files.slice(0,3).join(', ')+(files.length>3?` +${files.length-3}`:''))}</small></span><span class="rvn">${nPl(m.map.out.length,'trecho')}</span></button>`; }
  if(m.map.unc.length) h+=`<h5 class="rvh">Não classificado</h5><button type="button" class="rvi out${sel==='unc'?' on':''}" data-rvsel="unc"><span class="rvck out" aria-hidden="true"></span><span class="rvit"><b>Trechos sem ligação</b><small>o agente não disse de qual requisito são</small></span><span class="rvn">${nPl(m.map.unc.length,'trecho')}</span></button>`;
  if(!m.rows.length && !m.map.out.length && !m.map.unc.length) h+=`<div class="rvempty">${m.df.ready?'esta tarefa não tem requisitos nem mudanças de código':'carregando…'}</div>`;
  return h;
}
function rvHunkCard(t, ref, m, o){
  const f=(m.df.files.find(x=>x.path===ref.path)||{hunks:[]}), h=f.hunks[ref.hi]; if(!h) return '';
  const pins=(m.pins.pins||{})[ref.key]||[];
  const dec=o&&o.out?(m.st.out||{})[ref.key]:'';
  const body=diffViewHtml({ hunks:[h], isNew:true }, { keyPre:t.id+'|'+ref.path+'|rv|' });
  const pinHtml=pins.map((it,j)=>`<div class="rvpin"><span class="rvpin-i" aria-hidden="true">${IC.ai}</span><div><b>Revisor${m.pins.reviewer?' ('+esc(m.pins.reviewer)+')':''}, rodada ${m.pins.round}:</b> ${esc(it)} <button type="button" class="lnk" data-rvpin="${escA(ref.key)}" data-rvpinj="${j}">mandar pro agente</button></div></div>`).join('');
  return `<div class="rvhunk"><div class="rvhh">${fwPathHtml(ref.path)}<span class="rvhn mono"><span class="add">+${ref.add}</span> <span class="del">−${ref.del}</span></span>${ref.how==='estimado'?'<span class="rvtag wn" title="ligado porque o agente citou este arquivo na prova — ele não registrou o mapa">estimado</span>':''}${dec?`<span class="rvtag ${dec==='keep'?'ok':'wn'}">${dec==='keep'?'você manteve':'pedido pra desfazer'}</span>`:''}<span class="rvsp"></span><button type="button" class="lnk" data-rvask="${escA(ref.key)}">perguntar sobre este trecho</button><button type="button" class="lnk" data-rvcode="${escA(ref.key)}">abrir em Código</button></div><div class="fwcode fwdv rvcode">${body}</div>${pinHtml}</div>`;
}
function rvProofHtml(t, r){
  const ev=(r.evidence||[]).map(String);
  const imgs=ev.filter(e=>RV_IMG.test(e)), vids=ev.filter(e=>RV_VID.test(e));
  const T=(r.tests||[]);
  const tests=T.length ? T.map(x=>`<li><span class="rvtag ${x.status==='pass'?'ok':x.status==='fail'?'bad':'wn'}">${x.status==='pass'?'passa':x.status==='fail'?'falhou':'falta'}</span><code>${esc(x.name)}</code></li>`).join('')
    : `<li class="dim">o agente não registrou quais testes cobrem este requisito</li>`;
  const testsBlk=`<div class="rvpt"><b>Testes que cobrem</b><ul class="rvtests">${tests}</ul></div>`;
  if(r.st==='ok' && ev.length){
    const th=imgs.length?artThumb(t.id, imgs[0]):null;
    const shot=imgs.length ? `<button type="button" class="rvshot" data-rvproof="0" aria-label="${escA('abrir a prova '+imgs[0])}">${th?`<img src="${escA(th)}" alt="" loading="lazy">`:`<span class="rvshot-ph">${IC.image}</span>`}</button>`
      : `<button type="button" class="rvshot doc" data-rvproof="0" aria-label="${escA('abrir a prova '+ev[0])}"><span class="rvshot-ph">${vids.length?IC.play:IC.doc}</span></button>`;
    return `<div class="rvprova">${shot}<div class="rvpb"><div class="rvpt"><b>Prova</b><span class="dim">${esc(ev.slice(0,3).join(' · '))}${ev.length>3?` +${ev.length-3}`:''} · <button type="button" class="lnk" data-rvproof="0">abrir</button></span></div>${testsBlk}</div></div>`;
  }
  return `<div class="rvprova noproof"><div class="rvpb"><div class="rvpt"><b class="rvwarn">Sem prova</b><span class="dim">${r.note?'O agente explicou: “'+esc(r.note)+'”. ':''}Peça uma prova: um print da tela, a saída de um teste ou o arquivo gerado.</span></div>${testsBlk}</div></div>`;
}
function rvDetailHtml(t, m, sel){
  const ui=rvUiOf(t.id);
  if(!m.rows.length && !m.map.out.length && !m.map.unc.length) return `<div class="rvr"><p class="rvwhy dim">${m.df.ready?'Nada pra revisar aqui: esta tarefa não tem requisitos nem mudanças de código.':'Lendo as mudanças da tarefa…'}</p></div>`;
  if(sel==='out'||sel==='unc'){
    const list=sel==='out'?m.map.out:m.map.unc;
    const nFiles=new Set(list.map(x=>x.path)).size;
    const dec=m.st.out||{}, kept=list.filter(x=>dec[x.key]==='keep').length, undo=list.filter(x=>dec[x.key]==='undo').length;
    const head=sel==='out'
      ? `<div class="rvmeta"><span class="rvtag wn">fora do pedido</span><span class="rvtag">${nPl(list.length,'trecho')} em ${nPl(nFiles,'arquivo')}</span>${kept?`<span class="rvtag ok">${kept} mantido${kept>1?'s':''}</span>`:''}${undo?`<span class="rvtag wn">${undo} pra desfazer</span>`:''}</div><h3>Mudanças sem requisito</h3><p class="rvwhy">Estes trechos não pertencem a nenhum requisito. Pode ser um ajuste necessário ou escopo que vazou: decida se ficam.</p>`
      : `<div class="rvmeta"><span class="rvtag wn">sem ligação</span><span class="rvtag">${nPl(list.length,'trecho')} em ${nPl(nFiles,'arquivo')}</span></div><h3>Trechos sem ligação com requisito</h3><p class="rvwhy">O agente não registrou quais trechos atendem cada requisito, então não dá pra separar o que foi pedido do que vazou. Peça pra ele registrar (um turno curto) ou revise pelo diff completo.</p>`;
    const foot=sel==='out'
      ? `<div class="rvfoot"><span class="rvfh">${kept===list.length?'Você manteve todos.':undo===list.length?'Você pediu pra desfazer todos.':'Decida o que fica.'}</span><span class="rvsp"></span><button type="button" class="btn" data-rvout="undo">pedir pra desfazer</button><button type="button" class="btn primary" data-rvout="keep">manter, faz sentido</button></div>`
      : `<div class="rvfoot"><span class="rvsp"></span><button type="button" class="btn" data-rvfull>ver diff completo</button><button type="button" class="btn primary" data-rvmapask>pedir ao agente pra registrar</button></div>`;
    return `<div class="rvr">${head}${list.map(x=>rvHunkCard(t, x, m, { out:sel==='out' })).join('')}</div>${foot}`;
  }
  const r=m.rows[+sel.slice(1)]; if(!r) return '<div class="rvr"></div>';
  const nFiles=new Set(r.refs.map(x=>x.path)).size;
  const pinN=r.refs.reduce((s,x)=>s+(((m.pins.pins||{})[x.key]||[]).length),0);
  const proven=r.st==='ok'&&r.evidence.length;
  const did=r.did||r.note;
  const meta=`<div class="rvmeta">${proven?'<span class="rvtag ok">com prova</span>':'<span class="rvtag wn">sem prova</span>'}${m.df.ready||r.refs.length?`<span class="rvtag">${nPl(r.refs.length,'trecho')} em ${nPl(nFiles,'arquivo')}</span>`:'<span class="rvtag">lendo os trechos…</span>'}${pinN?`<span class="rvtag info">${nPl(pinN,'comentário do revisor','comentários do revisor')}</span>`:''}${r.acc==='stale'?'<span class="rvtag wn">mudou depois do seu aceite</span>':''}</div>`;
  const noRefs=!r.refs.length && m.df.ready
    ? `<div class="rvnote">${m.map.explicit?'O agente não ligou nenhum trecho a este requisito.':'Nenhum trecho ligado a este requisito: o agente não registrou o mapa e não citou arquivos na prova.'} <button type="button" class="lnk" data-rvmapask>pedir ao agente pra registrar</button></div>` : '';
  const askBox=ui.ask===sel
    ? `<div class="rvask"><label for="rvAskTx" class="rvfh">O que mudar em R${r.i+1}?</label><textarea id="rvAskTx" class="in" rows="2" data-rvdraft placeholder="ex.: o botão some em aula de hoje que já começou">${esc(ui.draft||'')}</textarea><div class="rvaskb"><button type="button" class="btn sm" data-rvaskx>cancelar</button><button type="button" class="btn primary sm" data-rvasksend>mandar pro agente</button></div></div>` : '';
  const npBox=ui.noProof===sel
    ? `<div class="rvask"><label for="rvNpTx" class="rvfh">Por que aceitar R${r.i+1} sem prova? (fica registrado)</label><textarea id="rvNpTx" class="in" rows="2" data-rvdraft placeholder="ex.: o e-mail só sai em produção; conferi o template">${esc(ui.draft||'')}</textarea><div class="rvaskb"><button type="button" class="btn sm" data-rvaskx>cancelar</button><button type="button" class="btn primary sm" data-rvnpsend>aceitar sem prova</button></div></div>` : '';
  const accd=r.acc==='acc';
  const foot = (ui.ask===sel||ui.noProof===sel) ? '' : !proven && !accd
    ? `<div class="rvfoot"><button type="button" class="btn" data-rvchg>pedir mudança…</button><span class="rvsp"></span><button type="button" class="btn" data-rvnp>aceitar sem prova…</button><button type="button" class="btn primary" data-rvproofask>${IC.ai} pedir a prova ao agente</button></div>`
    : `<div class="rvfoot"><button type="button" class="btn" data-rvchg>pedir mudança neste requisito…</button><span class="rvsp"></span><button type="button" class="btn${accd?'':' primary'}" data-rvacc aria-pressed="${accd}">${accd?IC.check+' aceito · desfazer':r.acc==='stale'?'aceitar de novo':'aceito este requisito'}</button></div>`;
  return `<div class="rvr">${meta}<h3>R${r.i+1} ${esc(r.text)}</h3><p class="rvwhy"><b>O que o agente diz que fez:</b> ${did?esc(did):'<span class="dim">o agente não descreveu</span>'}</p>${rvProofHtml(t, r)}${noRefs}${r.refs.map(x=>rvHunkCard(t, x, m)).join('')}</div>${askBox}${npBox}${foot}`;
}
function rvTopHtml(t, m){
  const live=m.rows.filter(r=>r.status!=='deferred'), n=live.length, acc=live.filter(r=>r.acc==='acc').length;
  const last=rvRounds(t).slice(-1)[0];
  const revTx=last ? (last.verdict==='aprova'?`aprovou (rodada ${last.round})`:last.verdict==='muda'?`pediu ${nPl(last.items.length,'mudança','mudanças')} (rodada ${last.round})`:`veredito ilegível (rodada ${last.round})`)
    : rvHasReviewer(t)?'ainda não revisou':'';
  const loose=(m.pins.loose||[]);
  const parts=[];
  if(n) parts.push(`<span>Você aceitou <b>${acc} de ${n}</b> ${n===1?'requisito':'requisitos'}</span>`);
  if(m.map.out.length) parts.push(`<span><b class="rvwarn">${nPl(m.map.out.length,'trecho')}</b> fora dos requisitos</span>`);
  if(m.map.unc.length) parts.push(`<span><b class="rvwarn">${nPl(m.map.unc.length,'trecho')}</b> sem ligação</span>`);
  if(revTx) parts.push(`<span>Revisor: ${last&&last.verdict==='muda'?`<button type="button" class="lnk rvloose" data-rvloose aria-expanded="${rvUiOf(t.id).loose}"><b>${esc(revTx)}</b></button>`:`<b>${esc(revTx)}</b>`}</span>`);
  if(m.df.errs.length) parts.push(`<span class="rvwarn" title="${escA(m.df.errs.join('\n'))}">não consegui ler ${nPl(m.df.errs.length,'arquivo')} <button type="button" class="lnk" data-rvretry>tentar de novo</button></span>`);
  if(fwFilesErr) parts.push(`<span class="rvwarn" title="${escA(fwFilesErr)}">não consegui listar os arquivos da tarefa</span>`);
  if(m.df.bin.length) parts.push(`<span class="rvwarn" title="${escA(m.df.bin.join('\n'))}">${nPl(m.df.bin.length,'arquivo')} sem trecho de texto (binário ou renomeado) — veja no diff completo</span>`);
  if(m.df.cut) parts.push(`<span class="rvwarn">${nPl(m.df.cut,'arquivo')} além de ${RV_MAX_FILES} ficaram fora desta tela — veja no diff completo</span>`);
  if(m.st.err) parts.push(`<span class="rvwarn" title="${escA(m.st.err)}">suas decisões não carregaram</span>`);
  const looseBox=rvUiOf(t.id).loose && last && last.verdict==='muda'
    ? `<div class="rvlooselist"><b>O que o revisor pediu na rodada ${last.round}</b><ul>${(last.items||[]).map((it,j)=>`<li><span>${esc(it)}</span><button type="button" class="lnk" data-rvitem="${j}">mandar pro agente</button></li>`).join('')}</ul>${loose.length<(last.items||[]).length?'<small class="dim">Os que citam arquivo:linha também aparecem presos ao trecho.</small>':''}</div>` : '';
  return `<div class="rvtop">${parts.join('<span class="rvdot" aria-hidden="true">·</span>')}<span class="rvsp"></span><button type="button" class="btn sm" data-rvfull>ver diff completo</button></div>${looseBox}`;
}
function rvRender(t, main){
  const m=rvModel(t);
  if(!m.loaded && !m.rows.length){ ldPaint(main, skeletonHtml('lista',{ head:true, n:5, inline:true, label:'carregando a revisão' })); return; }
  const sel=rvKeyOf(t, m);
  const html=`<div class="rvroot" data-tk="${escA(t.id)}">${rvTopHtml(t, m)}<div class="rv"><nav class="rvl" aria-label="requisitos">${rvListHtml(t, m, sel)}</nav><section class="rvc" aria-label="requisito selecionado">${rvDetailHtml(t, m, sel)}</section></div></div>`;
  if(main.__rvHtml===html && main.querySelector('.rvroot')) return; // o tick do poll não recria (rolagem, foco, rascunho)
  const ae=document.activeElement, hadFocus=ae&&ae.id&&main.contains(ae)?ae.id:'';
  main.innerHTML=html; main.__rvHtml=html;
  const root=main.querySelector('.rvroot'); root.onclick=e=>rvClick(t.id, e); root.oninput=e=>{ if(e.target.matches('[data-rvdraft]')) rvUiOf(t.id).draft=e.target.value; };
  root.querySelector('.rvl').onkeydown=e=>{ if(e.key!=='ArrowDown'&&e.key!=='ArrowUp') return; const all=[...root.querySelectorAll('[data-rvsel]')]; const i=all.indexOf(document.activeElement); if(i<0) return; e.preventDefault(); const n=all[(i+(e.key==='ArrowDown'?1:-1)+all.length)%all.length]; n.focus(); n.click(); };
  if(hadFocus){ const el=$id(hadFocus); if(el){ el.focus(); if(el.setSelectionRange&&el.value!=null){ const L=el.value.length; try{ el.setSelectionRange(L,L); }catch(_){ } } } }
  else { const ta=root.querySelector('#rvAskTx,#rvNpTx'); if(ta) ta.focus(); }
  fwWireGaps(root);
}
// ref pelo key (o mapa é recalculado a cada clique: barato e sempre o atual)
function rvRefByKey(t, key){ const m=rvModel(t); const all=[...m.map.out, ...m.map.unc, ...m.map.byReq.flat()]; return { m, ref:all.find(x=>x.key===key)||null }; }
function rvRefsTx(refs){ return (refs||[]).map(x=>`${x.path}:${x.a}${x.b>x.a?'-'+x.b:''}`).join(', '); }
async function rvClick(taskId, e){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  const b=e.target.closest('button'); if(!b) return;
  const d=b.dataset, ui=rvUiOf(taskId);
  if(d.rvsel!=null){ if(rvSel[taskId]!==d.rvsel){ rvSel[taskId]=d.rvsel; ui.ask=''; ui.noProof=''; ui.draft=''; } renderWorkspace(); const r=document.querySelector('#fwMain .rvr'); if(r) r.scrollTop=0; const nb=document.querySelector(`#fwMain [data-rvsel="${d.rvsel}"]`); if(nb) nb.focus(); return; }
  if(d.rvfull!=null){ rvViewM[taskId]='diff'; fwRememberTab(); renderWorkspace(); return; }
  if(d.rvloose!=null){ ui.loose=!ui.loose; renderWorkspace(); return; }
  if(d.rvretry!=null){ for(const f of rvCodeFiles()){ const k=fwDiffKey(t, f.path); if(fwDiffCache[k] && typeof fwDiffCache[k]==='object') fwDiffCache[k]=undefined; } renderWorkspace(); return; }
  const m=rvModel(t), sel=rvKeyOf(t, m), r=sel[0]==='r'?m.rows[+sel.slice(1)]:null;
  if(d.rvproof!=null && r){ const ev=(r.evidence||[]).map(String), imgs=ev.filter(x=>RV_IMG.test(x));
    if(imgs.length) lbOpen(t.id, imgs, 0); else if(ev[0]) openArtifact(t.id, ev[0]); return; }
  if(d.rvask!=null || d.rvcode!=null){ const { ref }=rvRefByKey(t, d.rvask||d.rvcode); if(!ref) return;
    fwPath=ref.path; fwSelA=ref.a; fwSelB=ref.b; fwEditing=false;
    if(d.rvcode!=null){ fwMode='codigo'; fwCodeView='diff'; fwRememberTab(); fwLoadFile(); renderWorkspace();
      setTimeout(()=>{ const ln=document.querySelector(`#fwCode [data-ln="${ref.a}"]`); if(ln) ln.scrollIntoView(scrollOpts('center')); }, 350); return; }
    fwMode='conversa'; fwRememberTab(); renderWorkspace();
    const i=(typeof fwInputShow==='function')?fwInputShow():$id('fwInput'); if(i){ i.placeholder=`pergunte sobre ${ref.path.split('/').pop()}:${ref.a}${ref.b>ref.a?'–'+ref.b:''} — vai pro agente com o trecho`; i.focus(); } return; }
  if(d.rvpin!=null){ const { m:mm, ref }=rvRefByKey(t, d.rvpin); const it=((mm.pins.pins||{})[d.rvpin]||[])[+d.rvpinj]; if(!ref||!it) return;
    b.disabled=true; b.textContent='enviando…';
    if(await fwSendText(t.id, `O revisor (rodada ${mm.pins.round}) pediu neste trecho — ${rvRefsTx([ref])}:\n"""\n${it}\n"""\nCorrija, rode os testes e, se os trechos mudarem, atualize o requirements.json (did/code/tests).`)) toast('mandado pro agente','ok');
    else { b.disabled=false; b.textContent='mandar pro agente'; } return; }
  if(d.rvitem!=null){ const last=rvRounds(t).slice(-1)[0]; const it=last&&(last.items||[])[+d.rvitem]; if(!it) return;
    b.disabled=true; b.textContent='enviando…';
    if(await fwSendText(t.id, `O revisor (rodada ${last.round}) pediu:\n"""\n${it}\n"""\nCorrija, rode os testes e, se os trechos mudarem, atualize o requirements.json (did/code/tests).`)) toast('mandado pro agente','ok');
    else { b.disabled=false; b.textContent='mandar pro agente'; } return; }
  if(d.rvmapask!=null){ b.disabled=true;
    const ok=await fwSendText(t.id, 'Registre, para CADA requisito do TASK.yaml, o que você fez e QUAIS TRECHOS mudou por ele: no .cardume/artifacts/requirements.json, campos "did" (1-2 frases), "code" ([{"file":"caminho","lines":"início-fim no arquivo novo"}]) e "tests" ([{"name":"arquivo › caso","status":"pass"|"fail"|"missing"}]) — ou pela tool mcp__cardume__map_requirement. Não mude o status nem a evidência das provas. O que você mudou e não for de nenhum requisito, deixe de fora: vai aparecer pra mim como "fora dos requisitos".');
    if(ok) toast('pedido enviado — a revisão separa os trechos quando ele registrar','ok'); else b.disabled=false; return; }
  if(d.rvout){ const list=m.map.out; if(!list.length || !m.st) return;
    const st=rvSt[taskId]; if(!st){ toast('suas decisões ainda estão carregando — tente de novo em instantes','warn'); return; }
    if(d.rvout==='undo'){
      b.disabled=true; b.textContent='enviando…';
      const ok=await fwSendText(t.id, `Estes trechos não pertencem a nenhum requisito da tarefa e eu NÃO quero que fiquem — desfaça (volte ao que estava na base), rode os testes e atualize o requirements.json:\n${list.map(x=>'- '+rvRefsTx([x])).join('\n')}`);
      if(!ok){ b.disabled=false; b.textContent='pedir pra desfazer'; return; }
      const prev={ ...st.out }; list.forEach(x=>{ st.out[x.key]='undo'; });
      if(await rvStSave(taskId)) toast('pedido enviado ao agente','ok'); else st.out=prev;
    } else { const prev={ ...st.out }; list.forEach(x=>{ st.out[x.key]='keep'; }); if(await rvStSave(taskId)) toast(nPl(list.length,'trecho')+' mantido'+(list.length>1?'s':''),'ok'); else st.out=prev; }
    rvRerender(taskId); return; }
  if(!r) return;
  if(d.rvacc!=null){ const st=rvSt[taskId]; if(!st||!m.df.ready){ toast(st?'ainda lendo os trechos deste requisito — tente de novo em instantes':'suas decisões ainda estão carregando — tente de novo em instantes','warn'); return; }
    const k=rvNorm(r.text);
    if(r.acc==='acc') delete st.acc[k]; else st.acc[k]={ at:Date.now(), sig:r.sig };
    if(!await rvStSave(taskId)){ if(r.accEntry) st.acc[k]=r.accEntry; else delete st.acc[k]; }
    else if(r.acc!=='acc'){ const nx=m.rows.find(x=>x.i>r.i && x.acc!=='acc'); if(nx) rvSel[taskId]='r'+nx.i; }
    rvRerender(taskId); return; }
  if(d.rvproofask!=null){ b.disabled=true;
    const ok=await fwSendText(t.id, proofAskMsg([{ text:r.text, st:r.st, note:r.note }]));
    if(ok) toast('pedido de prova enviado ao agente','ok'); else b.disabled=false; return; }
  if(d.rvchg!=null){ ui.ask=sel; ui.noProof=''; ui.draft=''; renderWorkspace(); return; }
  if(d.rvnp!=null){ ui.noProof=sel; ui.ask=''; ui.draft=''; renderWorkspace(); return; }
  if(d.rvaskx!=null){ ui.ask=''; ui.noProof=''; ui.draft=''; renderWorkspace(); return; }
  if(d.rvasksend!=null){ const tx=String(ui.draft||'').trim(); if(!tx){ const el=$id('rvAskTx'); if(el) el.focus(); toast('escreva o que mudar','warn'); return; }
    b.disabled=true; b.textContent='enviando…';
    const ok=await fwSendText(t.id, `Mudança pedida no requisito "${r.text}":\n${tx}`+(r.refs.length?`\nTrechos deste requisito: ${rvRefsTx(r.refs)}`:'')+'\nDepois rode os testes e atualize a prova e o requirements.json (did/code/tests).');
    if(!ok){ b.disabled=false; b.textContent='mandar pro agente'; return; }
    ui.ask=''; ui.draft=''; const st=rvSt[taskId], k=rvNorm(r.text); if(st && st.acc[k]){ const old=st.acc[k]; delete st.acc[k]; if(!await rvStSave(taskId)) st.acc[k]=old; }
    toast('pedido enviado ao agente','ok'); rvRerender(taskId); return; }
  if(d.rvnpsend!=null){ const why=String(ui.draft||'').trim(); const words=why.split(/\s+/).filter(w=>/[\p{L}\p{N}]{2,}/u.test(w));
    if(words.length<3){ const el=$id('rvNpTx'); if(el) el.focus(); toast('escreva o motivo em uma frase (pelo menos 3 palavras)','warn'); return; }
    const st=rvSt[taskId]; if(!st||!m.df.ready){ toast('ainda carregando — tente de novo em instantes','warn'); return; }
    st.acc[rvNorm(r.text)]={ at:Date.now(), sig:r.sig, noProof:why.slice(0,400) };
    if(await rvStSave(taskId)){ ui.noProof=''; ui.draft=''; toast('aceito sem prova — o motivo fica registrado. No PR, o portão de prova ainda pede "aprovar sem prova…" (vai na descrição)','ok'); } else { if(r.accEntry) st.acc[rvNorm(r.text)]=r.accEntry; else delete st.acc[rvNorm(r.text)]; }
    rvRerender(taskId); return; }
}

// ---------- PR: pronto pra integrar? ----------
function prvGates(t, info){
  const m=rvModel(t), pg=proofGate(t);
  const live=m.rows.filter(r=>r.status!=='deferred'); // adiado por decisão sua (ask_human) não pede aceite
  const n=live.length, done=live.filter(r=>r.acc==='acc').length, stale=live.filter(r=>r.acc==='stale').length;
  const first=live.find(r=>r.acc!=='acc');
  const gates=rvGatesOf({
    proof:{ st:pg.st, n, missing:(pg.missing||[]).length },
    acc:{ n, done, stale, first:first?'R'+(first.i+1):'', loading:rvSt[t.id]==null },
    rev:{ has:rvHasReviewer(t), rounds:rvRounds(t), override:!!((t.spec||{}).reviewOverride&&(t.spec||{}).reviewOverride.reason) },
    pr:{ checksTotal:info.checksTotal, checksFail:info.checksFail, checksPending:info.checksPending, failing:info.failingChecks||[], mergeable:info.mergeable, base:info.baseRefName||'main' },
  });
  return { m, gates, first };
}
// o que bloqueia o merge AGORA ('' = pode). Fonte única: a página do PR e o mergePr usam a mesma regra.
// o que bloqueia além dos 5 portões (conflito e checagens já são portões — não repete)
function prvExtraBlock(info){ if(!info || info.state!=='OPEN') return 'o PR não está aberto'; if(info.isDraft) return 'tirar o PR do rascunho no GitHub'; return ''; }
function prvMergeWhy(t, info){
  if(!t||!info) return '';
  if(info.state!=='OPEN') return prMergeBlock(info);
  return rvMissingText(prvGates(t, info).gates, prvExtraBlock(info));
}
function prvAgoMs(ms){ if(!(ms>0)) return ''; const s=agoShort(ms); return s==='agora'?'agora':s?'há '+s:''; }
function prvAgo(iso){ return prvAgoMs(Date.parse(iso||'')); }
function prvTimeline(t, info){
  const E=[]; // { at, dot, title, sub, extra }
  const prAt=Date.parse(info.createdAt||'')||0;
  E.push({ at:prAt||1, dot:'ok', title:'PR aberto', sub:[prvAgoMs(prAt), `${t.branch} → ${info.baseRefName||'main'}`].filter(Boolean).join(' · ') });
  for(const r of rvRounds(t)) E.push({ at:+r.at||2, dot:r.verdict==='aprova'?'ok':r.verdict==='muda'?'bad':'wn',
    title:`${r.reviewer||'Revisor'} ${r.verdict==='aprova'?'aprovou':r.verdict==='muda'?'pediu '+nPl((r.items||[]).length,'mudança','mudanças'):'deu veredito ilegível'}`,
    sub:[`rodada ${r.round}`, prvAgoMs(+r.at), r.verdict==='muda'?(r.items||[]).slice(0,1).join(''):''].filter(Boolean).join(' · ') });
  const ign=prIgnSet(t.id), showDone=lsGet('prShowDone')==='1';
  let doneN=0;
  for(const x of prRevList(info)){ const open=prRevOpen(info,x,ign); if(!open){ doneN++; if(!showDone) continue; }
    E.push({ at:Date.parse(x.r.submittedAt||'')||3, dot:open?'cm':'', title:`${x.r.author} ${x.r.state==='APPROVED'?'aprovou':x.r.state==='CHANGES_REQUESTED'?'pediu mudanças':'comentou'} no GitHub`, sub:prvAgo(x.r.submittedAt),
      cm:{ body:x.r.body, open, acts:open?`<button type="button" class="lnk" data-prfixrev="${escA(x.key)}" data-prtask="${escA(t.id)}">corrigir com o agente</button><button type="button" class="lnk sec" data-prign="${escA(x.key)}">ignorar</button>${x.r.url?`<button type="button" class="lnk sec" data-prgh="${escA(x.r.url)}">responder no GitHub</button>`:''}`:'' } }); }
  for(const c of prRoots(info)){ const done=prCmtDone(c, ign); if(done){ doneN++; if(!showDone) continue; }
    E.push({ at:Date.parse(c.createdAt||'')||3, dot:done?'':'cm', title:`${c.author} comentou no GitHub${c.path?` · ${c.path}${c.line?':'+c.line:''}`:''}`, sub:[prvAgo(c.createdAt), c.resolved?'resolvido':c.answered?'respondido':c.outdated?'desatualizado':done?'ignorado':''].filter(Boolean).join(' · '),
      cm:{ body:c.body, open:!done, acts:!done?`<button type="button" class="lnk" data-prfix="${escA(prCmtKey(c))}">corrigir com o agente</button>${c.threadId?`<button type="button" class="lnk sec" data-prresolve="${escA(c.threadId)}" data-prtask="${escA(t.id)}">resolver</button>`:''}<button type="button" class="lnk sec" data-prign="${escA(prCmtKey(c))}">ignorar</button>${c.url?`<button type="button" class="lnk sec" data-prgh="${escA(c.url)}">responder no GitHub</button>`:''}`:'' } }); }
  const tot=info.checksTotal||0, fail=info.checksFail||0, pend=info.checksPending||0;
  if(tot) E.push({ at:Number.MAX_SAFE_INTEGER, dot:fail?'bad':pend?'wn':'ok', title:'Checagens do GitHub', sub:fail?`${fail} falhou${(info.failingChecks||[]).length?': '+info.failingChecks.join(', '):''}`:pend?`${pend} rodando`:`${tot} de ${tot} passaram` });
  E.sort((a,b)=>a.at-b.at);
  const html=E.map(e=>`<li><span class="prvd ${e.dot}" aria-hidden="true"></span><div><b>${esc(e.title)}</b>${e.sub?`<small>${esc(e.sub)}</small>`:''}${e.cm?`<div class="prvcm${e.cm.open?'':' done'}">${String(e.cm.body||'').length>600?`<div class="prcmt-b clamp">${chatMd(String(e.cm.body||'').slice(0,4000))}</div><button type="button" class="lnk sec" data-prmore>ver mais</button>`:`<div class="prcmt-b">${chatMd(String(e.cm.body||''))}</div>`}${e.cm.acts?`<div class="prvacts">${e.cm.acts}</div>`:''}</div>`:''}</div></li>`).join('');
  const toggle=doneN?`<button type="button" class="lnk" data-prshowdone data-prtask="${escA(t.id)}">${showDone?'ocultar resolvidos':`mostrar resolvidos (${doneN})`}</button>`:'';
  return { html, toggle };
}
function prvRender(t, main, info){
  const { m, gates, first }=prvGates(t, info);
  const open=info.state==='OPEN';
  const extra=open?prvExtraBlock(info):'';
  const why=open?rvMissingText(gates, extra):'';
  const openCm=prvOpenComments(t, info).length;
  const fixable=openCm>0 || gates.some(g=>g.st==='bad' && ['prova','revisor','checks','conflito'].includes(g.id));
  const gHtml=gates.map(g=>`<div class="prvg ${g.st}"><span class="prvst">${g.st==='ok'?'ok':g.st==='bad'?'falhou':g.st==='wn'?'falta':g.st==='run'?'andando':'não se aplica'}</span><b>${esc(g.label)}</b><small>${esc(g.val)}</small>${prvGateExit(g, first)}</div>`).join('');
  const head=info.state==='MERGED'?'Integrado na '+esc(info.baseRefName||'main'):info.state==='CLOSED'?'PR fechado sem integrar':'Pronto pra integrar?';
  const bar=open?`<div class="prvbar"><button type="button" class="btn primary prvmerge" id="prvMerge"${why?` disabled aria-describedby="prvWhy"`:''}>${IC.merge} Integrar na ${esc(info.baseRefName||'main')}</button>${why?`<span class="prvwhy" id="prvWhy">${esc(why)}</span>${fixable?'<button type="button" class="btn" id="prvFixAll">'+IC.ai+' corrigir tudo com o agente</button>':''}`:'<span class="prvwhy">Integra com squash e apaga a branch remota.</span>'}<span class="rvsp"></span><button type="button" class="btn sm" id="prPgOpen">${IC.extlink} abrir no GitHub</button><button type="button" class="btn sm" id="prPgCopy">copiar link</button><button type="button" class="btn sm" id="prPgRefresh">atualizar</button></div>`
    : `<div class="prvbar"><span class="rvsp"></span><button type="button" class="btn sm" id="prPgOpen">${IC.extlink} abrir no GitHub</button><button type="button" class="btn sm" id="prPgRefresh">atualizar</button></div>`;
  const d=diffOf(t.id)||{};
  const files=rvCodeFiles(), addN=files.reduce((s,f)=>s+(+f.add||0),0)||(+d.additions||0), delN=files.reduce((s,f)=>s+(+f.del||0),0)||(+d.deletions||0);
  const start=taskTs(t), prAt=Date.parse(info.createdAt||'')||0;
  const facts=`<div class="prvfacts"><div><b>${m.rows.length}</b><small>${m.rows.length===1?'requisito':'requisitos'}</small></div><div><b>${files.length||diffFiles(d)}</b><small>arquivos · +${addN} −${delN}</small></div><div><b>${esc(fmtCost(taskCost(t.id).usd,{ usdOnly:true }))}</b><small>custo total</small></div><div><b>${start&&prAt&&prAt>start?esc(fmtDurMs(prAt-start)):'—'}</b><small>do pedido ao PR</small></div></div>`;
  const rlist=m.rows.length?`<ul class="prvreqs">${m.rows.map(r=>{ const proven=r.st==='ok'&&r.evidence.length; return `<li><span class="prvrq ${proven?'ok':'no'}${r.acc==='acc'?' acc':''}" aria-hidden="true">${r.acc==='acc'?IC.check:''}</span><span>R${r.i+1} ${esc(r.text)}</span><em>${proven?esc(String(r.evidence[0])):'sem prova'}</em></li>`; }).join('')}</ul>`:'';
  const kept=m.map.out.filter(x=>(m.st.out||{})[x.key]==='keep').length;
  const outLine=m.map.out.length?`<p class="prvout">${nPl(m.map.out.length,'trecho')} fora dos requisitos${kept?` · ${kept} mantido${kept>1?'s':''} por você`:' · você ainda não decidiu'} <button type="button" class="lnk" data-prvx="fora">ver</button></p>`:'';
  const rep=(typeof cicloReportFor==='function')?cicloReportFor(t).trim():'';
  const tl=prvTimeline(t, info);
  const html=`<div class="prv" data-tk="${escA(t.id)}">
    <div class="prvready">
      <div class="prvtop"><span class="prvnum mono">#${info.number}</span><h3>${head}</h3><span class="prvbr mono">${esc(t.branch)} → ${esc(info.baseRefName||'main')}</span>${prStateBadge(info)}<span class="rvsp"></span><span class="dim prvage" id="prAge"></span>${info.staleErr?'<span class="rvwarn prvage">sem conexão com o GitHub agora</span>':''}</div>
      ${open?`<div class="prvgates">${gHtml}</div>`:''}
      ${bar}
    </div>
    <div class="prvcols">
      <div><h5 class="rvh">O que entra</h5>${facts}${rlist}${outLine}
        ${rep?`<h5 class="rvh">Relatório Starfork <span class="dim">(vai no corpo do PR)</span></h5><div class="prvrep">${mdToHtml(rep.replace(/^## Relatório Starfork\s*/,''))}</div>`:''}
        ${info.body?`<details class="prvbody"${prvBodyOpen[t.id]?' open':''}><summary>descrição do PR no GitHub</summary><div class="prbody">${chatMd(info.body)}</div></details>`:''}
      </div>
      <div><div class="prvtlh"><h5 class="rvh">Linha do tempo</h5>${tl.toggle}</div><ol class="prvtl">${tl.html}</ol></div>
    </div>
  </div>`;
  // o poll repinta a cada poucos segundos: com o mesmo HTML não recria (rolagem, foco, descrição aberta ficam)
  const age=()=>{ const a=$id('prAge'); if(a) a.textContent=prAgoTx(info._at); };
  if(main.__prvHtml===html && main.querySelector('.prv')){ age(); return; }
  main.innerHTML=html; main.__prvHtml=html; age();
  { const dt=main.querySelector('.prvbody'); if(dt) dt.ontoggle=()=>{ prvBodyOpen[t.id]=dt.open; }; }
  bindClick('prPgOpen', ()=>openExternal(info.url));
  bindClick('prPgCopy', (e)=>copyLink(info.url, e.currentTarget));
  bindClick('prPgRefresh', async(e)=>{ const b=e.currentTarget; b.disabled=true; b.textContent='atualizando…'; await loadPr(t.id,true); renderWorkspace(); });
  bindClick('prvMerge', async(e)=>{ e.currentTarget.disabled=true; if(await mergePr(t.id)) renderWorkspace(); else { const b=$id('prvMerge'); if(b) b.disabled=!!prvMergeWhy(t, prCache[t.id]); } });
  bindClick('prvFixAll', (e)=>prvFixAll(t, info, e.currentTarget));
  const root=main.querySelector('.prv');
  root.querySelectorAll('[data-prvx]').forEach(b=>b.onclick=async()=>{ const k=b.dataset.prvx;
    if(k==='prova'){ await proofAsk(t, b); return; }
    if(k==='semprova'){ if(await proofOverride(t)) renderWorkspace(); return; }
    if(k==='aceite'||k==='revisor'||k==='fora'){ if(k==='aceite' && first) rvSel[t.id]='r'+first.i; if(k==='fora') rvSel[t.id]='out'; if(k==='revisor') rvUiOf(t.id).loose=true; rvViewM[t.id]='req'; fwMode='revisao'; fwRememberTab(); renderWorkspace(); return; }
    if(k==='conflito'){ await fwResolveConflict(t.id, b); return; }
    if(k==='checks'){ b.disabled=true; b.textContent='enviando…'; const ok=await fwSendText(t.id, prvChecksMsg(info)); if(ok){ toast('pedido enviado ao agente','ok'); } else { b.disabled=false; b.textContent='pedir correção ao agente'; } } });
  root.querySelectorAll('[data-prfix]').forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent='enviando…'; let ok=false; try{ ok=await prFixOne(t.id, b.dataset.prfix); }finally{ if(ok) toast('pedido enviado ao agente','ok'); renderWorkspace(); } });
  root.querySelectorAll('[data-prign]').forEach(b=>b.onclick=()=>{ prIgnAdd(t.id,b.dataset.prign); renderWorkspace(); });
}
const prvBodyOpen={}; // taskId → descrição do PR aberta
// comentários/reviews do GitHub ainda em aberto (mesma régua da linha do tempo)
function prvOpenComments(t, info){
  const ign=prIgnSet(t.id);
  return [...prRevList(info).filter(x=>prRevOpen(info,x,ign)).map(x=>({ who:x.r.author, where:'review', body:x.r.body })),
    ...prRoots(info).filter(c=>!prCmtDone(c,ign)).map(c=>({ who:c.author, where:c.path?`${c.path}${c.line?':'+c.line:''}`:'conversa do PR', body:c.body }))];
}
function prvChecksMsg(info){
  const failing=Array.isArray(info.failingChecks)?info.failingChecks.filter(Boolean):[];
  return `As checagens do PR #${info.number} estão falhando no GitHub${failing.length?` (${failing.join(', ')})`:''}. Veja o log de cada uma (gh pr checks ${info.number} / gh run view --log-failed), corrija a causa na branch, rode os testes localmente e faça commit + push.`;
}
// "corrigir tudo com o agente": UMA mensagem com tudo o que o agente consegue resolver (o aceite é seu, não entra)
async function prvFixAll(t, info, btn){
  const { gates }=prvGates(t, info);
  const parts=[];
  const pg=proofGate(t);
  if(gates.find(g=>g.id==='prova'&&g.st==='bad') && pg.missing.length) parts.push(proofAskMsg(pg.missing));
  const last=rvRounds(t).slice(-1)[0];
  if(gates.find(g=>g.id==='revisor'&&g.st==='bad') && last) parts.push(`O revisor pediu na rodada ${last.round}:\n${(last.items||[]).map(x=>'- '+x).join('\n')}`);
  if(gates.find(g=>g.id==='checks'&&g.st==='bad')) parts.push(prvChecksMsg(info));
  if(gates.find(g=>g.id==='conflito'&&g.st==='bad')) parts.push(`A branch conflita com a ${info.baseRefName||'main'}: traga a base (git fetch + merge de origin/${info.baseRefName||'main'}), resolva os conflitos mantendo o que cada lado quis, rode os testes e faça commit + push.`);
  const cms=prvOpenComments(t, info);
  if(cms.length) parts.push(`Comentários em aberto no PR #${info.number} (responda cada um no GitHub começando com "✔" e dizendo o que mudou):\n${cms.map(c=>`- ${c.who} (${c.where}): ${String(c.body||'').replace(/\s+/g,' ').slice(0,400)}`).join('\n')}`);
  if(!parts.length){ toast('nada aqui que o agente consiga corrigir sozinho — o que falta é com você','info'); return; }
  if(btn){ btn.disabled=true; btn.textContent='enviando…'; }
  const ok=await fwSendText(t.id, 'Pra integrar o PR, resolva tudo isto, em ordem, e me avise:\n\n'+parts.map((p,i)=>`${i+1}) ${p}`).join('\n\n'));
  if(ok){ toast('pedido enviado ao agente','ok'); fwMode='conversa'; fwRememberTab(); renderWorkspace(); }
  else if(btn && btn.isConnected){ btn.disabled=false; btn.innerHTML=IC.ai+' corrigir tudo com o agente'; }
}
