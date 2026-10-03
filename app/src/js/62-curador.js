// Starfork — 62-curador
// CURADOR SEM IA (F4 · P13 da decisão da mesa de 03/10/2026) — o "Curar e voltar" do ciclo Hermes.
//  - "sem uso": aprendizado aceito há ≥ 30 dias que não entrou em NENHUMA tarefa nos últimos 30 dias. O uso vem do evento
//    `papel` (P10) que o motor grava no início de cada papel ("skills ativas: a@v3, b@v1 · nyx@v4 · codex"): skill = o nome
//    na lista; nota de agente = o agente dono rodou algum papel. Projeto parado (nenhum papel na janela) = nada a sugerir.
//  - "parecido": mesmo dono e mesmo tipo, Jaccard ≥ 0,8 dos tokens normalizados (sem acento, minúsculo, sem palavra vazia).
//  - roda AO ABRIR a Memória ou a ficha do agente, no máximo 1×/dia (resultado guardado em .cardume/aprendizado/curador.json);
//    sem timer, sem laço. Ele PROPÕE; o humano confirma. Arquivar move pro histórico (nunca apaga) e tem "restaurar".

// @curador-puro-inicio (testado em app/tests/agentes-f4.test.mjs — sem DOM nem estado global)
const CUR_DAYS=30, CUR_SIM=0.8, CUR_DAY_MS=86400000, CUR_MAX_PAIRS=20, CUR_DISMISS_DAYS=90; // "deixar como está" vale 90 dias
const CUR_STOP=new Set(('a o as os um uma uns umas de da do das dos em no na nos nas por pra para pelo pela com sem e ou que se '+
  'ao aos sua seu suas seus isso este esta esse essa nao sim mais menos muito ja so tambem quando como sempre nunca ser ter '+
  'the an of to in on for and or is are be with it this that at by from as').split(' '));
function curKey(id){ return String(id==null?'':id).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60); }
// tokens normalizados: sem acento, minúsculo, só letras/números, ≥ 2 letras, sem palavra vazia → Set
function curTokens(t){
  const out=new Set();
  for(const w of String(t==null?'':t).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/[^a-z0-9]+/)) if(w.length>=2 && !CUR_STOP.has(w)) out.add(w);
  return out;
}
// Jaccard de dois Sets; conjunto vazio nunca casa (0)
function curJaccard(a, b){
  if(!a||!b||!a.size||!b.size) return 0;
  let i=0; for(const x of a) if(b.has(x)) i++;
  return i/(a.size+b.size-i);
}
// nomes das skills na lista "skills ativas: a@v3, b@v1 · …" (só o 1º trecho; "nenhuma" = [])
function curRosterSkills(text){
  const m=/^skills ativas:\s*(.*)$/.exec(String(text==null?'':text).split(' · ')[0].trim()); if(!m) return [];
  return m[1].split(',').map(s=>/^(.+)@v\d+$/.exec(s.trim())).filter(Boolean).map(x=>x[1].trim());
}
function curSugId(s){ return s.type==='arquivar' ? ['arquivar', s.kind, s.owner||'', s.key].join(':') : ['juntar', s.kind, s.owner||'', ...[s.a.key, s.b.key].sort()].join(':'); }
/** "Sem uso" (puro): itens aceitos há ≥ days dias que não aparecem em nenhum `papel` desde now − days. */
function curUnused(items, usage, now, days){
  days=days||CUR_DAYS; const since=now-days*CUR_DAY_MS;
  const recent=(usage||[]).filter(u=>u && +u.ts>=since);
  if(!recent.length) return []; // projeto parado: "sem uso" não diz nada
  const used=new Set(), ran=new Set();
  for(const u of recent){ for(const n of curRosterSkills(u.text)) used.add(n); if(u.agentId) ran.add(curKey(u.agentId)); }
  return (items||[]).filter(it=>it && +it.at>0 && +it.at<=since && (it.kind==='skill' ? !used.has(it.key) : !ran.has(curKey(it.owner))))
    .map(it=>({ type:'arquivar', kind:it.kind, key:String(it.key), owner:curKey(it.owner), title:it.title||String(it.key), days }));
}
/** Pares parecidos (puro): mesmo tipo e mesmo dono, Jaccard ≥ sim. Mais parecidos primeiro, no máximo CUR_MAX_PAIRS. */
function curPairs(items, sim){
  sim=sim==null?CUR_SIM:sim;
  const list=(items||[]).filter(Boolean).map(it=>({ it, tk:curTokens(it.text!=null?it.text:it.title) })).filter(x=>x.tk.size);
  const out=[];
  for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
    const A=list[i].it, B=list[j].it;
    if(A.kind!==B.kind || curKey(A.owner)!==curKey(B.owner) || String(A.key)===String(B.key)) continue;
    const s=curJaccard(list[i].tk, list[j].tk);
    if(s>=sim) out.push({ type:'juntar', kind:A.kind, owner:curKey(A.owner), sim:Math.round(s*100)/100,
      a:{ key:String(A.key), title:A.title||String(A.key) }, b:{ key:String(B.key), title:B.title||String(B.key) } });
  }
  return out.sort((x,y)=>y.sim-x.sim || curSugId(x).localeCompare(curSugId(y))).slice(0, CUR_MAX_PAIRS);
}
// dispensas ainda valendo (puro): [{ id, at }] com menos de CUR_DISMISS_DAYS dias — depois disso a sugestão pode voltar
function curDismissed(list, now){ return (Array.isArray(list)?list:[]).filter(d=>d && d.id && +d.at>0 && now-(+d.at)<CUR_DISMISS_DAYS*CUR_DAY_MS); }
/** Uma rodada do curador (puro): input = saída do `curator_inputs` (now, items, usage); o = { dismissed:[{id,at}], days, sim }. */
function curSuggest(input, o){
  o=o||{}; input=input||{};
  const gone=new Set(curDismissed(o.dismissed, +input.now||0).map(d=>d.id));
  return [...curUnused(input.items, input.usage, +input.now||0, o.days), ...curPairs(input.items, o.sim)]
    .map(s=>Object.assign(s, { id:curSugId(s) })).filter(s=>!gone.has(s.id));
}
// venceu? (sem rodada, rodada de ≥ 24 h, ou relógio que voltou)
function curDue(st, now){ const at=+(st&&st.at)||0; return !(at>0) || now-at>=CUR_DAY_MS || at>now+60000; }
// o que sobra depois de agir num item: sai toda sugestão que cita a chave
function curDrop(sugs, kind, key, owner){
  const k=String(key), o=curKey(owner);
  return (sugs||[]).filter(s=>!(s.kind===kind && (s.owner||'')===o && (s.type==='arquivar' ? s.key===k : (s.a.key===k||s.b.key===k))));
}
// "2 skills sem uso há 30 dias · 1 par parecido — revisar?"
function curSummary(sugs){
  const sk=sugs.filter(s=>s.type==='arquivar'&&s.kind==='skill').length, nt=sugs.filter(s=>s.type==='arquivar'&&s.kind!=='skill').length, pr=sugs.filter(s=>s.type==='juntar').length;
  const days=(sugs.find(s=>s.days)||{}).days||CUR_DAYS;
  const parts=[];
  if(sk) parts.push(sk+(sk===1?' skill sem uso':' skills sem uso')+' há '+days+' dias');
  if(nt) parts.push(nt+(nt===1?' nota sem uso':' notas sem uso')+' há '+days+' dias');
  if(pr) parts.push(pr+(pr===1?' par parecido':' pares parecidos'));
  return parts.length?parts.join(' · ')+' — revisar?':'';
}
function curLabel(kind, key, title){ return kind==='skill' ? String(title||key).replace(/-/g,' ') : String(title||key); }
// a frase do cartão (sem jargão; skill = "um jeito de fazer")
function curSentence(s, who){
  if(s.type==='arquivar'){
    const what=(s.kind==='skill'?'o jeito de fazer «':'«')+curLabel(s.kind, s.key, s.title)+'»';
    return (who?who+': ':'')+what+' não entrou em nenhuma tarefa nos últimos '+s.days+' dias.';
  }
  return (who?who+': ':'')+'«'+curLabel(s.kind, s.a.key, s.a.title)+'» e «'+curLabel(s.kind, s.b.key, s.b.title)+'» dizem quase a mesma coisa.';
}
// @curador-puro-fim

// ---------------------------------------------------------------- estado + render (Memória e ficha usam o MESMO)
const CUR={ repo:'', data:null, archived:[], err:'', busy:false };
function curEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// roda AO ABRIR (Memória/ficha): lê o guardado; só faz rodada nova se venceu (≥ 24 h). Sem timer, sem laço.
// Duas telas abrindo juntas reaproveitam a MESMA leitura (nunca duas rodadas nem duas gravações).
let curInflight=null;
function curLoad(repo){
  repo=repo||state.repo||''; if(!repo) return Promise.resolve();
  if(curInflight && curInflight.repo===repo) return curInflight.p;
  const p=curLoadNow(repo).finally(()=>{ if(curInflight&&curInflight.p===p) curInflight=null; });
  curInflight={ repo, p }; return p;
}
async function curLoadNow(repo){
  if(CUR.repo!==repo){ CUR.repo=repo; CUR.data=null; CUR.archived=[]; }
  CUR.err='';
  try{
    const st=await invoke('curator_state',{ repo });
    if(CUR.repo!==repo) return;
    if(curDue(st, Date.now())){
      const inp=await invoke('curator_inputs',{ repo })||{};
      if(CUR.repo!==repo) return;
      const now=+inp.now||Date.now();
      const dismissed=curDismissed(st&&st.dismissed, now); // as vencidas saem do arquivo
      const data={ at:now, suggestions:curSuggest(inp, { dismissed }), dismissed };
      CUR.data=data; CUR.archived=inp.archived||[];
      await curSaveData(repo); // melhor-esforço: falhar ao guardar não vira "não consegui revisar"
    } else {
      CUR.data=st;
      CUR.archived=await invoke('curator_archived',{ repo })||[];
    }
  }catch(e){ CUR.err=(typeof errShort==='function')?errShort(e):String((e&&e.message)||e); }
}
function curAgentName(id){
  const a=((typeof state!=='undefined'&&state.config&&state.config.agents)||[]).find(x=>x&&x.id===id);
  return a?(a.name||id):(id||'');
}
function curCard(s, o){
  const who=o.owner?'':(s.owner?curAgentName(s.owner):'');
  const id=curEsc(s.id);
  const btns=s.type==='arquivar'
    ? `<button class="btn sm primary" data-curarch="${id}">Arquivar</button><button class="btn sm" data-curkeep="${id}">Deixar como está</button>`
    : `<button class="btn sm" data-curmerge="${id}" data-keep="a">Ficar com «${curEsc(curLabel(s.kind, s.a.key, s.a.title))}»</button><button class="btn sm" data-curmerge="${id}" data-keep="b">Ficar com «${curEsc(curLabel(s.kind, s.b.key, s.b.title))}»</button><button class="btn sm" data-curkeep="${id}">Deixar as duas</button>`;
  const det=s.type==='arquivar'
    ? `${s.kind==='skill'?'skill':'nota'} <code>${curEsc(s.key)}</code>${s.owner?' · dono: '+curEsc(s.owner):' · do projeto'} · nenhuma lista "skills ativas" dos últimos ${s.days} dias cita ${s.kind==='skill'?'ela':'o dono rodando'}. Arquivar move pro histórico — dá pra restaurar.`
    : `${s.kind==='skill'?'skills':'notas'} <code>${curEsc(s.a.key)}</code> e <code>${curEsc(s.b.key)}</code> · ${Math.round(s.sim*100)}% das palavras em comum (Jaccard ${String(s.sim).replace('.',',')}). Ficar com uma arquiva a outra — nada é reescrito, e dá pra restaurar.`;
  return `<li class="curcard" data-curid="${id}"><p class="cursent">${curEsc(curSentence(s, who))}</p><div class="curbtns">${btns}</div><details class="curdet"><summary>ver detalhes</summary><p>${det}</p></details></li>`;
}
/** Seção do curador. owner = id do agente (ficha) ou null (Memória: tudo). o = { name } */
function curHtml(owner, o){
  o=o||{};
  const all=(CUR.data&&CUR.data.suggestions)||[];
  const sugs=owner?all.filter(s=>s.owner===curKey(owner)):all;
  const arq=owner?[]:(CUR.archived||[]); // na ficha, o que ele esqueceu/arquivou fica em "esquecidas" (com restaurar)
  if(!sugs.length && !arq.length && !CUR.err) return '';
  const head=sugs.length?`<details class="cursec" open><summary><span class="curtitle">Arrumar a memória</span> <span class="cursum">${curEsc(curSummary(sugs))}</span></summary>
    <p class="dim curlead">Sugestões sem IA, revistas no máximo uma vez por dia. Nada muda sem o seu sim, e nada é apagado.</p>
    <ul class="curlist">${sugs.map(s=>curCard(s, { owner })).join('')}</ul></details>`:'';
  const err=CUR.err?`<p class="agf-err">Não consegui revisar a memória agora — ${curEsc(CUR.err)}</p>`:'';
  const gone=arq.length?`<details class="curgone"><summary>arquivados (${arq.length})</summary><ul>${arq.map(x=>`<li><span>${curEsc(x.kind==='skill'?'um jeito de fazer: '+curLabel('skill', x.key):x.title||x.key)}</span>${x.owner?` <span class="dim">· ${curEsc(curAgentName(x.owner))}</span>`:''}${x.reason?` <span class="dim">— ${curEsc(x.reason)}</span>`:''} <button class="btn sm" data-currestore="${curEsc(x.kind)}" data-key="${curEsc(x.key)}" data-owner="${curEsc(x.owner||'')}">restaurar</button></li>`).join('')}</ul></details>`:'';
  return `<section class="curwrap" aria-label="Arrumar a memória">${err}${head}${gone}</section>`;
}
// guardar o dia é melhor-esforço; nunca grava uma rodada sem data (senão a próxima abertura relê o banco à toa)
async function curSaveData(repo){ if(!CUR.data || !(+CUR.data.at>0)) return; try{ await invoke('curator_save',{ repo, data:CUR.data }); }catch(_){ } }
// o item sumiu de verdade (já arquivado/esquecido/trocou de dono)? só aí a sugestão sai; erro passageiro mantém o cartão
function curGoneErr(e){ return /não está mais ativa|não lembra mais|não é desse agente|só dá pra arquivar|tipo de aprendizado/.test(String((e&&e.message)||e)); }
// ctx: { repo(), after() } — after relê o que a tela mostra (Memória ou ficha)
function curWire(root, ctx){
  if(!CUR.data) CUR.data={ at:0, suggestions:[], dismissed:[] };
  const find=id=>(CUR.data.suggestions||[]).find(s=>s.id===id);
  const run=async(btn, fn)=>{ if(CUR.busy) return; CUR.busy=true; const card=btn.closest&&btn.closest('.curcard'); if(card) card.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{ await fn(); }finally{ CUR.busy=false; if(card&&card.isConnected) card.querySelectorAll('button').forEach(b=>b.disabled=false); } };
  const archive=async(repo, kind, key, owner, reason)=>{
    await invoke('curator_archive',{ repo, kind, key, owner:owner||'', reason });
    CUR.data.suggestions=curDrop(CUR.data.suggestions, kind, key, owner);
    await curSaveData(repo);
    try{ CUR.archived=await invoke('curator_archived',{ repo })||[]; }catch(_){ }
  };
  const restoreTo=(repo, kind, key, owner)=>async()=>{ try{ await invoke('curator_restore',{ repo, kind, key, owner:owner||'' }); try{ CUR.archived=await invoke('curator_archived',{ repo })||[]; }catch(_){ } toast('Restaurado — voltou exatamente como era.','ok'); await ctx.after(); }catch(e){ showErr(e, 'Não consegui restaurar'); } };
  root.querySelectorAll('[data-curarch]').forEach(b=>b.onclick=()=>run(b, async()=>{
    const s=find(b.dataset.curarch); if(!s) return; const repo=ctx.repo();
    if(!await askYes('Arquivar '+(s.kind==='skill'?'o jeito de fazer «':'«')+curLabel(s.kind, s.key, s.title)+'»?\n\nSai das próximas tarefas. Nada é apagado: fica em "arquivados" e dá pra restaurar.')) return;
    try{ await archive(repo, s.kind, s.key, s.owner, 'sem uso há '+s.days+' dias (curador)'); toast('Arquivado — fica no histórico.','ok', { label:'restaurar', fn:restoreTo(repo, s.kind, s.key, s.owner) }); await ctx.after(); }
    catch(e){ if(curGoneErr(e)){ CUR.data.suggestions=curDrop(CUR.data.suggestions, s.kind, s.key, s.owner); await curSaveData(repo); } showErr(e, 'Não consegui arquivar'); await ctx.after(); }
  }));
  root.querySelectorAll('[data-curmerge]').forEach(b=>b.onclick=()=>run(b, async()=>{
    const s=find(b.dataset.curmerge); if(!s) return; const repo=ctx.repo();
    const keep=b.dataset.keep==='b'?s.b:s.a, drop=b.dataset.keep==='b'?s.a:s.b;
    if(!await askYes('Ficar só com «'+curLabel(s.kind, keep.key, keep.title)+'»?\n\n«'+curLabel(s.kind, drop.key, drop.title)+'» vai pro arquivo (nada é reescrito nem apagado; dá pra restaurar).')) return;
    try{ await archive(repo, s.kind, drop.key, s.owner, 'parecida com «'+curLabel(s.kind, keep.key, keep.title)+'» (curador)'); toast('Pronto — ficou só «'+curLabel(s.kind, keep.key, keep.title)+'».','ok', { label:'restaurar a outra', fn:restoreTo(repo, s.kind, drop.key, s.owner) }); await ctx.after(); }
    catch(e){ if(curGoneErr(e)){ CUR.data.suggestions=curDrop(CUR.data.suggestions, s.kind, drop.key, s.owner); await curSaveData(repo); } showErr(e, 'Não consegui arquivar'); await ctx.after(); }
  }));
  root.querySelectorAll('[data-curkeep]').forEach(b=>b.onclick=()=>run(b, async()=>{
    const id=b.dataset.curkeep, repo=ctx.repo(); if(!CUR.data) return;
    CUR.data.dismissed=[...(CUR.data.dismissed||[]).filter(d=>d&&d.id!==id), { id, at:Date.now() }];
    CUR.data.suggestions=(CUR.data.suggestions||[]).filter(s=>s.id!==id);
    await curSaveData(repo); await ctx.after();
  }));
  root.querySelectorAll('[data-currestore]').forEach(b=>b.onclick=()=>run(b, restoreTo(ctx.repo(), b.dataset.currestore, b.dataset.key, b.dataset.owner)));
}
