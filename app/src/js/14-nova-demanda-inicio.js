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
const ND_NAME_OF_MODE={build:'Feature',fix:'Correção',invest:'Investigação',design:'Design',review:'Review de PR'};
window.ND_TO_MODE=ND_TO_MODE; window.ND_NAME_OF_MODE=ND_NAME_OF_MODE;
let ndType='build', ndMethod='chat';
// ===== as 3 formas de montar uma demanda: MESMOS nomes e MESMO seletor em todo lugar
// (tela Nova demanda, aba Montar conversando, aba Preencher eu mesmo e aba do Orquestrador) =====
const ND_METHODS=[
  { k:'chat', tab:'planner', name:'Montar conversando', tip:'a IA pergunta só o essencial e monta a demanda' },
  { k:'form', tab:'form', name:'Preencher eu mesmo', tip:'formulário com todos os campos, sem conversa' },
  { k:'orq', tab:'orq', name:'Dividir entre vários agentes', tip:'um agente coordenador divide o problema em etapas e abre uma tarefa por etapa' },
];
// cur: 'chat'|'form'|'orq' · ids: { chat:'idDoBotão' } quando a tela já tem um handler próprio pra aquele botão
function ndMethodSeg(cur, ids){
  ids=ids||{};
  return `<div class="orq-seg ndseg" role="tablist" aria-label="como montar a demanda">${ND_METHODS.map(m=>`<button type="button" role="tab" class="${m.k===cur?'on':''}" aria-selected="${m.k===cur}"${ids[m.k]?` id="${ids[m.k]}"`:''} data-ndseg="${m.tab}" title="${escA(m.tip)}">${esc(m.name)}</button>`).join('')}</div>`;
}
window.ndMethodSeg=ndMethodSeg;
// um handler só pra todos os seletores (os botões com id próprio — ex.: #ntAI — seguem com o handler deles)
document.addEventListener('click', e=>{
  const b=e.target.closest&&e.target.closest('[data-ndseg]'); if(!b||b.id||b.classList.contains('on')) return;
  if(window.openTab) window.openTab(b.dataset.ndseg,{replace:true}); // troca o jeito de montar NA MESMA aba (não empilha abas)
});
window.TAB_STATE_nova={ get:()=>({ ndType, ndMethod }), set:(st)=>{ ndType=st.ndType||'build'; ndMethod=st.ndMethod||'chat'; } };
function ndInjectFonts(){ if($id('ndFonts')) return; const l=document.createElement('link'); l.id='ndFonts'; l.rel='stylesheet'; l.href='https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'; document.head.appendChild(l); }
window.ndInjectFonts=ndInjectFonts;
function openNovaStart(){ ndInjectFonts(); $id('ndOverlay').style.display='flex'; ndRenderStart(); }
function ndRenderStart(){
  const body=$id('ndBody'); if(!body) return;
  const cur=ND_TYPES.find(t=>t.k===ndType)||ND_TYPES[0];
  const typeCards=ND_TYPES.map(t=>`<button class="ndtype${t.k===ndType?' on':''}" data-ndtype="${t.k}"><span class="ndtb">${esc(t.i)}</span><span class="ndtn">${esc(t.name)}</span><span class="ndtd">${esc(t.desc)}</span></button>`).join('');
  const projs=(window.projectsList&&window.projectsList())||projList().map(([path,name])=>({path,name}));
  const projSel=`<select class="nd-projsel" id="ndProj" title="projeto onde a demanda vai abrir">${projs.map(p=>`<option value="${escA(p.path)}"${p.path===state.repo?' selected':''}>${esc(p.name||projShort(p.path))}</option>`).join('')}</select>`;
  body.innerHTML=`<div class="ndwrap"><div class="ndinner">
    <div class="nd-projrow"><span class="ndeyebrow">passo 1 de 2 · projeto</span>${projs.length?projSel:`<span class="as-mono" style="color:var(--accent);font-size:12px">${esc(projShort(state.repo)||'—')}</span>`}</div>
    <h1 class="ndh1">Que tipo de demanda é essa?</h1>
    <p class="ndsub">O tipo define quais campos são obrigatórios e como o agente trabalha. Dá pra trocar depois sem perder nada.</p>
    <div class="ndtypes">${typeCards}</div>
    <div class="ndstep2"><span class="ndeyebrow">passo 2 · como você quer montar</span><span class="ndline"></span></div>
    <div class="ndmethods">
      <button class="ndm ndm-primary${ndMethod==='chat'?' on':''}" id="ndChat" data-ndm="chat"><span class="ndmtop"><span class="ndmt">Montar conversando</span><span class="ndmbadge">recomendado</span></span><span class="ndmd">A IA pergunta só o essencial e monta a demanda na sua frente. Você revisa e aprova.</span><span class="ndmeta">~7 perguntas · 2 min</span></button>
      <button class="ndm${ndMethod==='form'?' on':''}" id="ndForm" data-ndm="form"><span class="ndmt2">Preencher eu mesmo</span><span class="ndmd">Formulário com todos os campos da demanda. Controle total, sem conversa.</span><span class="ndmeta">~10 campos, um de cada vez</span></button>
      <button class="ndm ndm-orq${ndMethod==='orq'?' on':''}" id="ndOrq" data-ndm="orq"><span class="ndmtop"><span class="ndmt2">Dividir entre vários agentes</span><span class="ndmbadge" style="background:rgba(180,124,224,.2);color:#d9b8f2">problemas grandes</span></span><span class="ndmd">Você descreve o problema inteiro. Um agente coordenador divide em etapas, abre uma tarefa por etapa e acompanha a execução — você aprova o plano antes.</span><span class="ndmeta">1 campo · plano visual das etapas</span></button>
    </div>
    <div class="ndcta"><button class="as-btn primary big" id="ndGo">Continuar${ndMethod==='chat'?' · montar conversando':ndMethod==='form'?' · preencher eu mesmo':' · dividir entre vários agentes'} →</button><span class="dim" style="font-size:12.5px">tipo <b style="color:var(--text)">${esc(cur.name)}</b> · o caminho escolhido abre nesta mesma aba</span></div>
    <div class="ndfoot"><div class="ndfl">já tem um .md? <a id="ndImport">importar</a> · guia de demanda deste repo: <span class="mono" title="arquivo SPEC.md na pasta de trabalho do Starfork (.cardume/)">SPEC.md</span></div></div>
  </div></div>`;
  body.querySelectorAll('[data-ndtype]').forEach(b=>b.onclick=()=>{ ndType=b.dataset.ndtype; ndRenderStart(); });
  { const s=body.querySelector('#ndProj'); if(s) s.onchange=async()=>{ const p=s.value; if(p && p!==state.repo && window.switchProject){ await window.switchProject(p); } ndRenderStart(); }; }
  // 1º clique no card SELECIONA o método; o botão Continuar (ou 2º clique no mesmo card) segue —
  // o caminho escolhido substitui esta aba (cada aba é um fluxo isolado)
  const go=()=>{ const m=ndMethod; if(m==='form') window.ntPresetType=ndType; if(window.openTab) window.openTab(m==='chat'?'planner':m==='form'?'form':'orq', { replace:true }); };
  body.querySelectorAll('[data-ndm]').forEach(b=>b.onclick=()=>{ if(ndMethod===b.dataset.ndm){ go(); return; } ndMethod=b.dataset.ndm; ndRenderStart(); });
  { const b=body.querySelector('#ndGo'); if(b) b.onclick=go; }
  { const b=body.querySelector('#ndImport'); if(b) b.onclick=()=>{ window.ntPresetType=ndType; if(window.openTab) window.openTab('form', { replace:true }); setTimeout(()=>{ const im=$id('ntImport'); if(im) im.click(); }, 300); }; }
}
$id('dailyClose').onclick=()=>{ ovHide('dailyOverlay'); };
$id('dailyDate').onchange=loadDaily;
$id('dailyAI').onclick=dailyAISummary;
$id('dailyDoc').onclick=dailyGenDoc;
$id('dailyOverlay').addEventListener('click',e=>{ if(e.target.id==='dailyOverlay') ovHide('dailyOverlay'); });
