// Starfork — 68-casca-g1
// ===== REDESENHO F4 · G1 (spec-redesign-f4-todas-as-telas, mocks _bmad-output/redesign/telas/g1-navegacao-projeto.html) =====
// A casca nova: lateral com 4 lugares (Projetos · Issues · Fábrica · Time só com organização), rodapé medidor + avatar
// (menu: Conta e time · Ajustes ⌘, · Uso · Atalhos ? · Primeiros passos · Tema · Sair — o ÚNICO "sair" do app), e as
// páginas novas no padrão único (pageHead, 00-util): Projeto · <nome> (sub-nav lateral: Conversa · Memória · Agentes ·
// Skills · Regras · Espaço em disco), Time (as 5 visões que moravam na Central) e Atalhos (aba, não modal).
// As telas antigas continuam sendo as mesmas funções (openPc, openMemoria, openAgents, openSkills, openPrefs, wsMount,
// renderTeamBoard…): esta casca só decide ONDE elas aparecem. Nada de polling: pinta no render que já existe.
// Ganchos do G3 (chamados guardados): ajustesOpen(section?) e primeirosPassosOpen().

// ---------- ícones da casca (mesmo traço de linha 16px do IC) ----------
// (folder/book só se ainda não existirem no IC — a tabela de 10-core com esses nomes é de <path>, não de <svg>)
if(!IC.folder) IC.folder='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/></svg>';
if(!IC.book) IC.book='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 4.5C6.7 3.7 5 3.5 3.4 3.9v7.9c1.6-.4 3.3-.2 4.6.6m0-9c1.3-.8 3-1 4.6-.6v7.9c-1.6-.4-3.3-.2-4.6.6m0-9v9" stroke-linejoin="round"/></svg>';
Object.assign(IC, {
  dots:'<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.4" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.6" cy="8" r="1.25"/></svg>',
  plus:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.4v9.2M3.4 8h9.2" stroke-linecap="round"/></svg>',
  pc:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.2" y="3" width="11.6" height="7.6" rx="1.2"/><path d="M5.6 13.2h4.8M8 10.6v2.6" stroke-linecap="round"/></svg>',
  user:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="5.8" r="2.6"/><path d="M3 13.4c.4-2.6 2.5-4 5-4s4.6 1.4 5 4" stroke-linecap="round"/></svg>',
  team:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9"/></svg>',
  gear:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8M4 4l1.3 1.3M10.7 10.7L12 12M12 4l-1.3 1.3M5.3 10.7L4 12" stroke-linecap="round"/></svg>',
  chart:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 13.5h11" stroke-linecap="round"/><rect x="3.5" y="8" width="2.2" height="4" rx=".5"/><rect x="6.9" y="5" width="2.2" height="7" rx=".5"/><rect x="10.3" y="2.5" width="2.2" height="9.5" rx=".5"/></svg>',
  kbd:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.8" y="4" width="12.4" height="8" rx="1.4"/><path d="M4.4 6.6h.05M6.8 6.6h.05M9.2 6.6h.05M11.6 6.6h.05M5 9.4h6" stroke-linecap="round"/></svg>',
  exit:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.4 2.8H3.6c-.5 0-.8.3-.8.8v8.8c0 .5.3.8.8.8h2.8M10.4 5.2 13.2 8l-2.8 2.8M13 8H6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sun:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" stroke-linecap="round"/></svg>',
  bot:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="5" width="10" height="7.6" rx="2"/><path d="M8 2.6V5M6 8.4h.05M10 8.4h.05" stroke-linecap="round"/></svg>',
  rule:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 1.9l4.7 1.8v3.6c0 3.1-2.1 5.5-4.7 6.8-2.6-1.3-4.7-3.7-4.7-6.8V3.7z" stroke-linejoin="round"/><path d="M5.8 8l1.6 1.6 2.8-3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  disk:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="4.2" rx="5" ry="1.9"/><path d="M3 4.2v7.6c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V4.2M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9"/></svg>',
});

// ---------- registro das páginas novas na barra de abas ----------
if(typeof VIEW_META!=='undefined'){
  VIEW_META.projeto={ title:'Projeto', icon:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>' };
  VIEW_META.time={ title:'Time', icon:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9"/>' };
  VIEW_META.atalhos={ title:'Atalhos', icon:'<rect x="1.8" y="4" width="12.4" height="8" rx="1.4"/><path d="M5 9.4h6" stroke-linecap="round"/>' };
  if(VIEW_META.cttask) VIEW_META.cttask.title='Tarefa do colega';
  VIEW_OVERLAY.projeto='projOverlay'; VIEW_OVERLAY.time='timeOverlay'; VIEW_OVERLAY.atalhos='atalhosOverlay';
}
if(typeof KEEP_ON_SWITCH!=='undefined'){ KEEP_ON_SWITCH.add('projeto'); KEEP_ON_SWITCH.add('time'); KEEP_ON_SWITCH.add('atalhos'); }
if(typeof viewOpen==='function' && !viewOpen.__g1){ const vo=viewOpen; viewOpen=function(kind, tab){
    if(kind==='projeto') return projPageOpen(tab);
    if(kind==='time') return timePageOpen(tab);
    if(kind==='atalhos') return atalhosOpen();
    if(kind==='issues' && tab && tab.sub){ trkWantView=({ quadro:'board', board:'board', nova:'nova', conexao:'conn', conn:'conn' })[tab.sub]||''; tab.sub=null; }
    return vo.apply(this, arguments); }; viewOpen.__g1=true; }

// ---------- menu ancorado genérico (folha pequena com teclado: ↑↓, Esc devolve o foco) ----------
// items: [{ label, hint?, act(), danger?, sep? , html? }]. Usa o menuWire do 22 (mesmo teclado dos outros menus).
function g1Menu(anchor, items, o){
  o=o||{}; const old=$id('g1menu'); if(old && old.__close) old.__close(); else if(old) old.remove();
  const m=document.createElement('div'); m.id='g1menu'; m.className='g1menu'+(o.cls?' '+o.cls:'');
  items.forEach(it=>{
    if(it.sep){ const hr=document.createElement('div'); hr.className='g1sep'; hr.setAttribute('role','separator'); m.appendChild(hr); return; }
    if(it.html){ const d=document.createElement('div'); d.className='g1mi-html'; d.innerHTML=it.html; m.appendChild(d); if(it.wire) it.wire(d, m); return; }
    const b=document.createElement('button'); b.type='button'; b.className='g1mi'+(it.danger?' danger':'');
    b.innerHTML=(it.ic?`<span class="g1ic" aria-hidden="true">${IC[it.ic]||''}</span>`:'')+`<span class="g1l">${esc(it.label)}</span>`+(it.hint?`<small>${esc(it.hint)}</small>`:'');
    b.onclick=async(e)=>{ e.stopPropagation(); if(it.keep){ await it.act(b, m); return; } if(m.__close) m.__close(); else m.remove(); try{ await it.act(); }catch(err){ showErr(err, 'Não deu certo'); } };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  if(o.up){ m.style.left=Math.max(8, r.left)+'px'; m.style.bottom=Math.max(8, window.innerHeight-r.top+6)+'px'; m.style.width=Math.max(240, r.width)+'px'; }
  else { m.style.top=Math.min(window.innerHeight-m.offsetHeight-8, r.bottom+6)+'px'; m.style.left=Math.max(8, Math.min(window.innerWidth-m.offsetWidth-8, r.right-m.offsetWidth))+'px'; }
  if(typeof mvFromOrigin==='function') mvFromOrigin(m, anchor);
  if(typeof menuWire==='function') menuWire(m, anchor);
  const close0=m.__close; m.__close=()=>{ if(close0) close0(); else m.remove(); if(o.onClose) o.onClose(); };
  return m;
}
window.g1Menu=g1Menu;

// ---------- ganchos do G3 / destinos novos (sempre guardados) ----------
function g1Ajustes(section){ if(typeof ajustesOpen==='function') return ajustesOpen(section); if(section==='conta'||section==='times') return openTab('conta'); if(section==='verificacao') return openTab('env'); return openTab('cfg'); }
function g1PrimeirosPassos(){ if(typeof primeirosPassosOpen==='function') return primeirosPassosOpen(); if(typeof openOnboarding==='function') openOnboarding(); }
// "Novo projeto…" = Fábrica em App novo (D8)
function g1NovoProjeto(){ if(typeof fabOpen==='function') fabOpen('nova',{ mode:'app' }); else openTab('fabrica'); } // início da Fábrica em App novo (API do 65, G2)
window.g1NovoProjeto=g1NovoProjeto;

// ===================== RODAPÉ: avatar + menu do avatar (D6) =====================
// @puro-avatar-inicio (testado em app/tests/redesign-f4-g1.test.mjs)
// quem está logado → { name, sub, ini, org } (sem sessão: "Entrar"); sub = "Organização · Time" ou "sem organização"
function meInfoOf(sess, data, teamId){
  if(!sess) return { name:'Entrar', sub:'sua conta e o time', ini:'?', org:null, signed:false };
  const u=sess.user||{}, meta=u.user_metadata||{};
  const prof=data&&data.profileByUser&&data.profileByUser[u.id];
  const name=(prof&&prof.name)||meta.name||meta.full_name||String(u.email||'Conta').split('@')[0];
  const parts=String(name).trim().split(/\s+/).filter(Boolean);
  const ini=((parts[0]||'?')[0]+(parts.length>1?parts[parts.length-1][0]:'')).toUpperCase();
  const org=(data&&data.org)||null;
  const team=org&&data.teams?(data.teams.find(t=>t.id===teamId)||null):null;
  return { name, ini, org, signed:true, team, sub:org?(org.name+(team?' · Time '+team.name:'')):'sem organização' };
}
// itens do menu (sem as ações): quem não tem org ganha "Criar ou entrar num time"; "Publicar release" só pra dev/admin
function meMenuItemsOf(info, o){
  o=o||{}; const it=[];
  if(!info.signed) it.push({ k:'entrar', label:'Entrar ou criar conta', ic:'user' });
  else it.push({ k:'conta', label:'Conta e time', hint:'perfil, organização', ic:'team' });
  if(info.signed && !info.org) it.push({ k:'times', label:'Criar ou entrar num time', ic:'plus' });
  it.push({ k:'ajustes', label:'Ajustes', hint:'⌘,', ic:'gear' }, { k:'uso', label:'Uso', hint:o.usoHint||'quanto cada parte gasta', ic:'chart' },
    { k:'atalhos', label:'Atalhos', hint:'?', ic:'kbd' }, { k:'primeiros', label:'Primeiros passos', ic:'flag' });
  if(o.pubRel) it.push({ k:'pubrel', label:'Publicar release', hint:'só dev/admin', ic:'push' });
  it.push({ k:'tema' });
  if(info.signed) it.push({ k:'sair', label:'Sair', ic:'exit' });
  return it;
}
// @puro-avatar-fim
function meInfo(){ try{ return meInfoOf(SB.sess(), (typeof cloudData!=='undefined')?cloudData:null, (typeof cloudTeamId==='function')?cloudTeamId():null); }catch(_){ return meInfoOf(null); } }
function meSync(){
  const i=meInfo();
  const n=$id('meName'), s=$id('meSub'), a=$id('meAv');
  if(n && n.textContent!==i.name) n.textContent=i.name;
  if(s && s.textContent!==i.sub) s.textContent=i.sub;
  if(a && a.textContent!==i.ini) a.textContent=i.ini;
  const b=$id('meBtn'); if(b) b.title=i.signed?(i.name+' · '+i.sub+' — conta, ajustes, uso, atalhos e sair'):'Entrar — sua conta e o time';
  // Time na lateral SÓ com organização (D1, Marcos): sem org, o convite mora no menu do avatar
  const t=$id('timeBtn'); if(t){ const on=!!i.org; if(t.hidden===on) t.hidden=!on; }
}
function meTemaHtml(){ const cur=(typeof temaPref==='function')?temaPref():'system'; const L=[['light','Claro'],['dark','Escuro'],['system','Sistema']];
  return `<div class="g1tema"><span class="g1ic" aria-hidden="true">${IC.sun}</span><span class="g1l">Tema</span><div class="seg2" role="radiogroup" aria-label="Tema do app">${L.map(([k,l])=>`<button type="button" role="radio" aria-checked="${k===cur}" class="${k===cur?'on':''}" data-metema="${k}">${l}</button>`).join('')}</div></div>`; }
function meMenuOpen(){
  const btn=$id('meBtn'); if(!btn) return;
  if($id('g1menu') && btn.getAttribute('aria-expanded')==='true'){ const m=$id('g1menu'); if(m.__close) m.__close(); return; }
  const i=meInfo();
  const pr=$id('pubRelBtn');
  const acts={ entrar:()=>{ if(typeof auShow==='function') auShow(lsGet('sb:email')?'login':'signup'); },
    conta:()=>g1Ajustes('conta'), times:()=>g1Ajustes('times'), ajustes:()=>g1Ajustes(), uso:()=>openTab('uso'), atalhos:()=>openTab('atalhos'),
    primeiros:g1PrimeirosPassos, pubrel:()=>{ if(pr) pr.click(); } };
  const head={ html:`<div class="g1mehead"><span class="meav lg" aria-hidden="true">${esc(i.ini)}</span><div><b>${esc(i.name)}</b><span>${esc(i.org?'Organização '+i.org.name+((typeof cloudData!=='undefined'&&cloudData&&cloudData.meRole==='owner')?' · dono':''):(i.signed?'Conta pessoal · sem organização':'sem sessão'))}</span>${i.team?`<span>Time ${esc(i.team.name)}</span>`:''}</div></div>` };
  const items=[head, { sep:true }];
  for(const x of meMenuItemsOf(i, { pubRel:!!(pr && pr.style.display!=='none') })){
    if(x.k==='tema'){ items.push({ html:meTemaHtml(), wire:(d)=>d.querySelectorAll('[data-metema]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); if(typeof temaSet==='function') temaSet(b.dataset.metema); d.innerHTML=meTemaHtml(); d.querySelectorAll('[data-metema]').forEach(n=>n.onclick=b.onclick); }) }, { sep:true }); continue; }
    if(x.k==='sair'){ items.push({ label:'Sair', ic:'exit', keep:true, act:(b)=>{ // confirmação ancorada no próprio item (nada de modal)
        if(b.dataset.sure){ const m=$id('g1menu'); if(m&&m.__close) m.__close(); if(typeof sbLogout==='function') sbLogout(); meSync(); return; }
        b.dataset.sure='1'; b.classList.add('danger'); b.querySelector('.g1l').textContent='Sair da conta? Clique de novo pra confirmar'; } }); continue; }
    items.push({ label:x.label, hint:x.hint, ic:x.ic, act:acts[x.k] });
  }
  btn.setAttribute('aria-expanded','true');
  g1Menu(btn, items, { up:true, cls:'g1me', onClose:()=>btn.setAttribute('aria-expanded','false') });
}
bindClick('meBtn', meMenuOpen);
bindClick('timeBtn', ()=>openTab('time'));
// o rótulo do botão de conta já é atualizado pelo cloudBtnSync (40-nuvem): o avatar vai junto
if(typeof cloudBtnSync==='function' && !cloudBtnSync.__g1){ const cb=cloudBtnSync; cloudBtnSync=function(){ const r=cb.apply(this, arguments); try{ meSync(); }catch(_){ } return r; }; cloudBtnSync.__g1=true; }
meSync();

// ===================== ATALHOS (aba, não modal — D23) =====================
function atalhosOpen(){
  const pg=$id('atalhosPage'); if(!pg) return;
  const groups=(typeof SHORTCUTS!=='undefined'?SHORTCUTS:[]);
  const keys=(k)=>(typeof kbdKeysHtml==='function')?kbdKeysHtml(k):esc((k||[]).join(' '));
  pg.innerHTML=pageHead({ title:'Atalhos', scope:'computador', sum:'no Windows e no Linux, ⌘ = Ctrl' })
    +`<div class="pgbody"><div class="kgrid">${groups.map(([g,items])=>`<section class="pgcard"><h3>${esc(g)}</h3>${items.map(([k,d])=>`<div class="krow"><span>${esc(d)}</span><span class="kk">${keys(k)}</span></div>`).join('')}</section>`).join('')}</div>
    <p class="pgnote">Esc nunca fecha uma aba — quem fecha é ⌘W. Com o foco no terminal, Esc interrompe a IA.</p></div>`;
  if(typeof ovShow==='function') ovShow('atalhosOverlay');
}
// "?" e ⌘/ (54-acessibilidade) e o antigo painel modal abrem a ABA
if(typeof openShortcuts==='function' && !openShortcuts.__g1){ openShortcuts=function(){ openTab('atalhos'); }; openShortcuts.__g1=true; window.openShortcuts=openShortcuts; }

// ===================== TIME (página própria, só com organização — D5) =====================
function timePageOpen(){
  const pg=$id('timePage'); if(!pg) return;
  if(!pg.querySelector('#timeHost')){ pg.innerHTML='<div id="timeHead"></div><div class="pgbody" id="timeHost"></div>'; }
  timeHeadPaint();
  const tb=$id('teamBoard'), host=$id('timeHost'); if(tb && host && tb.parentElement!==host) host.appendChild(tb);
  if(typeof ovShow==='function') ovShow('timeOverlay');
  if(typeof teamPaintSig!=='undefined') teamPaintSig='';
  if(typeof renderTeamBoard==='function') safe(renderTeamBoard);
}
function timeHeadPaint(){
  const i=meInfo();
  let n=(typeof cloudData!=='undefined'&&cloudData&&cloudData.members)?cloudData.members.length:0;
  // ativo = regra única do 69 (épico entregue — "pronto quando" todo provado, ou todas as tarefas entregues — não conta)
  let eps=(typeof teamEpics!=='undefined'&&teamEpics)?teamEpics.filter(e=>typeof epAtivo==='function'?epAtivo(e, ((typeof teamTasks!=='undefined'&&teamTasks)||[]).filter(t=>t.epic_id===e.id)):(e.status!=='done'&&e.status!=='archived')).length:0;
  let prs=(typeof teamTasks!=='undefined'&&teamTasks)?teamTasks.filter(t=>t.pr_url&&!['merged','done'].includes(t.status)).length:0;
  const S=window._timeSum; if(S){ n=S.n; eps=S.eps; prs=S.prs; } // o quadro já contou (mesmas regras das abas)
  const sum=i.org?`${n} ${n===1?'pessoa':'pessoas'} · ${eps} ${eps===1?'épico ativo':'épicos ativos'} · <b>${prs}</b> ${prs===1?'PR':'PRs'} pra revisar`:'';
  // o chip "Time · X" é o SELETOR do time ativo (74-time-ativo): com 1 time só continua chip simples. Na visão
  // "toda a organização" (owner/admin) o chip diz isso — trocar o time ativo volta a valer ao escolher "meu time"
  const orgV=typeof tsOrgScope==='function'&&tsOrgScope();
  const pick=(!orgV && typeof teamPickHtml==='function')?teamPickHtml({ ctx:'time' }):'';
  const head=pick?pageHead({ title:'Time', sum, afterTitle:pick })
    :pageHead({ title:'Time', scope:'time', scopeLabel:orgV?'toda a organização':(i.team?i.team.name:(i.org?i.org.name:'')), sum });
  const h=$id('timeHead'); if(h && h.__html!==head){ h.__html=head; h.innerHTML=head; }
}
if(typeof showActiveView==='function' && !showActiveView.__g1){ const sa=showActiveView; showActiveView=function(){ const r=sa.apply(this, arguments);
    try{ const t=tabById(activeTab); if(t && t.kind==='projeto' && t.loaded) projShowSub(projSub); }catch(e){ console.error('g1 projeto', e); }
    try{ g1NavSync(); }catch(e){ console.error('g1 nav', e); } return r; }; showActiveView.__g1=true; }
// lateral: marca o LUGAR da aba aberta (e só ele) — trocar de aba pela barra de cima atualiza a marca
const G1_NAV={ projetos:'projetosBtn', issues:'issuesBtn', fabrica:'fabricaBtn', time:'timeBtn' };
function g1NavSync(){
  const t=(typeof tabById==='function')?tabById(activeTab):null, on=t?G1_NAV[t.kind]:'';
  for(const id of Object.values(G1_NAV)){ const b=$id(id); if(!b) continue; const v=id===on; if(b.classList.contains('on')!==v){ b.classList.toggle('on', v); if(v) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); } }
}
// clique de mouse não deixa o anel de foco preso no botão da lateral (teclado continua com o anel)
{ const nav=document.querySelector('.sbnav2'); if(nav) nav.addEventListener('click', e=>{ const b=e.target.closest('.sbitem'); if(b && e.detail>0) setTimeout(()=>b.blur(), 0); }); }
// anel de foco da lateral só com navegação por teclado (Tab): o WebKit marcava o botão clicado com o anel e ele ficava preso
document.addEventListener('keydown', e=>{ if(e.key==='Tab') document.documentElement.classList.add('kbdnav'); }, true);
document.addEventListener('pointerdown', ()=>document.documentElement.classList.remove('kbdnav'), true);
// "cancelar" dos agentes dentro da página Projeto: descarta e relê (não há aba 'agents' pra fechar)
if(typeof closeAgents==='function' && !closeAgents.__g1){ const ca=closeAgents; closeAgents=function(){ const o=$id('agOverlay'); if(o && o.classList.contains('inproj')){ agBase=''; if(window.openAgents) window.openAgents(); return; } return ca.apply(this, arguments); }; closeAgents.__g1=true; }
function g1TabOn(kind){ const t=tabById(activeTab); return !!(t && t.kind===kind); }
// a Central não tem mais a vista "Time": setView('team') (atalhos antigos, "assumir"…) abre a página; grafo/atividade antigos → lista
if(typeof setView==='function' && !setView.__g1){ const sv=setView; setView=function(v){ if(v==='team'){ openTab('time'); return; } if(v==='graph'||v==='feed') v='flow'; return sv.call(this, v); }; setView.__g1=true; }

// ===================== PROJETO · <nome> (D3/D4) =====================
// @puro-projeto-inicio (testado em app/tests/redesign-f4-g1.test.mjs)
const PROJ_SECS=[['conversa','Conversa','chat'],['linha','Linha','linha'],['memoria','Memória','book'],['agentes','Agentes','bot'],['skills','Skills','bolt'],['regras','Regras','rule'],['disco','Espaço em disco','disk']];
const PROJ_OV={ conversa:'pcOverlay', linha:null, memoria:'memOverlay', agentes:'agOverlay', skills:'skOverlay', regras:'prefsOverlay', disco:null };
function projSubNorm(s){ return PROJ_SECS.some(x=>x[0]===s)?s:'conversa'; }
// @puro-projeto-fim
let projSub=projSubNorm(lsGet('projSub'));
let projRepoShown=null;
function projCounts(){ const live=(typeof projLiveTasks==='function')?projLiveTasks((state.tasks||[])):(state.tasks||[]); const fc=flowCounts(live); // L11: régua única (lateral = Projetos = Projeto)
  return { vivas:live.length, aguardando:aguardandoVoceCount(live), prontas:prontasRevisarCount(live), fc }; }
function projPageOpen(tab){
  if(tab && tab.sub){ projSub=projSubNorm(tab.sub); tab.sub=null; lsSet('projSub', projSub); }
  projPageRender();
  if(typeof ovShow==='function') ovShow('projOverlay');
  projShowSub(projSub);
}
function projPageRender(){
  const head=$id('projHead'), nav=$id('projNav'); if(!head||!nav) return;
  const repo=state.repo||'', name=pathBase(repo);
  projRepoShown=repo;
  { const t=tabsOfKind('projeto')[0]; if(t){ const tt=name?('Projeto · '+name).slice(0,28):'Projeto'; if(t.title!==tt){ t.title=tt; renderTabs(); } } }
  if(!repo){ head.innerHTML=pageHead({ title:'Projeto', scope:'projeto' }); head.__html=''; nav.innerHTML=''; nav.__html=''; return; }
  const c=projCounts();
  const hh=pageHead({ title:'Projeto · '+name, scope:'projeto', sum:`${c.vivas} em aberto · <b>${c.aguardando}</b> aguardando você · <b>${c.prontas}</b> ${c.prontas===1?'pronta':'prontas'} pra revisar`, more:{ id:'projPageMore', title:'Mostrar no Finder · ver na Central' } });
  const learnN=+(window.memLearnN||0);
  const nh=`<div class="sn-h">Este projeto</div>`+PROJ_SECS.map(([k,l,ic])=>`<button role="tab" class="${k===projSub?'on':''}" aria-selected="${k===projSub}" tabindex="${k===projSub?0:-1}" data-projsub="${k}"><span class="g1ic" aria-hidden="true">${IC[ic]||''}</span>${esc(l)}${k==='memoria'&&learnN?`<b title="${learnN} aprendizado(s) pra revisar">${learnN}</b>`:''}</button>`).join('')
    +`<div class="sn-card"><b>${c.vivas} em aberto</b><span><i style="background:var(--st-ask)"></i>${c.aguardando} aguardando você</span><span><i style="background:var(--st-review)"></i>${c.prontas} ${c.prontas===1?'pronta':'prontas'} pra revisar</span><button class="lnk" id="projSeeCentral">Ver na Central</button><code>${esc(repo.replace(/^\/Users\/[^/]+/,'~'))}</code></div>`;
  if(head.__html===hh && nav.__html===nh) return; // nada mudou: mantém o DOM (foco e handlers)
  head.__html=hh; head.innerHTML=hh; nav.__html=nh; nav.innerHTML=nh;
  // projGo é async e refaz o nav: o foco vai pra aba nova DEPOIS (antes ia pro body e a 2ª seta não fazia nada)
  const projGoFoco=(k)=>Promise.resolve(projGo(k)).then(()=>{ const f=nav.querySelector(`[data-projsub="${k}"]`); if(f) f.focus(); });
  nav.querySelectorAll('[data-projsub]').forEach(b=>{ b.onclick=()=>{ if(nav.contains(document.activeElement)) projGoFoco(b.dataset.projsub); else projGo(b.dataset.projsub); };
    b.onkeydown=(e)=>{ const d={ ArrowDown:1, ArrowUp:-1, ArrowRight:1, ArrowLeft:-1 }[e.key]; if(!d) return; e.preventDefault();
      const l=[...nav.querySelectorAll('[data-projsub]')], i=l.indexOf(b), n=l[(i+d+l.length)%l.length]; projGoFoco(n.dataset.projsub); }; });
  { const b=nav.querySelector('#projSeeCentral'); if(b) b.onclick=()=>flowJump({ status:'all', proj:state.repo }); }
  { const mb=head.querySelector('#projPageMore'); if(mb) mb.onclick=()=>g1Menu(mb, [
    { label:(typeof osKind!=='function'||osKind()==='mac')?'Mostrar no Finder':'Abrir a pasta', act:()=>invoke('reveal_project',{ path:state.repo }) },
    { label:'Ver na Central', act:()=>flowJump({ status:'all', proj:state.repo }) },
    { label:'Todos os projetos', act:()=>openTab('projetos') } ]); }
}
// rascunho na seção que vai sair de cena? (agentes: agDirty · convenções do time: prefsDirty) → pergunta; true = pode sair.
// `to` = seção de destino (null = fechando a página). Descartar zera o rascunho.
async function g1ProjLeaveOk(to){
  const cur=projSub;
  if(to===cur) return true;
  if((to===null||cur==='agentes') && typeof agDirty==='function' && agDirty()){
    if(!await askYes('Descartar as mudanças nos agentes e equipes?\n\nNada foi salvo ainda.')) return false; agBase=''; }
  if((to===null||cur==='regras') && typeof prefsDirty==='function' && prefsDirty()){
    if(!await askYes('Descartar as mudanças nas convenções do time?\n\nNada foi salvo ainda.')) return false; prefsLoaded=($id('prefsText')||{}).value||''; if(typeof prefsBarSync==='function') prefsBarSync(); }
  return true;
}
window.g1ProjLeaveOk=g1ProjLeaveOk;
async function projGo(sub){ sub=projSubNorm(sub); if(g1TabOn('projeto') && !await g1ProjLeaveOk(sub)) return; projSub=sub; lsSet('projSub', projSub); if(!g1TabOn('projeto')){ openTab('projeto',{ sub:projSub }); return; } projPageRender(); projShowSub(projSub); const pb=$id('projHost'); if(pb) pb.scrollTop=0; }
window.projGo=projGo;
// a seção vive DENTRO da página: o overlay antigo é movido pro #projHost e vira "aba" (astab) — os abridores de sempre
// (openPc, openMemoria…) pintam como sempre pintaram. Sem projeto: o estado padrão "Esta página é de um projeto".
function projShowSub(sub){
  const host=$id('projHost'); if(!host) return;
  host.querySelectorAll(':scope>.overlay').forEach(o=>{ if(o.id!==PROJ_OV[sub]){ o.style.display='none'; } });
  const disk=$id('projDisk'); if(disk) disk.hidden=sub!=='disco';
  const lin=$id('projLinha'); if(lin) lin.hidden=sub!=='linha';
  const none=$id('projNone');
  if(!state.repo){ if(lin) lin.hidden=true; // a Linha do projeto anterior não fica por baixo do "sem projeto"
    if(!none){ const d=document.createElement('div'); d.id='projNone'; host.appendChild(d); }
    const n=$id('projNone'); n.hidden=false;
    n.innerHTML=emptyHtml({ icon:'folder', title:'Esta página é de um projeto.', help:'Abra um projeto (ou crie um) pra ver a conversa, a memória, os agentes, as skills e as regras dele.', action:{ id:'projNoneGo', label:'Abrir ou criar projeto' } });
    bindClick('projNoneGo', ()=>openTab('projetos')); return; }
  if(none) none.hidden=true;
  if(sub==='disco'){
    if(!disk){ const d=document.createElement('section'); d.id='projDisk'; d.className='pgsec';
      d.innerHTML='<div class="pgsec-h"><div><h2>Espaço em disco</h2><p>Pasta de trabalho do Starfork neste projeto (.cardume). Aprendizados e estado ficam sempre; o resto pode ir.</p></div></div><div id="projWsHost"></div>'; host.appendChild(d); }
    if(typeof wsMount==='function') wsMount();
    return; }
  // Linha do projeto (69-linha): seção sem overlay, como o disco — épicos do projeto aberto, com os dados do Time
  if(sub==='linha'){
    if(!$id('projLinha')){ const d=document.createElement('section'); d.id='projLinha'; d.className='pgsec';
      d.innerHTML='<div class="pgsec-h"><div><h2>Linha do projeto</h2><p>O que este projeto está entregando e quando. A janela e a saúde são postas por uma pessoa; o preenchimento é o "pronto quando" provado.</p></div></div><div id="projLinhaHost"></div>'; host.appendChild(d); }
    if(typeof linhaProjMount==='function') linhaProjMount();
    return; }
  const o=$id(PROJ_OV[sub]); if(!o) return;
  if(o.parentElement!==host) host.appendChild(o);
  o.classList.add('astab','inproj'); o.style.display='block';
  const keep=(sub==='agentes' && typeof agDirty==='function' && agDirty()); // rascunho de agentes: só mostra (openAgents relê o catálogo)
  const open=keep?null:{ conversa:()=>openPc(), memoria:()=>window.openMemoria&&window.openMemoria(), agentes:()=>window.openAgents&&window.openAgents(), skills:()=>openSkills(), regras:()=>openPrefs() }[sub];
  try{ if(open) open(); }catch(e){ console.error('projShowSub', e); }
  o.style.display='block'; // os abridores antigos punham 'flex' (modal)
}

// ===================== CENTRAL: faixa da Verificação, Resumo do período, estado vazio =====================
// D21: falta algo obrigatório neste computador → faixa. Na Central quem pinta é o G3 (67-ajustes: ajEnvBand); aqui só
// o estado vazio (sem projeto o #flowPane nem aparece)
function centralBandHtml(checks){
  const bad=(Array.isArray(checks)?checks:[]).filter(c=>!c.ok && (typeof envKind!=='function' || envKind(c)==='req'));
  if(!bad.length) return '';
  const nm=bad.map(c=>String(c.name||'').replace(/\s*\(.*\)$/,'')).filter(Boolean);
  return `<div class="pgband warn" role="status"><span><b>Falta ${esc(nm.slice(0,2).join(' e '))}${nm.length>2?' e mais '+(nm.length-2):''} neste computador.</b> Sem isso, parte do trabalho não roda — o resto funciona.</span><span class="grow"></span><button class="btn sm" data-bandfix="1">Resolver</button></div>`;
}
function centralBandPaint(){
  const html=centralBandHtml((typeof envChecks!=='undefined')?envChecks:null);
  ['emBand'].forEach(id=>{ const el=$id(id); if(!el || el.__html===html) return; el.__html=html; el.innerHTML=html;
    el.querySelectorAll('[data-bandfix]').forEach(b=>b.onclick=()=>g1Ajustes('verificacao')); });
}
window.centralBandPaint=centralBandPaint;
// D20: Concluídas › Resumo do período = o Daily (mesmas funções: loadDaily/renderDaily/relatório) sem a aba própria
function centralOpenResumo(){ flowScope='done'; lsSet('flowScope','done'); centralDoneSub='res'; lsSet('centralDone','res'); lastSig=''; }
window.centralOpenResumo=centralOpenResumo;
function centralResumoMount(host){
  const body=$id('dailyBody'); if(!body) return;
  if(body.parentElement!==host) host.appendChild(body);
  const inp=$id('dailyDate'); if(inp && !inp.value){ const d=new Date(); inp.value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  // o digest é do projeto ABERTO: trocou de projeto → relê; senão mantém o que está na tela
  const repo=(state&&state.repo)||'';
  if(typeof loadDaily==='function' && inp && !dailyLoading && (host.__repo!==repo || !body.firstChild)){ host.__repo=repo; loadDaily(); } // (trocar o dia é do próprio seletor: wireDaily)
}
window.centralResumoMount=centralResumoMount;
// estado vazio (ex-"Início sem projeto"): os projetos recentes deste computador viram 1 clique
let emRecentDone=false;
window.addEventListener('focus', ()=>{ emRecentDone=false; if(typeof state!=='undefined' && !state.repo) emRecentPaint(); });
async function emRecentPaint(){
  const el=$id('emRecent'); if(!el || emRecentDone) return; emRecentDone=true;
  let list=[]; try{ list=(await invoke('list_projects', { user:(typeof cloudUserId==='function'?cloudUserId():undefined) }))||[]; }catch(_){ list=[]; }
  if(!list.length){ el.innerHTML=''; return; }
  el.innerHTML=`<h3>Projetos recentes neste computador</h3><div class="pgcard rows">${list.slice(0,5).map(p=>`<div class="li">${typeof railBadgeHtml==='function'?railBadgeHtml(p.name, projColor(p.path)):''}<b>${esc(p.name||pathBase(p.path))}</b><span class="dim mono">${esc(String(p.path||'').replace(/^\/Users\/[^/]+/,'~'))}</span><span class="grow"></span><button class="btn sm" data-emopen="${escA(p.path)}">Abrir</button></div>`).join('')}</div>`;
  el.querySelectorAll('[data-emopen]').forEach(b=>b.onclick=async()=>{ b.disabled=true; try{ if(window.switchProject) await window.switchProject(b.dataset.emopen); else await invoke('open_project',{ path:b.dataset.emopen }); }catch(e){ showErr(e,'Não consegui abrir o projeto'); b.disabled=false; } });
}

// ===================== render: as páginas novas acompanham o estado (sem timer novo) =====================
if(typeof render==='function' && !render.__g1){ const r0=render; render=function(){ const out=r0.apply(this, arguments);
    try{
      if(!state.repo){ emRecentPaint(); centralBandPaint(); } else emRecentDone=false; // a próxima vez que o vazio aparecer, relê
      if(g1TabOn('time') && typeof renderTeamBoard==='function'){ safe(renderTeamBoard); timeHeadPaint(); }
      if(g1TabOn('projeto')){ const ch=projRepoShown!==(state.repo||''); projPageRender(); if(ch) projShowSub(projSub); else if(projSub==='linha' && typeof linhaProjMount==='function') linhaProjMount(); }
      meSync();
    }catch(e){ console.error('g1 render', e); }
    return out; }; render.__g1=true; }

// migração de preferências antigas: g1MigratePrefs mora no 00-util (roda na carga, antes de quem lê as chaves)
