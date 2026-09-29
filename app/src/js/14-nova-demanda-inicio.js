// Starfork — 14-nova-demanda-inicio
// ===== Nova demanda (redesign): tela de início — tipo + método =====
const ND_TYPES=[
  {k:'build', i:'F', name:'Feature', desc:'Construir algo novo — tela, endpoint, fluxo.'},
  {k:'fix', i:'C', name:'Correção', desc:'Um bug pra reproduzir, entender e consertar.'},
  {k:'invest', i:'?', name:'Investigação', desc:'Achar a causa-raiz com evidência, sem implementar.'},
  {k:'design', i:'D', name:'Design', desc:'Definir a UX/UI antes do código.'},
  {k:'docs', i:'≡', name:'Documentação', desc:'Escrever ou atualizar docs com exemplos.'},
  {k:'review', i:'R', name:'Review de PR', desc:'Revisar um PR que já existe, sem criar branch.'},
];
// tipo da tela de início → modo do formulário (docs = entrega em branch docs/…)
const ND_TO_MODE={build:'build',fix:'fix',invest:'invest',design:'design',docs:'build',review:'review'};
// o que a tarefa criada pelo planner vira, por tipo — o MESMO mapeamento do formulário (ND_TO_MODE + ntDocsPreset):
// investigação, documentação, design e review entregam documento SEM PR; correção vai em fix/. A prévia lê daqui.
const ND_CREATE={
  build: { branchType:'feat',   autoPr:'ask', doc:null,               owns:null,        noCode:false, delivery:'PR pra revisar' },
  fix:   { branchType:'fix',    autoPr:'ask', doc:null,               owns:null,        noCode:false, delivery:'PR pra revisar' },
  docs:  { branchType:'docs',   autoPr:'no',  doc:null,               owns:null,        noCode:false, delivery:'documento' },
  invest:{ branchType:'invest', autoPr:'no',  doc:'INVESTIGATION.md', owns:'.cardume/', noCode:true,  delivery:'relatório com a causa' },
  design:{ branchType:'design', autoPr:'no',  doc:'DESIGN.md',        owns:'.cardume/', noCode:true,  delivery:'mockup e decisões' },
  review:{ branchType:'review', autoPr:'no',  doc:'REVIEW.md',        owns:'.cardume/', noCode:true,  delivery:'parecer em documento' },
};
function ndKindCreate(kind){ const k=ND_CREATE[kind]?kind:'build'; return Object.assign({ kind:k, mode:ND_TO_MODE[k]||'build' }, ND_CREATE[k]); }
const ND_NAME_OF_MODE={build:'Feature',fix:'Correção',invest:'Investigação',design:'Design',review:'Review de PR'};
window.ND_TO_MODE=ND_TO_MODE; window.ND_NAME_OF_MODE=ND_NAME_OF_MODE;
let ndType='build', ndMethod='chat', ndIntent=''; // ndIntent: o texto da caixa única (sobrevive à troca de aba/projeto)
// ===== as 3 formas de montar uma demanda: MESMOS nomes e MESMO seletor (pequeno) em todo lugar
// (composer da Nova demanda, aba Formulário e aba do Orquestrador) — repaginada B: vira controle, não cabeçalho =====
const ND_METHODS=[
  { k:'chat', tab:'planner', name:'Conversar', tip:'a IA pergunta só o essencial e monta a demanda' },
  { k:'form', tab:'form', name:'Formulário', tip:'formulário com todos os campos, sem conversa' },
  { k:'orq', tab:'orq', name:'Dividir', tip:'um agente coordenador divide o problema em etapas e abre uma tarefa por etapa' },
];
// cur: 'chat'|'form'|'orq' · ids: { chat:'idDoBotão' } quando a tela já tem um handler próprio pra aquele botão
function ndMethodSeg(cur, ids){
  ids=ids||{};
  return `<div class="orq-seg ndseg ndseg-sm" role="tablist" aria-label="como montar a demanda">${ND_METHODS.map(m=>`<button type="button" role="tab" class="${m.k===cur?'on':''}" aria-selected="${m.k===cur}"${ids[m.k]?` id="${ids[m.k]}"`:''} data-ndseg="${m.tab}" title="${escA(m.tip)}">${esc(m.name)}</button>`).join('')}</div>`;
}
window.ndMethodSeg=ndMethodSeg;
// ===== repaginada B: "Nova demanda" abre direto no planner (uma tela só). A tela antiga de 2 passos
// fica por uma versão atrás de lsGet('nd:legacy')==='1'. =====
function ndLegacy(){ return lsGet('nd:legacy')==='1'; }
window.ndLegacy=ndLegacy;
function ndTypeName(k){ const t=ND_TYPES.find(x=>x.k===k); return t?t.name:''; }
// "Tipo: Automático" — um palpite barato pelo texto (só pra prévia; a escolha do usuário sempre vence)
function ndGuessType(text){
  const t=String(text||'').toLowerCase();
  if(!t.trim()) return '';
  if(/(revis(ar|e|ão)|review)(?!\p{L})[^.]{0,30}(?<!\p{L})(pr|pull request)(?!\p{L})|github\.com\/[^\s]+\/pull\//u.test(t)) return 'review'; // \b não serve depois de 'ã'
  if(/(investig|descobrir (por ?qu|a causa|onde)|causa[- ]raiz|por que .{0,40}(demora|lent|cai|falha|trava)|\bresumir\b|\banalisar\b|levantamento)/.test(t)) return 'invest';
  if(/(\bbug\b|\berro\b|quebr|consert|corrig|não funciona|nao funciona|some\b|sumiu|travando|\bfalha)/.test(t)) return 'fix';
  if(/(mockup|protótipo|prototipo|\bux\b|\bui\b|wireframe|desenhar a tela|layout novo)/.test(t)) return 'design';
  if(/(documenta|readme|\bdocs?\b|manual|roteiro|newsletter|\bposts?\b|calend[aá]rio|texto d[oa]|artigo|apresenta[çc][ãa]o|\bescrever\b|\bredigir\b)/.test(t)) return 'docs';
  return 'build';
}
// exemplos clicáveis do estado vazio — ≥2 que não são software (Carla: operações/marketing também usam)
const ND_EXAMPLES=[
  { k:'fix',    sw:true,  title:'O botão de pagar some no celular', text:'O botão de pagar some no celular (iPhone, Safari). Quero entender e corrigir.' },
  { k:'build',  sw:true,  title:'Página de contato com formulário', text:'Criar uma página de contato com formulário que manda e-mail pro time comercial.' },
  { k:'invest', sw:true,  title:'Por que o login demora 10 s?', text:'Descobrir por que o login às vezes demora uns 10 segundos — sem mexer em nada, só achar a causa.' },
  { k:'docs',   sw:false, title:'E-mail de lançamento pros clientes', text:'Escrever o e-mail de lançamento da nova versão pros clientes, com assunto e um texto curto e direto.' },
  { k:'docs',   sw:false, title:'Calendário de posts do mês', text:'Montar o calendário de posts do mês pro Instagram: 12 posts com tema, legenda e dia.' },
  { k:'invest', sw:false, title:'Resumo das reclamações do suporte', text:'Ler as reclamações do suporte deste mês e resumir os 5 problemas que mais aparecem, com exemplos.' },
];
// projeto de conteúdo/operação (não software) → exemplos de gente primeiro. Heurística pelo nome da pasta.
function ndProjectIsSoftware(name){ return !/(marketing|conte[uú]do|institucional|blog|docs?\b|documenta|financeiro|\brh\b|operac|comercial|vendas|social)/i.test(String(name||'')); }
function ndExamples(isSoftware){
  const sw=ND_EXAMPLES.filter(e=>e.sw), gente=ND_EXAMPLES.filter(e=>!e.sw);
  return isSoftware===false ? [...gente, ...sw] : [...sw, ...gente]; // 6 cards (3×2): a ordem muda com o tipo de projeto
}
// texto levado de um modo pro outro (Conversar → Formulário/Dividir e volta): quem abre consome uma vez
// ndCarryText: o texto; ndCarryExtra: o que a conversa já montou (título, entregas, requisitos) quando a caixa está vazia
let ndCarryText='', ndCarryExtra=null;
function ndTakeCarry(){ const t=ndCarryText; ndCarryText=''; ndCarryExtra=null; return t; }
// tipo levado do Formulário pro Conversar (o chip "Tipo" do planner já começa nele) — quem abre consome uma vez
let ndCarryKind='';
function ndTakeCarryKind(){ const k=ndCarryKind; ndCarryKind=''; return ND_CREATE[k]?k:''; }
window.ndTakeCarryKind=ndTakeCarryKind;
function ndTakeCarryAll(){ const o=Object.assign({ text:ndCarryText }, ndCarryExtra||{}); ndCarryText=''; ndCarryExtra=null; return o; }
// PURA: texto levado → título (o dado, senão a 1ª frase até 80 caracteres) + objetivo (o texto inteiro)
function ndSplitCarry(text, title){
  text=String(text||'').trim(); const first=text.split('\n')[0].split(/(?<=[.!?])\s/)[0].slice(0,80).trim();
  return { title:String(title||'').trim()||first, objective:text };
}
window.ndTakeCarry=ndTakeCarry; window.ndTakeCarryAll=ndTakeCarryAll; window.ndSplitCarry=ndSplitCarry;
// popover pequeno ancorado num botão (tipo, IA, escopo…): fecha com Esc, clique fora ou ao escolher
// refocus=true (Esc / clique fora): o foco volta pro botão que abriu
function ndPopClose(refocus){ const p=$id('ndPop'); if(p){ const a=p.__anchor; p.remove(); if(a){ try{ a.setAttribute('aria-expanded','false'); if(refocus===true && a.isConnected) a.focus(); }catch(_){} } }
  document.removeEventListener('mousedown', ndPopOutside, true); document.removeEventListener('keydown', ndPopKey, true);
  window.removeEventListener('resize', ndPopPlace); window.removeEventListener('scroll', ndPopPlace, true); }
function ndPopPlace(){ const p=$id('ndPop'); if(p && p.__place) p.__place(); }
function ndPopOutside(e){ const p=$id('ndPop'); if(p && !p.contains(e.target) && !(p.__anchor && p.__anchor.contains(e.target))) ndPopClose(true); }
function ndPopKey(e){ if(e.key==='Escape'){ e.stopPropagation(); e.preventDefault(); ndPopClose(true); } }
function ndPopover(anchor, html, wire){
  const was=$id('ndPop'); const same=was && was.__anchor===anchor; ndPopClose(); if(same) return null; // 2º clique no mesmo botão fecha
  const p=document.createElement('div'); p.id='ndPop'; p.className='ndpop'; p.setAttribute('role','dialog'); p.tabIndex=-1; p.__anchor=anchor;
  try{ anchor.setAttribute('aria-expanded','true'); }catch(_){}
  p.innerHTML=html; document.body.appendChild(p);
  const place=()=>{ const r=anchor.getBoundingClientRect(), w=p.offsetWidth, h=p.offsetHeight;
    let x=Math.min(Math.max(8, r.left), innerWidth-w-8), y=r.top-h-8; if(y<8) y=Math.min(r.bottom+8, innerHeight-h-8);
    p.style.left=x+'px'; p.style.top=Math.max(8,y)+'px'; };
  p.__place=place; place();
  if(wire){ wire(p); place(); }
  { const f=p.querySelector('.on, button, input, select, a[href], [tabindex]:not([tabindex="-1"])'); try{ (f||p).focus({ preventScroll:true }); }catch(_){} } // foco entra no popover
  window.addEventListener('resize', ndPopPlace); window.addEventListener('scroll', ndPopPlace, true);
  setTimeout(()=>{ document.addEventListener('mousedown', ndPopOutside, true); document.addEventListener('keydown', ndPopKey, true); },0);
  return p;
}
window.ndPopover=ndPopover; window.ndPopClose=ndPopClose;
// um handler só pra todos os seletores (os botões com id próprio — ex.: #ntAI — seguem com o handler deles)
document.addEventListener('click', e=>{
  const b=e.target.closest&&e.target.closest('[data-ndseg]'); if(!b||b.id||b.classList.contains('on')) return;
  // leva o texto já digitado (ou o que a conversa já montou) pro outro modo (planner → formulário/orquestrador)
  ndCarryText=''; ndCarryExtra=null;
  { const pi=$id('plInput'), po=$id('plannerOverlay'), inPl=pi && po && po.style.display!=='none';
    if(inPl && pi.value.trim()) ndCarryText=pi.value.trim();
    else if(inPl && typeof plFields!=='undefined' && plFields && (plFields.title||plFields.objective)){
      ndCarryText=String(plFields.objective||plFields.title).trim();
      ndCarryExtra={ title:plFields.title||'', deliverables:(plFields.deliverables||[]).slice(), requirements:(plFields.requirements||[]).slice() }; }
    const oi=$id('orqTa'), oo=$id('orqOverlay'); if(!ndCarryText && oi && oo && oo.style.display!=='none' && oi.value.trim()) ndCarryText=oi.value.trim(); }
  if(b.dataset.ndseg==='form' && typeof plFields!=='undefined' && plFields && plFields.kind) window.ntPresetType=plFields.kind;
  ndPopClose();
  const kind=b.dataset.ndseg;
  if(window.openTab) window.openTab(kind,{replace:true}); // troca o jeito de montar NA MESMA aba (não empilha abas)
  // openTab voltou sem trocar (sem projeto / sem git): o texto não fica pendurado pra uma aba futura
  { const t=(typeof tabById==='function')?tabById(activeTab):null; if(!t || t.kind!==kind){ ndCarryText=''; ndCarryExtra=null; } }
});
window.TAB_STATE_nova={ get:()=>({ ndType, ndMethod, ndIntent }), set:(st)=>{ ndType=st.ndType||'build'; ndMethod=st.ndMethod||'chat'; ndIntent=st.ndIntent||''; } };
function ndInjectFonts(){ if($id('ndFonts')) return; const l=document.createElement('link'); l.id='ndFonts'; l.rel='stylesheet'; l.href='https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'; document.head.appendChild(l); }
window.ndInjectFonts=ndInjectFonts;
// sem a flag legada, a aba "nova" nem chega aqui (openTab troca por 'planner'); aba restaurada cai no planner
function openNovaStart(){ ndInjectFonts(); if(!ndLegacy() && window.openTab){ window.openTab('planner', { replace:true }); return; } $id('ndOverlay').style.display='flex'; ndRenderStart(); }
// Nova demanda "numa caixa só" (mesa de 27/09): UMA caixa de intenção → "Montar conversando" com o texto já
// enviado; a IA decide tarefa única × épico. Tipos, formulário e orquestrador seguem inteiros em "Mais opções".
function ndMoreOpen(){ return lsGet('nd:more')==='1'; }
function ndContinue(){
  const ta=$id('ndIntent'); const text=((ta&&ta.value)||ndIntent||'').trim();
  if(!text){ if(ta){ ta.focus(); ta.classList.add('ndshake'); setTimeout(()=>ta.classList.remove('ndshake'),450); } return; }
  ndIntent='';
  if(window.plStartWith) window.plStartWith(text, { replace:true });
  else if(window.openTab) window.openTab('planner', { replace:true });
}
function ndRenderStart(){
  const body=$id('ndBody'); if(!body) return;
  const cur=ND_TYPES.find(t=>t.k===ndType)||ND_TYPES[0];
  const typeCards=ND_TYPES.map(t=>`<button class="ndtype${t.k===ndType?' on':''}" data-ndtype="${t.k}"><span class="ndtb">${esc(t.i)}</span><span class="ndtn">${esc(t.name)}</span><span class="ndtd">${esc(t.desc)}</span></button>`).join('');
  const projs=(window.projectsList&&window.projectsList())||projList().map(([path,name])=>({path,name}));
  const projSel=`<select class="nd-projsel" id="ndProj" title="trocar o projeto onde a demanda vai abrir">${projs.map(p=>`<option value="${escA(p.path)}"${p.path===state.repo?' selected':''}>${esc(p.name||projShort(p.path))}</option>`).join('')}</select>`;
  const more=ndMoreOpen();
  body.innerHTML=`<div class="ndwrap"><div class="ndinner">
    <div class="nd-projrow"><span class="ndeyebrow">no projeto</span>${projs.length?projSel:`<span class="as-mono" style="color:var(--accent);font-size:12px">${esc(projShort(state.repo)||'—')}</span>`}</div>
    <h1 class="ndh1">O que precisa ser feito?</h1>
    <p class="ndsub">Descreva do seu jeito. A IA faz só as perguntas que faltarem e decide se é uma tarefa ou um épico com várias frentes. Você revisa antes de qualquer coisa rodar.</p>
    <div class="ndintent">
      <textarea id="ndIntent" class="ndintent-ta" rows="4" placeholder="Descreva o que você quer (em português normal). Ex.: o botão de pagar some no celular; ou: criar uma página de contato com formulário">${esc(ndIntent)}</textarea>
      <div class="ndintent-foot"><span class="dim" style="font-size:12px">⌘↵ pra continuar · abre o “Montar conversando” nesta mesma aba</span><span style="flex:1"></span><button class="as-btn primary big" id="ndIntentGo">Continuar →</button></div>
    </div>
    <details class="ndmore" id="ndMore"${more?' open':''}><summary>Mais opções <span class="dim">(tipo de demanda, formulário, dividir entre agentes)</span></summary>
    <div class="ndstep2" style="margin-top:18px"><span class="ndeyebrow">tipo de demanda</span><span class="ndline"></span></div>
    <div class="ndtypes">${typeCards}</div>
    <div class="ndstep2"><span class="ndeyebrow">como você quer montar</span><span class="ndline"></span></div>
    <div class="ndmethods">
      <button class="ndm ndm-primary${ndMethod==='chat'?' on':''}" id="ndChat" data-ndm="chat"><span class="ndmtop"><span class="ndmt">Montar conversando</span><span class="ndmbadge">recomendado</span></span><span class="ndmd">A IA pergunta só o essencial e monta a demanda na sua frente. Você revisa e aprova.</span><span class="ndmeta">~7 perguntas · 2 min</span></button>
      <button class="ndm${ndMethod==='form'?' on':''}" id="ndForm" data-ndm="form"><span class="ndmt2">Preencher eu mesmo</span><span class="ndmd">Formulário com todos os campos da demanda. Controle total, sem conversa.</span><span class="ndmeta">~10 campos, um de cada vez</span></button>
      <button class="ndm ndm-orq${ndMethod==='orq'?' on':''}" id="ndOrq" data-ndm="orq"><span class="ndmtop"><span class="ndmt2">Dividir entre vários agentes</span><span class="ndmbadge" style="background:rgba(180,124,224,.2);color:#d9b8f2">problemas grandes</span></span><span class="ndmd">Você descreve o problema inteiro. Um agente coordenador divide em etapas, abre uma tarefa por etapa e acompanha a execução — você aprova o plano antes.</span><span class="ndmeta">1 campo · plano visual das etapas</span></button>
    </div>
    <div class="ndcta"><button class="as-btn primary big" id="ndGo">Continuar${ndMethod==='chat'?' · montar conversando':ndMethod==='form'?' · preencher eu mesmo':' · dividir entre vários agentes'} →</button><span class="dim" style="font-size:12.5px">tipo <b style="color:var(--text)">${esc(cur.name)}</b> · o caminho escolhido abre nesta mesma aba</span></div>
    <div class="ndfoot"><div class="ndfl">já tem um .md? <a id="ndImport">importar</a> · guia de demanda deste repo: <span class="mono" title="arquivo SPEC.md na pasta de trabalho do Starfork (.cardume/)">SPEC.md</span></div></div>
    </details>
  </div></div>`;
  { const ta=body.querySelector('#ndIntent'); if(ta){
      ta.oninput=()=>{ ndIntent=ta.value; };
      ta.onkeydown=(e)=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); ndContinue(); } };
      if(!more) setTimeout(()=>{ try{ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }catch(_){} }, 30); } }
  bindClick('ndIntentGo', ndContinue);
  { const d=body.querySelector('#ndMore'); if(d) d.ontoggle=()=>{ lsSet('nd:more', d.open?'1':'0'); }; }
  body.querySelectorAll('[data-ndtype]').forEach(b=>b.onclick=()=>{ ndType=b.dataset.ndtype; ndRenderStart(); });
  { const s=body.querySelector('#ndProj'); if(s) s.onchange=async()=>{ const p=s.value; if(p && p!==state.repo && window.switchProject){ await window.switchProject(p); } ndRenderStart(); }; }
  // 1º clique no card SELECIONA o método; o botão Continuar (ou 2º clique no mesmo card) segue —
  // o caminho escolhido substitui esta aba (cada aba é um fluxo isolado). Com texto na caixa, "conversando" já leva o texto.
  const go=()=>{ const m=ndMethod; if(m==='chat' && ndIntent.trim()){ ndContinue(); return; } if(m==='form') window.ntPresetType=ndType; if(window.openTab) window.openTab(m==='chat'?'planner':m==='form'?'form':'orq', { replace:true }); };
  body.querySelectorAll('[data-ndm]').forEach(b=>b.onclick=()=>{ if(ndMethod===b.dataset.ndm){ go(); return; } ndMethod=b.dataset.ndm; ndRenderStart(); });
  { const b=body.querySelector('#ndGo'); if(b) b.onclick=go; }
  { const b=body.querySelector('#ndImport'); if(b) b.onclick=()=>{ window.ntPresetType=ndType; if(window.openTab) window.openTab('form', { replace:true }); setTimeout(()=>{ const im=$id('ntImport'); if(im) im.click(); }, 300); }; }
}
$id('dailyClose').onclick=()=>{ ovHide('dailyOverlay'); };
$id('dailyDate').onchange=loadDaily;
$id('dailyAI').onclick=dailyAISummary;
$id('dailyDoc').onclick=dailyGenDoc;
$id('dailyOverlay').addEventListener('click',e=>{ if(e.target.id==='dailyOverlay') ovHide('dailyOverlay'); });
