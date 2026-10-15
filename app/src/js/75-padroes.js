// Starfork — 75-padroes
// ===== PADRÕES DO TIME (redesenho "Semana", mesa-semana-app §1–§3 e mock starfork-semana-completo) =====
// Três ABAS próprias (kinds exatamente 'skills', 'agentes', 'memoria' — a lateral chama openTab(kind)):
//  - Skills: catálogo com filtros, detalhe (o que faz, versão, dono), "Onde está ligada" por projeto com "quando usar",
//    os 3 jeitos de usar, histórico de quem ligou/desligou e "Adicionar skill" (Git, do zero, colar SKILL.md, montar com IA).
//  - Agentes: Vega, Íris, Nyx… com papel, modelo, versão e contagens; aviso "revisor no mesmo modelo de quem constrói";
//    equipes prontas; ficha com Papel e modelo (trocar = rascunho → testar numa amostra → salvar como versão N),
//    Versões, Aprendizados e Desempenho.
//  - Memória: o que a IA lê no começo de cada tarefa — busca, filtros, nota com tipo/autor/data/origem/uso, conflito,
//    corrigir (com histórico), arquivar (nunca apaga), "virar regra do time?" e "Arrumar a memória" (curador, 62).
// Reaproveita: list/set de skills e o "Adicionar" (13), cérebro do projeto e aprendizados (37), boletim/versões dos
// agentes (61), amostra (63), curador (62), equipes por tipo (60). Dados novos: padroes.rs (Rust) e _uso.json (motor).
// As telas antigas dentro de Projeto (Memória/Agentes/Skills) passam a abrir estas abas.
// Ganchos exportados pra outras frentes (sem mexer na lateral nem no interior da tarefa):
//   padMemoriaDaTarefa(taskId) → Promise<[{ scope, slug, title, by, updated }]>   (o "N notas de memória" da tarefa)
//   padMemoriaErrada(scope, slug)  → abre Memória com a nota em edição           ("Isso está errado")
//   padSkillsDaTarefa(task)        → [{ name, version, why:'pedida'|'padrão do projeto'|'ligada' }]
//   padUsarNaNovaDemanda(name)     → abre a Nova demanda com a skill marcada em "Usar também"

// @padroes-puro-inicio (testado em app/tests/padroes.test.mjs — sem DOM nem estado global)
const PAD_QUANDO=[['','só quando pedir'],['UI','sempre em tarefas de UI'],['codigo','sempre em tarefas de código'],['todas','sempre, em todas']];
const PAD_SRC_LABEL={ projeto:'do repositório', pessoal:'da sua biblioteca', comunidade:'comunidade' };
function padBase(p){ const s=String(p||'').replace(/[\\/]+$/,''); return s.slice(s.search(/[^\\/]*$/)); }
// "testes-carrinho" → "Testes carrinho" (o nome técnico continua à vista como /nome)
// 1ª frase da descrição (o "pra que serve" curto da lista)
function padFirst(d){ const t=String(d||'').replace(/\s+/g,' ').trim(); const m=/^(.{12,}?[.!?])(\s|$)/.exec(t); return (m?m[1]:t).replace(/[.!?]+$/,''); }
function padSkTitle(name){ const t=String(name||'').replace(/[-_]+/g,' ').trim(); return t?t.charAt(0).toUpperCase()+t.slice(1):''; }
function padQuandoLabel(q){ const x=PAD_QUANDO.find(p=>p[0]===(q||'')); return x?x[1]:PAD_QUANDO[0][1]; }
// a skill vale nesse projeto? (a do repositório só existe no repo dela; pessoal/comunidade em qualquer um)
function padSkCanOn(it, repo){ return it.source!=='projeto' || it.repo===repo; }
function padSkOnIn(it, repo){ return !!(it.on && it.on[repo] && it.on[repo].on); }
/** Filtro do catálogo (puro): f = todas | aqui | repo | biblioteca | comunidade. Mantém a ordem (mais recentes primeiro). */
function padSkFilter(items, f, repo){
  return (items||[]).filter(it=>{
    if(f==='aqui') return padSkOnIn(it, repo);
    if(f==='repo') return it.source==='projeto';
    if(f==='biblioteca') return it.source==='pessoal';
    if(f==='comunidade') return it.source==='comunidade';
    return true;
  });
}
function padSkKey(it){ return (it.source==='projeto'?it.repo+'|':'')+it.name; }
// "Onde está ligada": uma linha por projeto aberto neste computador (o atual primeiro)
function padSkWhere(it, repos, cur){
  const list=[...new Set([cur, ...(repos||[])].filter(Boolean))];
  return list.map(r=>{ const e=(it.on||{})[r]; const can=padSkCanOn(it, r);
    return { repo:r, name:padBase(r), on:!!(e&&e.on), quando:(e&&e.quando)||'', can,
      text:!can?'fica no repositório de '+padBase(it.repo):(e&&e.on)?(e.quando?padQuandoLabel(e.quando):'ligada, só quando pedir'):'desligada' }; });
}
// "Ana ligou Testes carrinho em loja-web" · "hoje, 10:40"
function padSkHistLine(h){ const who=String(h&&h.by||'').trim()||'Você'; const sk=padSkTitle(h&&h.skill);
  const q=h&&h.action==='mudou quando usar'?' ('+padQuandoLabel(h.quando)+')':'';
  return who+' '+(h&&h.action||'mexeu em')+' '+sk+' em '+padBase(h&&h.repo)+q; }
// quando: "hoje, 10:40" · "ontem" · "09/10"
function padWhen(at, now){
  const d=new Date(+at||0), n=new Date(now||Date.now()); if(!(+at>0)) return '';
  const day=x=>new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const p=x=>String(x).padStart(2,'0');
  const diff=Math.round((day(n)-day(d))/86400000);
  if(diff===0) return 'hoje, '+p(d.getHours())+':'+p(d.getMinutes());
  if(diff===1) return 'ontem';
  return p(d.getDate())+'/'+p(d.getMonth()+1)+(d.getFullYear()===n.getFullYear()?'':'/'+d.getFullYear());
}
/** Estatística do cartão do agente em CONTAGENS (nunca % abaixo de 10): v = agStatsView(...). */
function padAgStat(v, role){
  if(!v || !v.tasks) return 'ainda medindo';
  if(v.knowing) return 'ainda conhecendo ('+v.tasks+(v.tasks===1?' tarefa)':' tarefas)');
  if(role==='reviewer' && v.reviewed) return 'achou problema em '+v.returned+' de '+v.reviewed+' revisões';
  return v.first+' de '+v.n+' '+(role==='planner'?'planos aprovados':'entregas')+' de primeira';
}
/** Desempenho por versão (puro): linhas do agent_stats deste agente → [{ v, tasks, first, gate, rework, problems }] mais nova primeiro. */
function padAgPerVersion(rows, verOf, firstTry, reached){
  const by=new Map(); const seen=new Set();
  for(const r of (rows||[])){ if(!r || seen.has(r.taskId)) continue; seen.add(r.taskId);
    const v=verOf(r.papel); if(v==null) continue;
    const a=by.get(v)||{ v, tasks:0, gate:0, first:0, rework:0, problems:0 }; a.tasks++;
    if(reached(r)){ a.gate++; if(firstTry(r)) a.first++; }
    if(+r.reworks>0) a.rework++; if(+r.muda>0) a.problems++;
    by.set(v, a); }
  return [...by.values()].sort((a,b)=>b.v-a.v);
}
// tokens de um título pra comparar notas (sem acento, minúsculo, ≥ 3 letras)
function padTok(s){ return new Set(String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3)); }
function padNums(s){ return (String(s||'').match(/\d+(?:[.,]\d+)?/g)||[]).map(x=>x.replace(',','.')); }
/**
 * Notas que podem se contradizer (puro): metade ou mais das palavras do título em comum e NÚMEROS diferentes
 * ("Frete grátis a partir de R$ 150" × "… R$ 199"). → { "escopo:slug": { scope, slug, title, by } } (a outra nota).
 */
function padMemConflicts(notes){
  const L=(notes||[]).map(n=>({ n, tk:padTok(n.title), nums:padNums(n.title).length?padNums(n.title):padNums(n.summary) })).filter(x=>x.tk.size>=2);
  const out={};
  for(let i=0;i<L.length;i++) for(let j=i+1;j<L.length;j++){
    const a=L[i], b=L[j];
    let k=0; for(const w of a.tk) if(b.tk.has(w)) k++;
    const sim=k/Math.min(a.tk.size, b.tk.size);
    if(sim<0.5 || !a.nums.length || !b.nums.length) continue;
    if(a.nums.join('|')===b.nums.join('|')) continue;
    const ref=x=>({ scope:x.n.scope, slug:x.n.slug, title:x.n.title, by:x.n.by||'' });
    out[a.n.scope+':'+a.n.slug]=out[a.n.scope+':'+a.n.slug]||ref(b);
    out[b.n.scope+':'+b.n.slug]=out[b.n.scope+':'+b.n.slug]||ref(a);
  }
  return out;
}
/** Filtro da Memória (puro): f = time | eu | arq (rev é a fila de aprendizados, fora daqui); q busca título/tags/corpo. */
function padMemFilter(notes, archived, f, q){
  const t=String(q||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().split(/\s+/).filter(Boolean);
  const hit=n=>{ if(!t.length) return true; const h=[n.title,(n.tags||[]).join(' '),n.summary||'',n.body||''].join(' ').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); return t.every(w=>h.includes(w)); };
  const src=f==='arq'?(archived||[]):(notes||[]).filter(n=>f==='eu'?n.scope==='local':n.scope==='time');
  return src.filter(hit);
}
// skills que foram pro agente numa tarefa: as "pedidas" (Nova demanda › Usar também) + as do evento `papel` (P10)
function padSkillsOfTask(objective, events){
  const out=[]; const add=(name, version, why)=>{ if(name && !out.some(x=>x.name===name)) out.push({ name, version, why }); };
  const m=/Skills pedidas: ([^\n]+)/.exec(String(objective||''));
  if(m) for(const p of m[1].split(',')){ const n=(/\/([\w.:-]+)/.exec(p)||[])[1]; if(n) add(n, null, 'pedida'); }
  const ev=(events||[]).find(e=>e && e.type==='papel' && /^skills ativas:/.test(String(e.text||'')));
  if(ev){ const first=String(ev.text).split(' · ')[0].replace(/^skills ativas:\s*/,'');
    for(const s of first.split(',')){ const x=/^(.+)@v(\d+)$/.exec(s.trim()); if(x) add(x[1].trim(), +x[2], 'ligada no projeto'); } }
  return out;
}
// o pedido da Nova demanda com as skills marcadas em "Usar também" (o agente lê no objetivo; a tarefa mostra)
function padObjectiveWithSkills(objective, names){
  const l=(names||[]).filter(Boolean); if(!l.length) return objective||'';
  return String(objective||'').replace(/\n*Skills pedidas: [^\n]*$/,'')+'\n\nSkills pedidas: '+l.map(n=>'/'+n).join(', ')+' — use cada uma nesta tarefa (tool Skill ou /nome).';
}
// @padroes-puro-fim

// ---------------------------------------------------------------- ícones (traço de 16px, como o IC)
const PAD_IC={
  wand:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 13l7.5-7.5M9.5 3.2v1.6M12.8 6.5h-1.6M11.9 3.9l-1.1 1.1M5.4 2.6v1.2M4.8 3.2h1.2M12.4 10.6v1.2M11.8 11.2H13"/></svg>',
  users:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9"/></svg>',
  book:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 4.5C6.7 3.7 5 3.5 3.4 3.9v7.9c1.6-.4 3.3-.2 4.6.6m0-9c1.3-.8 3-1 4.6-.6v7.9c-1.6-.4-3.3-.2-4.6.6m0-9v9" stroke-linejoin="round"/></svg>',
  spark:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 2.2v2.6M8 11.2v2.6M2.2 8h2.6M11.2 8h2.6M3.9 3.9l1.8 1.8M10.3 10.3l1.8 1.8M12.1 3.9l-1.8 1.8M5.7 10.3l-1.8 1.8"/></svg>',
  plus:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.4v9.2M3.4 8h9.2" stroke-linecap="round"/></svg>',
  alert:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2.3l6 10.6H2z"/><path d="M8 6.5v3M8 11.2v.05" stroke-linecap="round"/></svg>',
  play:'<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6L12.6 8z"/></svg>',
  back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.8 3.5L5.3 8l4.5 4.5"/></svg>',
  search:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L13.5 13.5" stroke-linecap="round"/></svg>',
  git:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="6" r="1.6"/><path d="M4.5 5.6v4.8M11.5 7.6c0 2.4-3 2.2-6.2 3"/></svg>',
  doc:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2.5h5.2L12 5.3v8.2H4z" stroke-linejoin="round"/><path d="M9 2.6v2.8h2.9M6 8h4M6 10.3h4" stroke-linecap="round"/></svg>',
  check:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.5 8.4l3 3 6-6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const padIc=(k)=>`<span class="pad-ic" aria-hidden="true">${PAD_IC[k]||''}</span>`;
const padE=(s)=>(typeof esc==='function')?esc(s):String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const padA=(s)=>padE(s).replace(/"/g,'&quot;');
function padMe(){ try{ const n=typeof personMeName==='function'?personMeName():''; if(n) return n; }catch(_){ } return 'Você'; }
function padRepos(){ return ((typeof projects!=='undefined'&&projects)||[]).map(p=>p&&p.path).filter(Boolean); }

// ---------------------------------------------------------------- registro das 3 abas no motor de abas (15)
const PAD_OV={ skills:'padSkOverlay', agentes:'padAgOverlay', memoria:'padMemOverlay' };
function padEnsureOverlays(){
  if(typeof document==='undefined' || !document.createElement) return;
  const ref=$id('atalhosOverlay');
  for(const id of Object.values(PAD_OV)){
    if($id(id)) continue;
    const o=document.createElement('div'); o.className='overlay fwoverlay pgov pad-ov'; o.id=id; o.style.display='none';
    o.innerHTML=`<div class="pgpage pad-page" id="${id.replace('Overlay','Page')}"></div>`;
    if(ref && ref.parentNode) ref.parentNode.insertBefore(o, ref.nextSibling); else if(document.body) document.body.appendChild(o);
  }
}
padEnsureOverlays();
if(typeof VIEW_META!=='undefined'){
  VIEW_META.skills={ title:'Skills', icon:'<path d="M3 13l7.5-7.5M9.5 3.2v1.6M12.8 6.5h-1.6M11.9 3.9l-1.1 1.1M5.4 2.6v1.2M4.8 3.2h1.2" stroke-linecap="round"/>' };
  VIEW_META.agentes={ title:'Agentes', icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9"/>' };
  VIEW_META.memoria={ title:'Memória', icon:'<path d="M8 4.5C6.7 3.7 5 3.5 3.4 3.9v7.9c1.6-.4 3.3-.2 4.6.6m0-9c1.3-.8 3-1 4.6-.6v7.9c-1.6-.4-3.3-.2-4.6.6m0-9v9" stroke-linejoin="round"/>' };
  Object.assign(VIEW_OVERLAY, PAD_OV);
}
// as telas antigas que viviam em Projeto › Memória/Agentes/Skills agora abrem as abas (openTab('agents') também)
if(typeof VIEW_ROUTES!=='undefined'){ delete VIEW_ROUTES.memoria; delete VIEW_ROUTES.skills; VIEW_ROUTES.agents=['agentes', null]; }
if(typeof KEEP_ON_SWITCH!=='undefined'){ KEEP_ON_SWITCH.add('agentes'); KEEP_ON_SWITCH.add('skills'); KEEP_ON_SWITCH.add('memoria'); }
if(typeof PROJ_SECS!=='undefined'){ for(const k of ['memoria','agentes','skills']){ const i=PROJ_SECS.findIndex(x=>x[0]===k); if(i>=0) PROJ_SECS.splice(i,1); } }
if(typeof projSub!=='undefined' && ['memoria','agentes','skills'].includes(projSub)) projSub='conversa';
if(typeof projGo==='function' && !projGo.__pad){ const pg=projGo; projGo=function(sub){ if(['memoria','agentes','skills'].includes(sub)) return openTab(sub); return pg.apply(this, arguments); }; projGo.__pad=true; window.projGo=projGo; }
if(typeof viewOpen==='function' && !viewOpen.__pad){ const vo=viewOpen; viewOpen=function(kind, tab){
    if(kind==='skills') return padSkOpen(tab);
    if(kind==='agentes') return padAgOpen(tab);
    if(kind==='memoria') return padMemOpen(tab);
    const r=vo.apply(this, arguments);
    if(kind==='planner'||kind==='form'||kind==='nova') setTimeout(padUsarTambemPaint, 60);
    return r; }; viewOpen.__pad=true; }
// botões antigos (menu "mais", atalhos) que abriam os modais
for(const [id, k] of [['skillsBtn','skills'],['agentsBtn','agentes'],['memBtn','memoria']]){ const b=typeof $id==='function'?$id(id):null; if(b) b.onclick=()=>openTab(k); }
// fechar a aba Agentes com o editor avançado sujo pergunta antes (mesmo "descartar?" do cancelar do editor)
if(typeof closeTab==='function' && !closeTab.__pad){ const c0=closeTab; closeTab=function(id){
    const t=(typeof tabById==='function')?tabById(id):null;
    if(t && t.kind==='agentes' && PADA.adv && typeof agDirty==='function' && agDirty()){
      askYes('Descartar as mudanças nos agentes e equipes?\n\nNada foi salvo ainda.').then(ok=>{ if(!ok) return; if(typeof agBase!=='undefined') agBase=''; PADA.adv=false; padOldPark('agOverlay'); c0(id); });
      return; }
    if(t && t.kind==='agentes'){ PADA.adv=false; padOldPark('agOverlay'); }
    if(t && t.kind==='memoria'){ PADM.adv=false; padOldPark('memOverlay'); }
    return c0.apply(this, arguments); }; closeTab.__pad=true; }
function padShow(kind){ const ov=PAD_OV[kind]; if(typeof ovShow==='function') ovShow(ov); }
function padTabOn(kind){ const t=(typeof tabById==='function')?tabById(activeTab):null; return !!(t && t.kind===kind); }
// teclado comum das páginas: setas numa lista de botões (role="listbox"/grupo de chips), "/" foca a busca
function padArrows(root, sel){
  const bs=[...root.querySelectorAll(sel)];
  bs.forEach((b,i)=>b.addEventListener('keydown', e=>{ const d={ ArrowDown:1, ArrowUp:-1, ArrowRight:1, ArrowLeft:-1 }[e.key]; if(!d) return; e.preventDefault(); const n=bs[(i+d+bs.length)%bs.length]; if(n){ n.focus(); if(n.dataset.padauto) n.click(); } }));
}
// a tela COMPLETA antiga (editor do catálogo de agentes e equipes; notas ligadas + grafo da memória) continua existindo:
// vira um "Avançado" DENTRO da aba nova — o overlay é movido pra cá (como a página Projeto fazia) e volta pro body ao sair
function padOldPark(id){ const o=$id(id); if(o && o.closest && o.closest('.pad-page')){ o.classList.remove('astab','inproj'); o.style.display='none'; document.body.appendChild(o); } }
function padOldMount(hostId, id, open){ const host=$id(hostId), o=$id(id); if(!host || !o) return; if(o.parentElement!==host) host.appendChild(o); o.classList.add('astab','inproj'); o.style.display='block'; try{ if(open) open(); }catch(e){ console.error('padOldMount', e); } o.style.display='block'; }
function padSwitchKeys(root){ root.querySelectorAll('[role="switch"]').forEach(s=>s.addEventListener('keydown', e=>{ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); s.click(); } })); }

// =====================================================================================================================
// SKILLS
// =====================================================================================================================
const PADS={ data:null, err:'', sel:null, f:'todas', add:null, busy:false, loadedAt:0 };
async function padSkLoad(force){
  if(!force && PADS.data && Date.now()-PADS.loadedAt<15000) return PADS.data;
  try{ PADS.data=await invoke('skills_catalog', { repos:padRepos() })||{ skills:[], hist:[], repos:[] }; PADS.err=''; PADS.loadedAt=Date.now(); }
  catch(e){ PADS.err=(typeof errShort==='function')?errShort(e):String((e&&e.message)||e); PADS.data=PADS.data||{ skills:[], hist:[], repos:[] }; }
  return PADS.data;
}
async function padSkOpen(tab){
  padShow('skills');
  const pg=$id('padSkPage'); if(!pg) return;
  if(tab && tab.sub){ PADS.sel=tab.sub; tab.sub=null; }
  if(!PADS.data) pg.innerHTML=padSkHead()+`<div class="pgbody pad-body">${typeof skeletonHtml==='function'?skeletonHtml('cards',{ n:6 }):'<p class="dim">lendo as skills…</p>'}</div>`;
  await padSkLoad(true);
  padSkRender();
}
window.padSkOpen=padSkOpen;
function padSkHead(){
  return pageHead({ title:'Skills', sub:'Habilidades extras que os agentes seguem. Ligue uma skill num projeto e use em qualquer tarefa dele.',
    right:`<button class="btn" id="padSkAdd" aria-haspopup="menu">${padIc('plus')}Adicionar skill</button>` });
}
function padSkItems(){ return (PADS.data&&PADS.data.skills)||[]; }
function padSkSel(){ const L=padSkItems(); return L.find(x=>padSkKey(x)===PADS.sel)||L.find(x=>x.name===PADS.sel)||null; }
function padSkRender(){
  const pg=$id('padSkPage'); if(!pg) return;
  const repo=state.repo||'', here=repo?padBase(repo):'este projeto';
  const all=padSkItems(), L=padSkFilter(all, PADS.f, repo);
  if(!padSkSel() && L.length) PADS.sel=padSkKey(L[0]);
  const s=padSkSel();
  const chips=[['todas','Todas'],['aqui','Ligadas em '+here],['repo','Do repositório'],['biblioteca','Sua biblioteca'],['comunidade','Comunidade']];
  const ic=it=>it.source==='comunidade'?'git':it.source==='projeto'?'doc':'wand';
  const list=L.length?L.map(it=>`<button class="pad-citem" role="option" aria-selected="${s&&padSkKey(it)===padSkKey(s)}" aria-current="${s&&padSkKey(it)===padSkKey(s)}" data-padsk="${padA(padSkKey(it))}" data-padauto="1">
      <span class="pad-cic">${PAD_IC[ic(it)]}</span><span class="pad-cn">${padE(padSkTitle(it.name))} <span class="pad-faint">${padE(it.version>1?'v'+it.version:'v1')}</span></span>
      ${padSkOnIn(it, repo)?'<span class="pad-tag g">ligada aqui</span>':'<span class="pad-tag">desligada aqui</span>'}
      <span class="pad-cw">${padE(padFirst(it.description)||'sem descrição')} · ${padE(PAD_SRC_LABEL[it.source]||'')}</span></button>`).join('')
    :`<p class="pad-empty">${all.length?'Nenhuma skill neste filtro.':'Nenhuma skill ainda. Traga de um repositório Git, cole um SKILL.md ou crie uma do zero.'}</p>`;
  const body=`<div class="pad-cat">
    <div class="pad-catl"><div class="pad-fchips" role="group" aria-label="Filtrar skills">${chips.map(([k,l])=>`<button aria-pressed="${PADS.f===k}" data-padskf="${k}">${padE(l)}</button>`).join('')}</div>
      ${PADS.add?padSkAddHtml():''}
      <div class="pad-clist" role="listbox" aria-label="Skills">${list}</div></div>
    <div class="pad-det">${s?padSkDetailHtml(s, repo):'<div class="pad-panel"><p class="pad-empty">Escolha uma skill à esquerda.</p></div>'}</div></div>`;
  pg.innerHTML=padSkHead()+`<div class="pgbody pad-body">${PADS.err?`<p class="pad-err">Não consegui ler as skills — ${padE(PADS.err)}</p>`:''}${body}</div>`;
  padSkWire(pg, s, repo);
}
function padSkDetailHtml(s, repo){
  const here=repo?padBase(repo):'';
  const owner=s.source==='projeto'?(s.owner?'mantida por '+s.owner:'ainda fora do git'):s.source==='comunidade'?(s.origin?'de '+String(s.origin).replace(/^https?:\/\//,'').replace(/\.git$/,''):'importada'):'mantida por '+padMe();
  const pads=Object.entries(s.on||{}).filter(([,e])=>e&&e.quando).map(([r])=>padBase(r));
  const where=padSkWhere(s, padRepos(), repo);
  const rows=where.map(w=>`<div class="pad-row"><span class="pad-rt"><b>${padE(w.name)}</b><span>${padE(w.text)}</span></span>
    ${w.on&&w.can?`<select class="in pad-sel" data-padquando="${padA(w.repo)}" aria-label="${padA('Quando usar em '+w.name)}">${PAD_QUANDO.map(([v,l])=>`<option value="${v}"${(w.quando||'')===v?' selected':''}>${padE(l)}</option>`).join('')}</select>`:''}
    <span class="pad-tgl" role="switch" tabindex="${w.can?0:-1}" aria-checked="${w.on}" aria-disabled="${!w.can}" aria-label="${padA('Ligar '+padSkTitle(s.name)+' em '+w.name)}" data-padon="${padA(w.repo)}"></span></div>`).join('');
  const onHere=padSkOnIn(s, repo), canHere=repo&&padSkCanOn(s, repo);
  const pad=(s.on&&s.on[repo]&&s.on[repo].quando)||'';
  const hist=((PADS.data&&PADS.data.hist)||[]).filter(h=>h.skill===s.name).slice(0,8);
  return `<div class="pad-panel"><div class="pad-dhead"><span class="pad-dic">${PAD_IC[s.source==='comunidade'?'git':s.source==='projeto'?'doc':'wand']}</span>
      <div class="pad-dt"><h2 class="pad-big">${padE(padSkTitle(s.name))}</h2><div class="pad-muted">${padE(PAD_SRC_LABEL[s.source]||'')} · versão ${padE(s.version||1)} · ${padE(owner)}</div></div>
      ${pads.length?`<span class="pad-tag a">padrão em ${padE(pads.join(', '))}</span>`:''}</div>
      <p class="pad-desc">${padE(s.description||'Sem descrição — o "quando usar" do SKILL.md está vazio.')}</p></div>
    <div class="pad-panel"><h2>Onde está ligada</h2><p class="pad-d">Ligar num projeto deixa a skill disponível nas tarefas dele. "Sempre" faz ela entrar sozinha.</p>${rows||'<p class="pad-empty">Abra um projeto pra ligar a skill nele.</p>'}</div>
    <div class="pad-panel"><h2>Como usar numa tarefa</h2><p class="pad-d">Os 3 jeitos usam esta mesma skill e versão. A tarefa mostra o que foi pro agente.</p>
      <div class="pad-row"><span class="pad-rt"><b>1. Na Nova demanda</b><span>marque em "Usar também" antes de criar</span></span><button class="btn ${onHere?'primary':''} sm" id="padSkUsar" ${onHere?'':`disabled title="${padA('Ligue em '+(here||'um projeto')+' primeiro')}"`}>Usar numa nova demanda</button></div>
      <div class="pad-row"><span class="pad-rt"><b>2. Dentro da tarefa</b><span>botão Skills ▾ embaixo do terminal, ou digite <code class="pad-code">/${padE(s.name)}</code> no terminal</span></span></div>
      <div class="pad-row"><span class="pad-rt"><b>3. Padrão do projeto</b><span>entra sozinha nas tarefas do tipo escolhido, para todo o time</span></span><button class="btn sm" id="padSkPad" ${canHere?'':'disabled'}>${pad?padE('Já é padrão em '+here+' ('+padQuandoLabel(pad).replace(/^sempre /,'')+')'):'Sempre em tarefas de UI'}</button></div></div>
    <div class="pad-panel"><h2>Histórico</h2>${hist.length?hist.map(h=>`<div class="pad-row"><span class="pad-rt"><b>${padE(padSkHistLine(h))}</b><span>${padE(padWhen(h.at))}</span></span></div>`).join(''):'<p class="pad-empty">Ninguém ligou nem desligou esta skill por aqui ainda.</p>'}</div>`;
}
function padSkAddHtml(){
  if(typeof skAddPanelHtml!=='function') return '';
  if(typeof skAddMode!=='undefined') skAddMode=PADS.add;
  return `<div class="pad-add">${skAddPanelHtml()}</div>`;
}
function padSkWire(pg, s, repo){
  const add=pg.querySelector('#padSkAdd'); if(add) add.onclick=()=>padSkAddMenu(add);
  pg.querySelectorAll('[data-padskf]').forEach(b=>b.onclick=()=>{ PADS.f=b.dataset.padskf; PADS.sel=null; padSkRender(); const n=$id('padSkPage').querySelector(`[data-padskf="${PADS.f}"]`); if(n) n.focus(); });
  pg.querySelectorAll('[data-padsk]').forEach(b=>b.onclick=()=>{ const kb=document.activeElement===b; PADS.sel=b.dataset.padsk; padSkRender(); const n=[...$id('padSkPage').querySelectorAll('[data-padsk]')].find(x=>x.dataset.padsk===PADS.sel); if(n && kb) n.focus(); });
  padArrows(pg.querySelector('.pad-clist')||pg, '[data-padsk]');
  pg.querySelectorAll('[data-padon]').forEach(t=>t.onclick=()=>{ if(t.getAttribute('aria-disabled')==='true'){ toast('Esta skill mora no repositório de '+padBase(s.repo)+' — pra valer em outro projeto, copie a pasta dela pro .claude/skills de lá.','warn'); return; } padSkSet(s, t.dataset.padon, t.getAttribute('aria-checked')!=='true', ((s.on||{})[t.dataset.padon]||{}).quando||''); });
  pg.querySelectorAll('[data-padquando]').forEach(sl=>sl.onchange=()=>padSkSet(s, sl.dataset.padquando, true, sl.value));
  padSwitchKeys(pg);
  bindClick('padSkUsar', ()=>padUsarNaNovaDemanda(s.name));
  bindClick('padSkPad', ()=>{ const cur=((s.on||{})[repo]||{}).quando; if(cur){ padSkSet(s, repo, true, ''); return; } padSkSet(s, repo, true, 'UI'); });
  padSkAddWire(pg);
}
async function padSkSet(s, repo, on, quando){
  if(PADS.busy) return; PADS.busy=true;
  const was=((s.on||{})[repo]||{});
  try{
    const r=await invoke('skill_set_on', { repo, name:s.name, description:s.description||'', on, quando:quando||null, by:padMe() });
    s.on=s.on||{}; if(on) s.on[repo]={ on:true, quando:(r&&r.quando)||'' }; else delete s.on[repo];
    const nm=padSkTitle(s.name), pj=padBase(repo);
    if(!on) toast(nm+' desligada em '+pj+(was.quando?' · era padrão: quem usa o projeto fica sem ela':'')+'.','ok');
    else if(quando) toast(nm+' entra sozinha em '+pj+': '+padQuandoLabel(quando)+'.','ok');
    else toast(nm+(was.on?' agora só quando pedir em ':' ligada em ')+pj+'.','ok');
    if(repo===state.repo && typeof TI!=='undefined' && TI) TI.skills=null; // a folha "Rodar uma skill" do terminal relê
    await padSkLoad(true);
  }catch(e){ showErr(e, 'Não consegui mudar a skill'); }
  finally{ PADS.busy=false; padSkRender(); const t=$id('padSkPage')&&[...$id('padSkPage').querySelectorAll('[data-padon]')].find(x=>x.dataset.padon===repo); if(t) t.focus(); }
}
function padSkAddMenu(anchor){
  const go=(m)=>{ if(m==='ia'){ PADS.add='ia'; } else PADS.add=m; if(typeof skGitFound!=='undefined') skGitFound=null; padSkRender(); const f=$id('padSkPage').querySelector('.pad-add input, .pad-add textarea'); if(f) f.focus(); };
  const items=[{ label:'Do Git', hint:'URL de um repositório de skills', ic:'push', act:()=>go('git') }, { label:'Criar do zero', hint:'nome, quando usar, instruções', ic:'plus', act:()=>go('criar') },
    { label:'Colar um SKILL.md', hint:'o conteúdo do arquivo', act:()=>go('importar') }, { label:'Montar com IA', hint:'conversando', act:()=>go('ia') }];
  if(typeof g1Menu==='function') g1Menu(anchor, items); else go('git');
}
// o painel de adicionar é o MESMO do 13 (skAddPanelHtml); aqui só o fim muda: relê o catálogo em vez de abrir o modal antigo
function padSkAddWire(pg){
  const box=pg.querySelector('.pad-add'); if(!box) return;
  const done=async(msg, name)=>{ PADS.add=null; if(typeof skGitFound!=='undefined') skGitFound=null; await padSkLoad(true); if(name) PADS.sel=name; padSkRender(); toast(msg,'ok'); };
  box.querySelectorAll('[data-skmode]').forEach(el=>el.onclick=()=>{ PADS.add=el.dataset.skmode; if(typeof skGitFound!=='undefined') skGitFound=null; padSkRender(); });
  bindClick('skAddCancel', ()=>{ PADS.add=null; padSkRender(); });
  bindClick('skGitDetect', async()=>{ const url=($id('skGitUrl')||{}).value||''; if(!url.trim()){ toast('Cole a URL do repositório.','warn'); return; }
    const b=$id('skGitDetect'); if(b){ b.disabled=true; b.textContent='clonando…'; }
    try{ const r=await invoke('git_skills',{ url:url.trim(), branch:(($id('skGitBranch')||{}).value||'').trim()||null, subpath:(($id('skGitSub')||{}).value||'').trim()||null, picks:null }); skGitFound=r.found||[]; const keep={ u:url, b:($id('skGitBranch')||{}).value||'', s:($id('skGitSub')||{}).value||'' }; padSkRender(); if($id('skGitUrl')) $id('skGitUrl').value=keep.u; if($id('skGitBranch')) $id('skGitBranch').value=keep.b; if($id('skGitSub')) $id('skGitSub').value=keep.s; }
    catch(e){ showErr(e, 'Não consegui ler o repositório'); if(b){ b.disabled=false; b.textContent='detectar skills'; } } });
  bindClick('skGitImport', async()=>{ const url=($id('skGitUrl')||{}).value||''; const picks=[...document.querySelectorAll('#padSkPage [data-gk]:checked')].map(c=>c.dataset.gk);
    if(!picks.length){ toast('Marque ao menos uma skill.','warn'); return; }
    try{ await invoke('git_skills',{ url:url.trim(), branch:(($id('skGitBranch')||{}).value||'').trim()||null, subpath:(($id('skGitSub')||{}).value||'').trim()||null, picks }); await done(picks.length===1?'Skill '+picks[0]+' importada — ligue ela no projeto.':picks.length+' skills importadas — ligue as que quiser.', picks[0]); }
    catch(e){ showErr(e, 'Não consegui importar'); } });
  bindClick('skDoCreate', async()=>{ const name=($id('skNewName')||{}).value||'', desc=($id('skNewDesc')||{}).value||'', bodyv=($id('skNewBody')||{}).value||'';
    if(!name.trim()||!desc.trim()){ toast('Preencha nome e "quando usar".','warn'); return; }
    try{ const n=await invoke('create_skill',{ name:name.trim(), description:desc.trim(), body:bodyv }); await done('Skill criada na sua biblioteca — ligue ela no projeto.', n); }catch(e){ showErr(e, 'Não consegui criar a skill'); } });
  bindClick('skDoImport', async()=>{ const md=($id('skImpMd')||{}).value||''; if(!md.trim()){ toast('Cole o conteúdo do SKILL.md.','warn'); return; }
    try{ const n=await invoke('import_skill_md',{ content:md }); await done('Skill importada — ligue ela no projeto.', n); }catch(e){ showErr(e, 'Não consegui importar'); } });
  bindClick('skAiGo', ()=>{ PADS.add=null; if(typeof skAiCreate==='function') skAiCreate(); });
}

// ---------------------------------------------------------------- Nova demanda › "Usar também"
const PAD_NOVA={ skills:[] };
function padUsarNaNovaDemanda(name){
  if(name && !PAD_NOVA.skills.includes(name)) PAD_NOVA.skills=[...PAD_NOVA.skills, name];
  openTab('nova');
  setTimeout(padUsarTambemPaint, 120); setTimeout(padUsarTambemPaint, 600);
  toast('Nova demanda com a skill '+padSkTitle(name)+' marcada em "Usar também".','info');
}
window.padUsarNaNovaDemanda=padUsarNaNovaDemanda;
async function padUsarTambemPaint(){
  const ov=$id('plannerOverlay'); if(!ov || ov.style.display==='none' || !state.repo) return;
  const col=ov.querySelector('.plchatcol'), inp=ov.querySelector('.plinput'); if(!col || !inp) return;
  await padSkLoad(false);
  const repo=state.repo, lig=padSkItems().filter(it=>padSkOnIn(it, repo));
  let box=$id('padUsar'); if(!box){ box=document.createElement('div'); box.id='padUsar'; box.className='pad-usar'; col.insertBefore(box, inp); }
  if(!lig.length && !PAD_NOVA.skills.length){ box.hidden=true; return; }
  box.hidden=false;
  const fixed=lig.filter(it=>((it.on||{})[repo]||{}).quando);
  const opt=lig.filter(it=>!((it.on||{})[repo]||{}).quando);
  const h=`<span class="pad-usarh">Usar também</span>${fixed.map(it=>`<span class="pad-chipsk fixed" title="${padA('Padrão do projeto: '+padQuandoLabel(it.on[repo].quando))}">${PAD_IC.check}${padE(padSkTitle(it.name))} <i>${padE(padQuandoLabel(it.on[repo].quando).replace(/^sempre/,'sempre'))}</i></span>`).join('')}${opt.map(it=>`<button type="button" class="pad-chipsk" aria-pressed="${PAD_NOVA.skills.includes(it.name)}" data-padusar="${padA(it.name)}">${PAD_NOVA.skills.includes(it.name)?PAD_IC.check:''}${padE(padSkTitle(it.name))}</button>`).join('')}<button type="button" class="pad-chipsk ghost" data-padusar-outra="1">${PAD_IC.plus}outra skill</button>`;
  if(box.__h!==h){ box.__h=h; box.innerHTML=h;
    box.querySelectorAll('[data-padusar]').forEach(b=>b.onclick=()=>{ const n=b.dataset.padusar; PAD_NOVA.skills=PAD_NOVA.skills.includes(n)?PAD_NOVA.skills.filter(x=>x!==n):[...PAD_NOVA.skills, n]; padUsarTambemPaint(); });
    const o=box.querySelector('[data-padusar-outra]'); if(o) o.onclick=()=>openTab('skills'); }
}
// a skill marcada vai no OBJETIVO da tarefa (o agente lê; a tarefa mostra) — vale pra quem criar a próxima demanda
if(typeof trkBeforeNewTask==='function' && !trkBeforeNewTask.__pad){ const tb=trkBeforeNewTask; trkBeforeNewTask=async function(payload){
    if(payload && PAD_NOVA.skills.length && payload.branchType!=='integration'){ payload=Object.assign({}, payload, { objective:padObjectiveWithSkills(payload.objective, PAD_NOVA.skills) }); PAD_NOVA.skills=[]; const b=$id('padUsar'); if(b){ b.__h=''; } }
    return tb.call(this, payload); }; trkBeforeNewTask.__pad=true; }
// o que foi pro agente numa tarefa (a frente da tarefa liga onde quiser)
function padSkillsDaTarefa(task){
  const t=typeof task==='string'?((state.tasks||[]).find(x=>x.id===task)||{ id:task }):(task||{});
  const evs=((state.events||[]).filter(e=>e && e.task_id===t.id));
  return padSkillsOfTask((t.spec&&t.spec.objective)||t.objective||'', evs);
}
window.padSkillsDaTarefa=padSkillsDaTarefa;

// =====================================================================================================================
// AGENTES
// =====================================================================================================================
const PADA={ cfg:null, cards:{}, sel:null, tab:'papel', draft:null, err:'', repo:'', smp:{}, running:'' };
async function padAgOpen(tab){
  padShow('agentes');
  if(tab && tab.sub){ PADA.sel=tab.sub; tab.sub=null; }
  const pg=$id('padAgPage'); if(!pg) return;
  const repo=state.repo||'';
  if(!PADA.cfg || PADA.repo!==repo) pg.innerHTML=padAgHeadHtml()+`<div class="pgbody pad-body">${typeof skeletonHtml==='function'?skeletonHtml('cards',{ n:6 }):''}</div>`;
  PADA.repo=repo; PADA.err='';
  try{
    const cfg=await invoke('config')||{};
    PADA.cfg={ agents:(cfg.agents||[]).filter(a=>a&&a.id), workflows:cfg.workflows||[] };
  }catch(e){ PADA.err=(typeof errShort==='function')?errShort(e):String((e&&e.message)||e); PADA.cfg=PADA.cfg||{ agents:[], workflows:[] }; }
  padAgRender();
  // boletim (UMA query) + versão de cada um: pintam quando chegarem
  const jobs=[ (typeof agStatsLoad==='function'?agStatsLoad():Promise.resolve()).catch(()=>{}),
    ...PADA.cfg.agents.map(a=>invoke('agent_card',{ repo, agentId:a.id }).then(c=>{ PADA.cards[a.id]=c||{}; }).catch(()=>{ PADA.cards[a.id]=PADA.cards[a.id]||{}; })) ];
  if(PADA.sel && typeof sampleLoad==='function') jobs.push(sampleLoad(repo, PADA.sel).catch(()=>{}));
  jobs.push(invoke('learn_pending',{ repo }).then(l=>{ PADA.pend=l||[]; }).catch(()=>{ PADA.pend=[]; }));
  await Promise.all(jobs);
  if(padTabOn('agentes')) padAgRender();
}
window.padAgOpen=padAgOpen;
function padAgHeadHtml(a){
  if(a) return '';
  return pageHead({ title:'Agentes', sub:'Quem faz o trabalho em cada etapa. Cada um tem um papel, um modelo de IA e versões.',
    right:`<button class="btn quiet" id="padAgAdv" title="criar e remover agentes, montar equipes, catálogo do time">Criar e editar equipes</button>` });
}
function padAgById(){ return Object.fromEntries(((PADA.cfg&&PADA.cfg.agents)||[]).map(a=>[a.id,a])); }
function padAgVer(id){ const c=PADA.cards[id]; return c&&c.versions&&c.versions.current!=null?+c.versions.current:null; }
function padAgModel(a){ return (typeof aiRunLabel==='function')?aiRunLabel(a.engine||'claude', a.model||''):[a.engine||'claude', a.model||'padrão'].join(' · '); }
function padAgView(a){ return (typeof AGS!=='undefined' && AGS.rows && typeof agStatsView==='function')?agStatsView(AGS.rows.filter(r=>r.agentId===a.id), typeof AG_MIN_N!=='undefined'?AG_MIN_N:10, { lembra:(AGS.lembra||{})[a.id]||0 }):null; }
function padAgRole(a){ return (typeof roleLabel==='function'?roleLabel(a.role):a.role||'').toLowerCase(); }
function padAgAv(a, big){ const c=a.color||(typeof AG_COLOR0!=='undefined'?AG_COLOR0:'var(--accent)'); return `<span class="pad-av${big?' big':''}" style="--c:${padA(c)}" aria-hidden="true">${padE(a.avatar||String(a.name||'?').trim().charAt(0).toUpperCase())}</span>`; }
// P5: revisor no MESMO motor e modelo de quem produz, numa equipe montada à mão (as equipes por tipo já trocam sozinhas)
function padAgWarn(){
  const byId=padAgById();
  for(const w of ((PADA.cfg&&PADA.cfg.workflows)||[])){
    if(typeof agTeamRoles!=='function' || typeof agTeamWarnings!=='function') return null;
    const roles=agTeamRoles(w.steps||[], byId, false); const ws=agTeamWarnings(roles); if(!ws.length) continue;
    const rv=roles[ws[0].idx], pi=(typeof agProducerIdx==='function')?agProducerIdx(roles, ws[0].idx):-1, pr=pi>=0?roles[pi]:null;
    return { reviewer:byId[rv.agentId]||rv, producer:pr?byId[pr.agentId]||pr:null, team:w.name||'equipe' };
  }
  return null;
}
function padAgReadyTeams(){
  const byId=padAgById(), agents=(PADA.cfg&&PADA.cfg.agents)||[];
  if(typeof kindAgentStages!=='function' || typeof agTeamRoles!=='function') return [];
  return ['codigo','pagina','documento'].map(k=>{
    const steps=[]; for(const st of kindAgentStages(k, false)){ const a=byId[st.agentId]||agents.find(x=>x.role===st.role); if(a&&a.id) steps.push(a.id); }
    const roles=agTeamRoles(steps, byId, true);
    const cost=(typeof agTeamCost==='function' && typeof agAvgByRole==='function' && typeof AGS!=='undefined')?agTeamCost(roles, agAvgByRole(AGS.rows||[])):null;
    return { k, name:(typeof KIND_TEAM!=='undefined'&&KIND_TEAM[k])||k, kind:(typeof KIND_LABEL!=='undefined'&&KIND_LABEL[k])||k, names:roles.map(r=>r.name), cost };
  });
}
function padAgRender(){
  const pg=$id('padAgPage'); if(!pg) return;
  padOldPark('agOverlay');
  if(PADA.adv){
    pg.innerHTML=`<div class="pgbody pad-body"><button class="pad-back" id="padAgAdvBack">${padIc('back')}Agentes</button><p class="pad-d">Criar e remover agentes, nome, cor e papel, montar equipes e o catálogo do time. Salvar cria uma versão nova de cada agente alterado.</p><div id="padAgAdvHost" class="pad-advhost"></div></div>`;
    padOldMount('padAgAdvHost', 'agOverlay', PADA.advFresh?()=>{ PADA.advFresh=false; if(window.openAgents) window.openAgents(); }:null);
    bindClick('padAgAdvBack', async()=>{ if(typeof agDirty==='function' && agDirty() && !await askYes('Descartar as mudanças nos agentes e equipes?\n\nNada foi salvo ainda.')) return; if(typeof agBase!=='undefined') agBase=''; PADA.adv=false; padOldPark('agOverlay'); padAgOpen(); });
    return; }
  if(PADA.sel && padAgById()[PADA.sel]) return padAgDetailRender(pg);
  PADA.sel=null;
  const agents=(PADA.cfg&&PADA.cfg.agents)||[];
  const w=padAgWarn();
  const strip=w?`<div class="pad-strip amb" role="note">${padIc('alert')}<span><b>${padE(w.reviewer.name)} revisa com o mesmo modelo de quem constrói</b> (${padE(w.producer?w.producer.name:'')}${w.producer?', ':''}${padE(padAgModel(w.reviewer))}, na equipe "${padE(w.team)}"). A revisão fica menos independente.</span><span class="pad-sp"></span><button class="btn sm" data-padag="${padA(w.reviewer.agentId||w.reviewer.id)}" data-padagtab="papel">Resolver</button></div>`:'';
  const cards=agents.map(a=>{ const v=padAgView(a), ver=padAgVer(a.id);
    return `<button class="pad-agc" data-padag="${padA(a.id)}">${padAgAv(a)}<span class="pad-agn">${padE(a.name||a.id)} <span class="pad-faint">· ${padE(padAgRole(a))}</span></span>
      <span class="pad-agr">${padE(typeof agDoes==='function'?agDoes(a):'')}</span>
      <span class="pad-agm"><span class="pad-tag">${padE(padAgModel(a))}</span>${ver!=null?`<span class="pad-tag">v${padE(ver)}</span>`:''}<span>${padE(v?padAgStat(v, a.role):'lendo…')}</span></span></button>`; }).join('');
  const teams=padAgReadyTeams();
  const fmt=(typeof agUsdBr==='function')?agUsdBr:(n=>'US$ '+n);
  pg.innerHTML=padAgHeadHtml()+`<div class="pgbody pad-body">${PADA.err?`<p class="pad-err">${padE(PADA.err)}</p>`:''}${strip}
    <div class="pad-agcards">${cards||'<p class="pad-empty">Nenhum agente neste projeto.</p>'}</div>
    <div class="pad-sech"><h2>Equipes prontas</h2><span>quem entra em cada tipo de demanda</span></div>
    <div class="pad-teams">${teams.map(t=>`<div class="pad-panel pad-team"><h2>${padE(t.name)}</h2><p class="pad-d">${padE(t.kind)} · ${padE(t.names.join(' → ')||'faltam agentes')} · ${t.cost?padE(fmt(t.cost.usd))+' em média':'ainda sem custo medido'}</p></div>`).join('')}</div></div>`;
  pg.querySelectorAll('[data-padag]').forEach(b=>b.onclick=()=>padAgOpenOne(b.dataset.padag, b.dataset.padagtab||'papel'));
  bindClick('padAgAdv', ()=>{ PADA.adv=true; PADA.advFresh=true; padAgRender(); });
  padArrows(pg.querySelector('.pad-agcards')||pg, '.pad-agc');
}
function padAgOpenOne(id, tab){
  PADA.sel=id; PADA.tab=tab||'papel'; PADA.draft=null;
  const repo=state.repo||'';
  padAgRender();
  if(typeof sampleLoad==='function') sampleLoad(repo, id).then(()=>{ if(PADA.sel===id && padTabOn('agentes')) padAgRender(); }).catch(()=>{});
  const h=$id('padAgPage').querySelector('.pad-back'); if(h) h.focus();
}
function padAgEngines(a){
  const engs=(typeof AI_ENGINES!=='undefined'?AI_ENGINES:[{ id:'claude', name:'Claude', models:[] }]).filter(e=>e.id!=='mock'||a.engine==='mock');
  const out=[];
  for(const e of engs){ const ms=(e.models&&e.models.length)?e.models:[{ id:'', name:'padrão' }]; for(const m of ms) out.push({ v:e.id+'|'+(m.id||''), label:padModelLabel(e.id, m.id||'') }); }
  const cur=(a.engine||'claude')+'|'+(a.model||''); if(!out.some(o=>o.v===cur)) out.unshift({ v:cur, label:padModelLabel(a.engine||'claude', a.model||'') });
  return out;
}
function padModelLabel(e, m){ return (typeof aiRunLabel==='function')?aiRunLabel(e, m):e+(m?' · '+m:''); }
function padAgDetailRender(pg){
  const a=padAgById()[PADA.sel]; const card=PADA.cards[a.id]||{};
  const ver=padAgVer(a.id); const v=padAgView(a);
  const tabs=[['papel','Papel e modelo'],['versoes','Versões'],['aprend','Aprendizados'],['desemp','Desempenho']];
  let body='';
  if(PADA.tab==='papel') body=padAgPapelHtml(a, ver);
  else if(PADA.tab==='versoes') body=padAgVersHtml(a, card);
  else if(PADA.tab==='aprend') body=padAgLearnHtml(a, card);
  else body=padAgDesempHtml(a);
  pg.innerHTML=`<div class="pgbody pad-body pad-agdet"><button class="pad-back" id="padAgBack">${padIc('back')}Agentes</button>
    <div class="pad-aghead">${padAgAv(a, true)}<div><h1 class="pgh-title">${padE(a.name||a.id)} · ${padE(padAgRole(a))}</h1><div class="pad-muted">${padE(padAgModel(a))}${ver!=null?' · versão '+padE(ver):''} · ${padE(v?padAgStat(v, a.role):'lendo o que já fez…')}</div></div></div>
    <div class="pad-viewsw" role="tablist" aria-label="${padA('Ficha de '+(a.name||''))}">${tabs.map(([k,l])=>`<button role="tab" id="padagt-${k}" aria-selected="${PADA.tab===k}" aria-pressed="${PADA.tab===k}" tabindex="${PADA.tab===k?0:-1}" data-padagtab="${k}">${padE(l)}</button>`).join('')}</div>
    <div role="tabpanel" aria-labelledby="padagt-${PADA.tab}">${body}</div></div>`;
  padAgDetailWire(pg, a, ver);
}
function padAgPapelHtml(a, ver){
  const dr=PADA.draft, cur=(a.engine||'claude')+'|'+(a.model||'');
  const sel=dr?dr.em:cur; const persona=dr&&dr.persona!=null?dr.persona:(a.persona||'');
  const nxt=(ver||1)+1;
  let draft='';
  if(dr){
    const [ne, nm]=dr.em.split('|'); const mChanged=dr.em!==cur, pChanged=dr.persona!=null && dr.persona!==(a.persona||'');
    const what=[mChanged?padModelLabel(a.engine||'claude', a.model||'')+' → '+padModelLabel(ne, nm):'', pChanged?'instruções novas':''].filter(Boolean).join(' · ');
    const rows=(typeof AGS!=='undefined'&&AGS.rows)||[];
    const est=(typeof sampleEstimate==='function')?sampleEstimate(rows, a.id):null;
    const cand=(typeof sampleCandidates==='function')?sampleCandidates(rows, a.id, 8):[];
    const res=((typeof SMP!=='undefined'&&SMP.id===a.id&&SMP.list)||[]).filter(r=>r.draft && (r.draft.model||'')===(nm||'') && (r.draft.engine||'')===(ne||''));
    const table=res.length?`<table class="pad-sample"><thead><tr><th scope="col">Revisão passada</th><th scope="col">v${padE(ver||1)} · ${padE(padModelLabel(a.engine||'claude', a.model||''))}</th><th scope="col">v${padE(nxt)} · ${padE(padModelLabel(ne, nm))}</th></tr></thead><tbody>${res.slice(0,6).map(r=>`<tr><td>${padE(r.title||r.taskId)}</td><td>${padE(sampleVerdictText(r.old))}</td><td class="${r.old&&r.now&&r.old.kind!==r.now.kind?'up':''}">${padE(sampleVerdictText(r.now))}${r.stopped?' · parou no teto':''}</td></tr>`).join('')}</tbody></table>`:'';
    const sample=a.role!=='reviewer'?`<p class="pad-d">Por enquanto a amostra existe só pro revisor. Salve a versão e acompanhe em Desempenho — dá pra voltar com 1 clique.</p>`
      :!cand.length?`<p class="pad-d">${padE(a.name)} ainda não revisou nenhuma tarefa deste projeto — a amostra precisa de uma revisão passada.</p>`
      :`<div class="pad-smprow"><label class="pad-l" for="padSmpSel">Revisão passada</label><select class="in pad-sel" id="padSmpSel"${PADA.running?' disabled':''}>${cand.map(c=>`<option value="${padA(c.taskId)}">${padE(c.title)}</option>`).join('')}</select>
        <button class="btn ${res.length?'':'primary'}" id="padSmpRun"${PADA.running?' disabled':''}>${PADA.running?'testando…':padIc('play')+'Testar numa amostra'}</button></div>`;
    const cost=est?`Antes de salvar, rode o ${padE(a.name)} novo em cópias de revisões passadas. Não mexe em nada real; custa cerca de ${padE(est.text)} cada (teto ${padE(polUsd(est.cap))}).`:'';
    draft=`<div class="pad-panel pad-draft"><h2>Rascunho da versão ${padE(nxt)}: ${padE(what||'sem mudança')}</h2><p class="pad-d">${cost}${pChanged&&mChanged?' A amostra usa as instruções salvas; o modelo novo vale.':''}</p>
      ${PADA.running?`<p class="pad-run" role="status">testando na tarefa "${padE(PADA.running)}" — leva alguns minutos; pode sair daqui, o resultado fica guardado.</p>`:''}
      ${table}${sample}
      <div class="pad-btnrow"><button class="btn ${res.length||a.role!=='reviewer'?'primary':''}" id="padAgSave">Salvar como versão ${padE(nxt)}</button><button class="btn quiet" id="padAgDiscard">Descartar rascunho</button></div></div>`;
  }
  const opts=padAgEngines(a).map(o=>`<option value="${padA(o.v)}"${o.v===sel?' selected':''}>${padE(o.label)}</option>`).join('');
  return `<div class="pad-panel"><h2>Papel</h2><p class="pad-d">${padE(typeof agDoes==='function'?agDoes(a):'')}</p>
    <label class="pad-field"><span class="pad-l">Modelo de IA<span>trocar cria uma versão nova</span></span><select class="in pad-sel" id="padAgModel">${opts}</select></label>
    <label class="pad-field"><span class="pad-l">Instruções<span>o jeito dele trabalhar</span></span><textarea class="in pad-ta" id="padAgPersona" rows="5">${padE(persona)}</textarea></label></div>${draft}`;
}
function padAgVersHtml(a, card){
  const vs=((card.versions&&card.versions.versions)||[]).slice().reverse(); const cur=padAgVer(a.id);
  if(!vs.length) return `<div class="pad-panel"><h2>Versões</h2><p class="pad-d">Cada mudança vira uma versão. Dá para voltar para a anterior.</p><p class="pad-empty">${padE(a.name)} ainda está na primeira versão.</p></div>`;
  const diff=x=>{ if(x.persona!=null && x.before!=null && typeof agLineDiff==='function') return agLineDiff(x.before, x.persona).filter(l=>l.t!=='=').slice(0,12).map(l=>`<div class="${l.t==='+'?'a':'d'}">${l.t==='+'?'+ ':'− '}${padE(l.s)}</div>`).join('');
    const m=/(.+?)\s*(?:→|->)\s*(.+)/.exec(String(x.what||'')); return m&&['modelo','motor'].includes(x.change)?`<div class="d">− ${padE(x.change)}: ${padE(m[1].replace(/^[^:]*:\s*/,''))}</div><div class="a">+ ${padE(x.change)}: ${padE(m[2])}</div>`:''; };
  return `<div class="pad-panel"><h2>Versões</h2><p class="pad-d">Cada mudança vira uma versão. Dá para voltar para a anterior.</p>${vs.map((x,i)=>{ const d=diff(x);
    const back=i===0&&['persona','modelo','motor'].includes(x.change)?`<button class="btn sm" data-padrevert="1">Voltar pro jeito antigo</button>`:(x.persona!=null&&x.v!==cur?`<button class="btn sm" data-padrestore="${padA(x.v)}">Voltar para esta</button>`:'');
    return `<div class="pad-ver"><div class="pad-verh"><b>v${padE(x.v)}</b>${x.v===cur?'<span class="pad-tag g">atual</span>':''}<span class="pad-muted">${padE(padWhen(x.at))} · ${padE(x.by||x.what||x.change||'')}${x.by&&x.what?' · '+padE(x.what):''}</span><span class="pad-sp"></span>${back}</div>${d?`<div class="pad-vdiff">${d}</div>`:''}</div>`; }).join('')}</div>`;
}
function padAgLearnHtml(a, card){
  const L=card.learnings||{}; const notes=(L.notes||[]).filter(n=>!n.forgottenAt), skills=L.skills||[];
  const pend=(PADA.pend||[]).filter(p=>String(p.agente||'')===a.id).length;
  const title=id=>{ const t=(state.tasks||[]).find(x=>x.id===id); return t?t.title:id; };
  const rows=[...notes.map(n=>({ t:n.title, by:a.name, from:n.taskId?'da tarefa «'+title(n.taskId)+'»':'', at:n.at, st:'guardado' })),
    ...skills.map(s=>({ t:'Um jeito de fazer: '+String(s.name).replace(/-/g,' ')+(s.description?' — '+s.description:''), by:a.name, from:'skill v'+((s.history&&s.history.current)||1), at:0, st:'guardado' }))];
  return `<div class="pad-panel"><h2>Aprendizados</h2><p class="pad-d">O que ${padE(a.name)} aprendeu nas retros, com dono. ${pend?`<b>${pend}</b> ${pend===1?'espera':'esperam'} aprovação em `:'Os que esperam aprovação ficam em '}<button class="pad-link" id="padAgMemRev">Memória › Pra revisar</button>.</p>
    ${rows.length?rows.map(r=>`<div class="pad-row"><span class="pad-rt"><b>${padE(r.t)}</b><span>de ${padE(r.by)}${r.from?' · '+padE(r.from):''}${r.at?' · '+padE(padWhen(r.at)):''}</span></span><span class="pad-tag g">${padE(r.st)}</span></div>`).join(''):'<p class="pad-empty">Nada ainda.</p>'}</div>`;
}
function padAgDesempHtml(a){
  const rows=(typeof AGS!=='undefined'&&AGS.rows||[]).filter(r=>r.agentId===a.id);
  const per=(typeof agVerOf==='function')?padAgPerVersion(rows, agVerOf, agFirstTry, agReachedGate):[];
  const cur=padAgVer(a.id); const rev=a.role==='reviewer';
  const cell=(n, of)=>of<5?'ainda medindo':(of<10?n+' de '+of:Math.round(n/of*100)+'% ('+n+' de '+of+')');
  return `<div class="pad-panel"><h2>Antes e depois de cada versão</h2><p class="pad-d">Com menos de 5 tarefas mostramos "ainda medindo"; percentuais só a partir de 10.</p>
    ${per.length?`<table class="pad-sample"><thead><tr><th scope="col">Versão</th><th scope="col">Tarefas</th><th scope="col">${rev?'Achou problema real':'De primeira'}</th><th scope="col">Retrabalho</th></tr></thead><tbody>${per.map(p=>`<tr><td>v${padE(p.v)}${p.v===cur?' (atual)':''}</td><td>${padE(p.tasks)}</td><td>${padE(rev?cell(p.problems, p.tasks):cell(p.first, p.gate))}</td><td>${padE(p.tasks<5?'ainda medindo':p.rework+' de '+p.tasks)}</td></tr>`).join('')}</tbody></table>`
      :`<p class="pad-empty">${padE(a.name)} ainda não trabalhou numa tarefa medida deste projeto.</p>`}</div>`;
}
function padAgDetailWire(pg, a, ver){
  bindClick('padAgBack', ()=>{ PADA.sel=null; PADA.draft=null; padAgRender(); const b=[...$id('padAgPage').querySelectorAll('[data-padag]')].find(x=>x.dataset.padag===a.id); if(b) b.focus(); });
  const tabs=[...pg.querySelectorAll('[data-padagtab]')];
  tabs.forEach((b,i)=>{ b.onclick=()=>{ PADA.tab=b.dataset.padagtab; padAgRender(); const n=$id('padagt-'+PADA.tab); if(n) n.focus(); };
    b.onkeydown=e=>{ const d={ ArrowRight:1, ArrowLeft:-1 }[e.key]; if(!d) return; e.preventDefault(); tabs[(i+d+tabs.length)%tabs.length].click(); }; });
  const ms=$id('padAgModel'); if(ms) ms.onchange=()=>{ const cur=(a.engine||'claude')+'|'+(a.model||''); PADA.draft=Object.assign({ em:cur, persona:null }, PADA.draft||{}, { em:ms.value }); if(PADA.draft.em===cur && PADA.draft.persona==null) PADA.draft=null; padAgRender(); const n=$id('padAgModel'); if(n) n.focus(); };
  const ps=$id('padAgPersona'); if(ps){ ps.oninput=()=>{ const cur=(a.engine||'claude')+'|'+(a.model||''); const had=!!PADA.draft; PADA.draft=Object.assign({ em:cur, persona:null }, PADA.draft||{}, { persona:ps.value }); if(!had){ const pos=ps.selectionStart; padAgRender(); const n=$id('padAgPersona'); if(n){ n.focus(); try{ n.setSelectionRange(pos, pos); }catch(_){ } } } }; }
  bindClick('padAgDiscard', ()=>{ PADA.draft=null; padAgRender(); });
  bindClick('padAgSave', ()=>padAgSaveVersion(a, ver));
  bindClick('padSmpRun', ()=>padAgSample(a));
  bindClick('padAgMemRev', ()=>{ PADM.f='rev'; openTab('memoria'); });
  pg.querySelectorAll('[data-padrevert]').forEach(b=>b.onclick=async()=>{ try{ await invoke('agent_revert',{ repo:state.repo||'', agentId:a.id, reason:'voltou pelos Padrões do time' }); toast('Voltou pro jeito antigo — virou uma versão nova, dá pra desfazer.','ok'); await padAgOpen(); }catch(e){ showErr(e, 'Não consegui voltar'); } });
  pg.querySelectorAll('[data-padrestore]').forEach(b=>b.onclick=async()=>{ try{ await invoke('agent_restore_persona',{ repo:state.repo||'', agentId:a.id, v:+b.dataset.padrestore }); toast('Instruções da v'+b.dataset.padrestore+' de volta — virou uma versão nova.','ok'); await padAgOpen(); }catch(e){ showErr(e, 'Não consegui voltar'); } });
}
async function padAgSample(a){
  if(PADA.running) return;
  const sel=$id('padSmpSel'); const taskId=sel&&sel.value; if(!taskId) return;
  const rows=(typeof AGS!=='undefined'&&AGS.rows)||[]; const est=sampleEstimate(rows, a.id);
  const [engine, model]=(PADA.draft&&PADA.draft.em||'claude|').split('|');
  const title=(sel.selectedOptions&&sel.selectedOptions[0]&&sel.selectedOptions[0].textContent)||taskId;
  if(!await askYes('Testar '+a.name+' com '+padModelLabel(engine, model)+' na revisão de "'+title+'"?\n\nRoda só a revisão, numa cópia descartável da branch. A tarefa original não muda.\n\nCusto estimado: '+est.text+'\nTeto: '+polUsd(est.cap)+' — para se passar disso.')) return;
  const repo=state.repo||''; PADA.running=title; padAgRender();
  try{
    const r=await invoke('agent_sample_review',{ repo, taskId, agentId:a.id, capUsd:est.cap, model:model||null, engine:engine||null });
    if(typeof SMP!=='undefined' && r){ SMP.id=a.id; SMP.repo=repo; SMP.list=[r, ...(SMP.list||[]).filter(x=>x.at!==r.at)]; }
    toast('Amostra pronta: '+sampleCompareText(r)+'.','ok');
  }catch(e){ showErr(e, 'Não consegui testar na amostra'); }
  finally{ PADA.running=''; if(padTabOn('agentes')) padAgRender(); }
}
async function padAgSaveVersion(a, ver){
  const dr=PADA.draft; if(!dr) return;
  const cfg=JSON.parse(JSON.stringify(PADA.cfg)); const ag=cfg.agents.find(x=>x.id===a.id); if(!ag) return;
  const [engine, model]=dr.em.split('|'); const old=padAgModel(a);
  ag.engine=engine||'claude'; if(model) ag.model=model; else delete ag.model;
  if(dr.persona!=null) ag.persona=dr.persona;
  const b=$id('padAgSave'); if(b){ b.disabled=true; b.textContent='salvando…'; }
  try{
    await invoke('save_config',{ config:cfg });
    if(typeof state!=='undefined') state.config=JSON.parse(JSON.stringify(cfg));
    if(typeof lastSig!=='undefined') lastSig='';
    PADA.draft=null; PADA.tab='versoes';
    toast(a.name+' v'+((ver||1)+1)+' salvo'+(old!==padAgModel(ag)?' · próximas tarefas usam '+padAgModel(ag):'')+'.','ok');
    await padAgOpen();
  }catch(e){ showErr(e, 'Não consegui salvar a versão'); if(b){ b.disabled=false; b.textContent='Salvar como versão '+((ver||1)+1); } }
}

// =====================================================================================================================
// MEMÓRIA
// =====================================================================================================================
const PADM={ repo:'', notes:[], arch:[], learn:[], usage:{}, mode:'local', hasTeam:false, f:null, q:'', edit:null, nova:null, cur:false, hist:{}, histOpen:null, hl:null, err:'', loaded:false };
async function padMemLoad(){
  const repo=state.repo||''; PADM.err='';
  if(PADM.repo!==repo){ Object.assign(PADM, { repo, notes:[], arch:[], learn:[], usage:{}, f:PADM.f==='rev'?'rev':null, edit:null, nova:null, hist:{}, histOpen:null, loaded:false }); }
  if(!repo){ PADM.loaded=true; return; }
  try{
    const [list, arch, use, learn]=await Promise.all([ invoke('memory_list',{ repo, withBody:true }), invoke('memory_archived',{ repo }).catch(()=>[]), invoke('memory_usage',{ repo }).catch(()=>({})), invoke('learn_pending',{ repo }).catch(()=>[]) ]);
    if(PADM.repo!==repo) return;
    PADM.notes=(list&&list.notes)||[]; PADM.mode=(list&&list.mode)||'local'; PADM.arch=arch||[]; PADM.usage=use||{}; PADM.learn=learn||[];
    PADM.hasTeam=(typeof memTeamAvailable==='function')?await memTeamAvailable():false;
  }catch(e){ PADM.err=(typeof memErrText==='function')?memErrText(e):String((e&&e.message)||e); }
  PADM.loaded=true;
  if(PADM.f==null) PADM.f=PADM.notes.some(n=>n.scope==='time')?'time':'eu';
  if(typeof memLearnBadge==='function' && repo===state.repo) memLearnBadge(PADM.learn.length);
}
async function padMemOpen(tab){
  padShow('memoria');
  if(tab && tab.sub){ PADM.f=tab.sub==='revisar'?'rev':tab.sub; tab.sub=null; }
  if(typeof MEM!=='undefined' && MEM.view==='revisar'){ PADM.f='rev'; MEM.view='lista'; }
  const pg=$id('padMemPage'); if(!pg) return;
  if(!PADM.loaded || PADM.repo!==(state.repo||'')) pg.innerHTML=padMemHead()+`<div class="pgbody pad-body">${typeof skeletonHtml==='function'?skeletonHtml('lista',{ n:5 }):''}</div>`;
  await padMemLoad();
  padMemRender();
  const r=state.repo;
  if(typeof curLoad==='function' && r) curLoad(r).then(()=>{ if(padTabOn('memoria') && PADM.repo===r) padMemRender(); }).catch(()=>{});
  if(PADM.hasTeam && typeof memTeamSync==='function') memTeamSync().then(ch=>{ if(ch && padTabOn('memoria')) padMemOpen(); }).catch(()=>{});
}
window.padMemOpen=padMemOpen;
function padMemHead(){
  const nm=state.repo?padBase(state.repo):'';
  return pageHead({ title:nm?'Memória de '+nm:'Memória', sub:'O que a IA sabe deste projeto: decisões, regras, cuidados e pessoas. Cada nota tem autor e data.',
    right:state.repo?`<button class="btn" id="padMemNew">${padIc('plus')}Nova nota</button>`:'', more:state.repo?{ id:'padMemMore', title:'Mais: notas ligadas e grafo · Obsidian · onde salvar as notas novas' }:null });
}
function padTypeTone(t){ return { regra:'g', 'decisão':'b', gotcha:'r', pessoa:'a' }[t]||''; }
function padUsedText(key){
  const l=(PADM.usage&&PADM.usage[key])||[]; if(!l.length) return '';
  const ti=id=>{ const t=(state.tasks||[]).find(x=>x.id===id); const s=t?t.title:id; return s.length>28?s.slice(0,27)+'…':s; };
  return 'usada em '+l.slice(0,2).map(x=>ti(x.task)).join(', ')+(l.length>2?' e mais '+(l.length-2):'');
}
function padMemNoteHtml(n, conf){
  const key=n.scope+':'+n.slug, arch=PADM.f==='arq';
  if(PADM.edit && PADM.edit.key===key) return padMemEditorHtml(n);
  const body=String((typeof memPlain==='function'?memPlain(n.summary||''):n.summary)||'');
  const extra=(typeof memParseFm==='function' && n.body)?memParseFm(n.body).data:{};
  const orig=extra.tarefa?'de '+extra.tarefa:n.origem==='agente'?'de uma tarefa (IA)':'escrita à mão';
  const by=n.by?(n.origem==='agente' && !/\(IA\)/.test(n.by)?n.by+' (IA)':n.by):'sem autor';
  const used=padUsedText(key);
  const c=conf&&conf[key];
  const fixed=n.atualizadaPor?`<span class="pad-tag g">corrigida por ${padE(n.atualizadaPor)} · <button class="pad-link" data-padmemhist="${padA(key)}">versão anterior no histórico</button></span>`:'';
  const hist=PADM.histOpen===key?padMemHistHtml(key):'';
  const team=!arch && n.scope==='local' && PADM.hasTeam?`<div class="pad-conf blue">${padIc('users')}<span>Só você tem esta nota. <button class="pad-link" data-padmemteam="${padA(key)}">Virar regra do time?</button></span></div>`:'';
  return `<div class="pad-note${c&&!arch?' warn':''}${PADM.hl===key?' hl':''}" data-padnote="${padA(key)}"><div class="pad-ntx">${padE(n.title)}${body&&body!==n.title?`<span class="pad-nsum">${padE(body)}</span>`:''}</div>
    <div class="pad-nacts">${arch?`<button class="btn sm" data-padmemrest="${padA(key)}">Restaurar</button>`:`<button class="btn sm" data-padmemedit="${padA(key)}">Editar</button><button class="btn sm quiet" data-padmemarch="${padA(key)}">Arquivar</button>`}</div>
    <div class="pad-nm"><span class="pad-tag ${padTypeTone(n.type)}">${padE(typeof memTypeLabel==='function'?memTypeLabel(n.type):n.type)}</span><span>por ${padE(by)}${n.updated?' · '+padE(typeof memDateBR==='function'?memDateBR(n.updated):n.updated):''}</span><span>${padE(orig)}</span><span>${n.scope==='time'?'vale pro time':'só pra mim'}</span>${used?`<span>${padE(used)}</span>`:''}${fixed}${arch&&n.archivedAt?`<span>arquivada ${padE(padWhen(n.archivedAt))}</span>`:''}${typeof memIsNew==='function'&&memIsNew(n)?'<span class="pad-tag b">nova</span>':''}${n.secret?'<span class="pad-tag r">parece ter segredo — não sobe pro time</span>':''}</div>
    ${c&&!arch?`<div class="pad-conf">${padIc('alert')}<span>Pode conflitar com «${padE(c.title)}»${c.by?' (de '+padE(c.by)+')':''}: mesmo assunto, números diferentes. Corrija a que estiver errada.</span></div>`:''}${team}${hist}</div>`;
}
function padMemHistHtml(key){
  const h=PADM.hist[key];
  if(!h) return '<div class="pad-hist dim">lendo o histórico…</div>';
  if(!h.length) return '<div class="pad-hist dim">Sem versões anteriores guardadas.</div>';
  return `<div class="pad-hist">${h.map(x=>{ const f=(typeof memFromFile==='function')?memFromFile(x.content):{ title:'', body:x.content }; return `<div class="pad-histi"><span class="pad-muted">${padE(padWhen(x.at))}${x.by?' · antes da correção de '+padE(x.by):''}</span><div><b>${padE(f.title)}</b> ${padE(String(f.body||'').slice(0,240))}</div></div>`; }).join('')}</div>`;
}
function padMemEditorHtml(n){
  const e=PADM.edit;
  return `<div class="pad-note editing" data-padnote="${padA(e.key||'nova')}">
    <label class="pad-field"><span class="pad-l">O que a IA deve saber</span><input class="in" id="padMemT" value="${padA(e.title)}" placeholder="ex.: Frete grátis a partir de R$ 199 no carrinho"></label>
    <label class="pad-field"><span class="pad-l">Detalhe <span>opcional · [[nome-da-nota]] liga com outra</span></span><textarea class="in pad-ta" id="padMemB" rows="4">${padE(e.body)}</textarea></label>
    <div class="pad-nm pad-editrow"><select class="in pad-sel" id="padMemTy" aria-label="Tipo da nota">${(typeof MEM_TYPES!=='undefined'?MEM_TYPES:['regra','decisão','gotcha','contexto','pessoa','glossário']).map(t=>`<option value="${padA(t)}"${t===e.type?' selected':''}>${padE(typeof memTypeLabel==='function'?memTypeLabel(t):t)}</option>`).join('')}</select>
      ${!e.key&&PADM.hasTeam?`<label class="pad-chk"><input type="checkbox" id="padMemTeam"${e.scope==='time'?' checked':''}> vale pro time</label>`:''}
      <span>${e.key?padIc('alert')+'A versão anterior fica no histórico. Próximas tarefas usam a nova.':'Entra nas próximas tarefas deste projeto.'}</span><span class="pad-sp"></span>
      <button class="btn sm quiet" id="padMemCancel">Cancelar</button><button class="btn sm primary" id="padMemSave">${e.key?'Salvar correção':'Salvar nota'}</button></div></div>`;
}
function padMemRender(){
  const pg=$id('padMemPage'); if(!pg) return;
  padOldPark('memOverlay');
  if(PADM.adv && state.repo){
    pg.innerHTML=`<div class="pgbody pad-body"><button class="pad-back" id="padMemAdvBack">${padIc('back')}Memória</button><div id="padMemAdvHost" class="pad-advhost"></div></div>`;
    padOldMount('padMemAdvHost', 'memOverlay', ()=>{ if(typeof MEM!=='undefined') MEM.view='lista'; if(window.openMemoria) window.openMemoria(); });
    bindClick('padMemAdvBack', ()=>{ PADM.adv=false; padOldPark('memOverlay'); padMemOpen(); });
    return; }
  if(!state.repo){ pg.innerHTML=padMemHead()+`<div class="pgbody pad-body">${typeof emptyHtml==='function'?emptyHtml({ icon:'folder', title:'A memória é de um projeto.', help:'Abra um projeto pra ver o que a IA sabe dele.', action:{ id:'padMemProj', label:'Abrir ou criar projeto' } }):''}</div>`; bindClick('padMemProj', ()=>openTab('projetos')); return; }
  const f=PADM.f||'time';
  const L=f==='rev'?[]:padMemFilter(PADM.notes, PADM.arch, f, PADM.q);
  const conf=padMemConflicts(PADM.notes);
  const nConf=Object.keys(conf).length/2|0;
  const curS=(typeof CUR!=='undefined' && CUR.repo===PADM.repo && CUR.data && CUR.data.suggestions)||[];
  const curTxt=[curS.length&&typeof curSummary==='function'?curSummary(curS):'', nConf?(nConf===1?'1 par de notas pode se contradizer':nConf+' pares de notas podem se contradizer'):''].filter(Boolean).join(' · ');
  const nAgent=PADM.mode==='so-local'?PADM.notes.filter(n=>n.scope==='local').length:PADM.notes.length;
  const chips=[['time','Do time'],['eu','Só minhas'],['rev','Pra revisar ('+PADM.learn.length+')'],['arq','Arquivadas']];
  let list='';
  if(f==='rev'){
    list=(PADM.learn.length&&typeof memLearnHtml==='function'?memLearnHtml(PADM.learn, typeof LEARN_EDIT!=='undefined'?LEARN_EDIT:{}):'<p class="pad-empty">Nenhum aprendizado esperando. Quando a retro de uma tarefa propuser algo, aparece aqui — nada entra sem o seu sim.</p>')
      +'<details class="pad-agmem"><summary>O que cada agente lembra</summary><div id="padMemAgHost"></div></details>';
  } else {
    list=(PADM.nova?padMemEditorHtml(null):'')+(L.map(n=>padMemNoteHtml(n, conf)).join('')||`<p class="pad-empty">${PADM.q?'Nada encontrado.':f==='arq'?'Nenhuma nota arquivada.':f==='eu'?'Nenhuma nota só sua neste projeto.':'Nenhuma nota do time ainda. '+(PADM.hasTeam?'':'Este projeto ainda não está num time — as notas ficam em "Só minhas".')}</p>`);
  }
  const strip=(f==='time'||f==='eu')&&!PADM.q&&(curTxt||PADM.cur)?`<div class="pad-strip">${padIc('spark')}<span><b>Arrumar a memória:</b> ${padE(String(curTxt||'nada a arrumar agora').replace(/\s*—\s*revisar\?/g,'').replace(/[.?!]+$/,''))}.</span><span class="pad-sp"></span><button class="btn sm quiet" id="padMemCur" aria-expanded="${!!PADM.cur}">${PADM.cur?'Esconder':'Ver sugestões'}</button></div>${PADM.cur?`<div class="pad-cur">${typeof curHtml==='function'?curHtml(null):''}${nConf?`<p class="pad-d">Os pares que podem se contradizer aparecem marcados em âmbar na lista — corrija a nota errada ou arquive.</p>`:''}</div>`:''}`:'';
  pg.innerHTML=padMemHead()+`<div class="pgbody pad-body">${PADM.err?`<p class="pad-err">Não consegui ler a memória — ${padE(PADM.err)}</p>`:''}
    <div class="pad-prompt">${padIc('spark')}<span><b>A IA lê estas notas no começo de cada tarefa de ${padE(padBase(state.repo))}.</b> As do time valem para todos; as "só pra mim", só nas suas tarefas. Cada tarefa mostra quais notas usou. <details class="pad-det-inline"><summary>detalhes</summary> Vão o índice das ${nAgent} ${nAgent===1?'nota':'notas'} (até 2.500 caracteres) e as que combinam com o pedido (até 6.000). As regras entram sempre.${PADM.mode==='so-local'?' Neste computador os agentes ignoram as notas do time (modo só local).':''}</details></span></div>
    <div class="pad-memtools"><label class="pad-search">${padIc('search')}<input id="padMemQ" placeholder="buscar nas notas…" value="${padA(PADM.q)}" aria-label="Buscar nas notas" spellcheck="false"></label>
      <div class="pad-fchips" role="group" aria-label="Filtrar notas">${chips.map(([k,l])=>`<button aria-pressed="${f===k}" data-padmemf="${k}">${padE(l)}</button>`).join('')}</div></div>
    ${strip}<div class="pad-notes" id="padMemList">${list}</div></div>`;
  padMemWire(pg);
}
function padMemFind(key){ return [...PADM.notes, ...PADM.arch].find(n=>n.scope+':'+n.slug===key)||null; }
function padMemWire(pg){
  { const mb=$id('padMemMore'); if(mb) mb.onclick=()=>padMemMoreMenu(mb); }
  bindClick('padMemNew', ()=>{ PADM.f=PADM.f==='rev'||PADM.f==='arq'?(PADM.hasTeam?'time':'eu'):PADM.f; PADM.edit={ key:null, title:'', body:'', type:'regra', scope:PADM.mode==='time'&&PADM.hasTeam?'time':'local' }; PADM.nova=true; padMemRender(); const t=$id('padMemT'); if(t) t.focus(); });
  pg.querySelectorAll('[data-padmemf]').forEach(b=>b.onclick=()=>{ PADM.f=b.dataset.padmemf; PADM.edit=null; PADM.nova=null; padMemRender(); const n=$id('padMemPage').querySelector(`[data-padmemf="${PADM.f}"]`); if(n) n.focus(); });
  padArrows(pg.querySelector('.pad-memtools .pad-fchips')||pg, '[data-padmemf]');
  const q=$id('padMemQ'); if(q) q.oninput=()=>{ PADM.q=q.value; const pos=q.selectionStart; padMemRender(); const n=$id('padMemQ'); if(n){ n.focus(); try{ n.setSelectionRange(pos, pos); }catch(_){ } } };
  bindClick('padMemCur', ()=>{ PADM.cur=!PADM.cur; padMemRender(); const b=$id('padMemCur'); if(b) b.focus(); });
  if(PADM.cur && typeof curWire==='function') curWire(pg, { repo:()=>PADM.repo, after:async()=>{ await padMemLoad(); padMemRender(); } });
  pg.querySelectorAll('[data-padmemedit]').forEach(b=>b.onclick=()=>padMemStartEdit(b.dataset.padmemedit));
  pg.querySelectorAll('[data-padmemarch]').forEach(b=>b.onclick=()=>padMemArchive(b.dataset.padmemarch));
  pg.querySelectorAll('[data-padmemrest]').forEach(b=>b.onclick=()=>padMemRestore(b.dataset.padmemrest));
  pg.querySelectorAll('[data-padmemteam]').forEach(b=>b.onclick=()=>padMemToTeam(b.dataset.padmemteam));
  pg.querySelectorAll('[data-padmemhist]').forEach(b=>b.onclick=()=>padMemHist(b.dataset.padmemhist));
  bindClick('padMemCancel', ()=>{ PADM.edit=null; PADM.nova=null; padMemRender(); });
  bindClick('padMemSave', padMemSave);
  const ed=pg.querySelector('.pad-note.editing'); if(ed) ed.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.stopPropagation(); PADM.edit=null; PADM.nova=null; padMemRender(); } if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); padMemSave(); } });
  if(PADM.f==='rev'){
    if(typeof learnWire==='function') learnWire(pg, { repo:()=>PADM.repo, items:()=>PADM.learn, after:async()=>{ await padMemLoad(); padMemRender(); }, repaint:padMemRender });
    const host=$id('padMemAgHost'); const det=host&&host.closest('details');
    if(det) det.addEventListener('toggle', ()=>{ if(det.open && typeof agMemHostRender==='function') agMemHostRender(host); }, { once:true });
  }
}
function padMemMoreMenu(anchor){
  const repo=PADM.repo, mode=PADM.mode;
  const setMode=async(m)=>{ if(typeof memSetMode==='function'){ await memSetMode(m, repo); } await padMemLoad(); padMemRender(); };
  const items=[
    { label:'Notas ligadas e grafo', hint:'a visão completa: [[links]], grafo, mover e apagar', act:()=>{ PADM.adv=true; padMemRender(); } },
    { label:'Abrir no Obsidian', hint:'a pasta .cardume/memoria vira um cofre', act:async()=>{ try{ const how=await invoke('memory_open_obsidian',{ repo }); if(how==='pasta') toast('Abri a pasta da memória. No Obsidian: "Abrir pasta como cofre" → escolha .cardume/memoria.','warn'); }catch(e){ showErr(e, 'Não consegui abrir no Obsidian'); } } },
    { sep:true },
    ...[['time','Notas novas vão pro time','sincroniza com todos'],['local','Notas novas ficam neste computador','os agentes ainda leem as do time'],['so-local','Só local','os agentes ignoram as notas do time']]
      .filter(([m])=>m!=='time' || PADM.hasTeam).map(([m,l,h])=>({ label:l, ic:mode===m?'check':undefined, hint:h, act:()=>setMode(m) })),
  ];
  if(PADM.hasTeam && typeof memTeamSync==='function') items.push({ sep:true }, { label:'Sincronizar com o time agora', act:async()=>{ await memTeamSync(); await padMemLoad(); padMemRender(); toast('Memória do time sincronizada.','ok'); } });
  if(typeof g1Menu==='function') g1Menu(anchor, items);
}
async function padMemStartEdit(key){
  const n=padMemFind(key); if(!n) return;
  let f={ title:n.title, body:'', type:n.type, extra:{} }, mt=0;
  try{ const r=await invoke('memory_read',{ repo:PADM.repo, scope:n.scope, slug:n.slug }); f=memFromFile(r.content); mt=r.mtimeMs||0; }catch(e){ showErr(e, 'Não consegui abrir a nota'); return; }
  PADM.nova=null; PADM.edit={ key, scope:n.scope, slug:n.slug, title:f.title||n.title, body:f.body||'', type:f.type||n.type, tags:f.tags||[], by:f.by, origem:f.origem, extra:f.extra||{}, mtime:mt };
  padMemRender(); const t=$id('padMemT'); if(t){ t.focus(); t.select(); }
}
async function padMemSave(){
  const e=PADM.edit; if(!e) return;
  const title=(($id('padMemT')||{}).value||'').trim(), body=(($id('padMemB')||{}).value||'').trim(), type=($id('padMemTy')||{}).value||e.type||'contexto';
  if(!title){ toast('Escreva o que a IA deve saber.','warn'); const t=$id('padMemT'); if(t) t.focus(); return; }
  const me=padMe(), repo=PADM.repo;
  const scope=e.key?e.scope:(($id('padMemTeam')||{}).checked?'time':'local');
  const note={ title, type, tags:e.tags||[], updated:(typeof memToday==='function'?memToday():''), body:body||title, extra:e.extra||{},
    by:e.key&&e.by?e.by:me, origem:e.key&&e.by?(e.origem||'pessoa'):'pessoa', atualizadaPor:e.key?me:'' };
  const b=$id('padMemSave'); if(b){ b.disabled=true; b.textContent='salvando…'; }
  try{
    if(e.key) await invoke('memory_snapshot',{ repo, scope:e.scope, slug:e.slug, by:me });
    const r=await invoke('memory_write',{ repo, scope, slug:e.key?e.slug:null, content:memSerialize(note), expectMtime:e.mtime||null, create:!e.key });
    PADM.edit=null; PADM.nova=null; PADM.hl=r.scope+':'+r.slug; delete PADM.hist[PADM.hl];
    toast(e.key?'Nota corrigida · as próximas tarefas usam a versão nova':'Nota salva · entra nas próximas tarefas','ok');
    if(r.conflict) toast('Um agente atualizou esta nota enquanto você editava — a sua versão (a mais recente) foi salva.','warn');
    await padMemLoad(); padMemRender(); setTimeout(()=>{ PADM.hl=null; }, 2500);
    if(r.scope==='time' && PADM.hasTeam && typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(err){ showErr((typeof memErr==='function')?memErr(err):err, 'Não consegui salvar a nota'); const bb=$id('padMemSave'); if(bb){ bb.disabled=false; bb.textContent=e.key?'Salvar correção':'Salvar nota'; } }
}
async function padMemArchive(key){
  const n=padMemFind(key); if(!n) return;
  try{
    await invoke('memory_archive',{ repo:PADM.repo, scope:n.scope, slug:n.slug });
    if(n.scope==='time' && typeof memCloudTombstone==='function') await memCloudTombstone(PADM.repo, n.slug);
    toast('Arquivada · sai das próximas tarefas. Nada é apagado.','ok', { label:'desfazer', fn:()=>padMemRestore('time'===n.scope?'time:'+n.slug:'local:'+n.slug, true) });
    await padMemLoad(); padMemRender();
  }catch(e){ showErr(e, 'Não consegui arquivar'); }
}
async function padMemRestore(key, quiet){
  const [scope, ...rest]=String(key).split(':'); const slug=rest.join(':');
  try{
    await invoke('memory_unarchive',{ repo:PADM.repo, scope, slug });
    if(!quiet) toast('Restaurada · volta a entrar nas tarefas.','ok');
    await padMemLoad(); padMemRender();
    if(scope==='time' && PADM.hasTeam && typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(e){ showErr(e, 'Não consegui restaurar'); }
}
async function padMemToTeam(key){
  const n=padMemFind(key); if(!n) return;
  if(!await askYes('"'+n.title+'" passa a valer pro time inteiro, como regra.\n\nTodo mundo que roda tarefa neste projeto recebe a nota.')) return;
  try{
    if(typeof memTeamSync==='function') await memTeamSync();
    const r=await invoke('memory_move',{ repo:PADM.repo, slug:n.slug, from:'local', to:'time' });
    const cur=await invoke('memory_read',{ repo:PADM.repo, scope:'time', slug:r.slug }); const f=memFromFile(cur.content);
    if(f.type!=='regra') await invoke('memory_write',{ repo:PADM.repo, scope:'time', slug:r.slug, content:memSerialize(Object.assign({}, f, { type:'regra', atualizadaPor:padMe(), updated:memToday() })), expectMtime:cur.mtimeMs||null, create:false });
    toast('Virou regra do time · vale nas tarefas de todos','ok');
    PADM.f='time'; await padMemLoad(); padMemRender();
    if(typeof memTeamSync==='function') memTeamSync().catch(()=>{});
  }catch(e){ showErr(e, 'Não consegui levar pro time'); }
}
async function padMemHist(key){
  if(PADM.histOpen===key){ PADM.histOpen=null; padMemRender(); return; }
  PADM.histOpen=key; padMemRender();
  const [scope, ...rest]=key.split(':');
  try{ PADM.hist[key]=await invoke('memory_history',{ repo:PADM.repo, scope, slug:rest.join(':') })||[]; }catch(_){ PADM.hist[key]=[]; }
  if(padTabOn('memoria')) padMemRender();
}
// ---------- ganchos da tarefa: "N notas de memória" e "Isso está errado"
async function padMemoriaDaTarefa(taskId){
  const repo=state.repo||''; if(!repo || !taskId) return [];
  try{
    const [use, list]=await Promise.all([ invokeQuiet('memory_usage',{ repo }), invokeQuiet('memory_list',{ repo, withBody:false }) ]);
    const notes=(list&&list.notes)||[];
    return Object.entries(use||{}).filter(([,l])=>(l||[]).some(x=>x.task===taskId)).map(([k])=>notes.find(n=>n.scope+':'+n.slug===k)).filter(Boolean)
      .map(n=>({ scope:n.scope, slug:n.slug, title:n.title, by:n.by, updated:n.updated, type:n.type }));
  }catch(_){ return []; }
}
window.padMemoriaDaTarefa=padMemoriaDaTarefa;
async function padMemoriaErrada(scope, slug){
  PADM.f=scope==='local'?'eu':'time'; PADM.q='';
  openTab('memoria');
  const key=scope+':'+slug;
  for(let i=0;i<20 && !(PADM.loaded && PADM.repo===(state.repo||'')); i++) await new Promise(r=>setTimeout(r, 100));
  await padMemStartEdit(key);
  const el=document.querySelector(`#padMemPage [data-padnote="${CSS.escape(key)}"]`); if(el && el.scrollIntoView) el.scrollIntoView({ block:'center' });
}
window.padMemoriaErrada=padMemoriaErrada;

// "/" foca a busca da Memória (fora de campo de texto e do terminal); Esc fecha o editor
document.addEventListener('keydown', e=>{
  if(e.key!=='/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const a=document.activeElement; if(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || (a.closest && a.closest('.xterm')))) return;
  if(!padTabOn('memoria')) return;
  const q=$id('padMemQ'); if(q){ e.preventDefault(); q.focus(); }
});
// trocar de projeto com uma das abas aberta: relê (as três são do projeto atual)
if(typeof render==='function' && !render.__pad){ const r0=render; render=function(){ const out=r0.apply(this, arguments);
    try{
      const repo=state.repo||'';
      if(padTabOn('memoria') && PADM.loaded && PADM.repo!==repo){ PADM.loaded=false; padMemOpen(); }
      if(padTabOn('agentes') && PADA.cfg && PADA.repo!==repo){ PADA.sel=null; padAgOpen(); }
      if(padTabOn('skills') && PADS.data && PADS.lastRepo!==repo){ PADS.lastRepo=repo; padSkRender(); }
    }catch(err){ console.error('padroes render', err); }
    return out; }; render.__pad=true; }
