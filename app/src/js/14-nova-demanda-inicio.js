// Constellation — 14-nova-demanda-inicio
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
let ndType='build';
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
      <button class="ndm ndm-primary" id="ndChat"><span class="ndmtop"><span class="ndmt">Montar conversando</span><span class="ndmbadge">recomendado</span></span><span class="ndmd">A IA pergunta só o essencial e preenche o task.yaml na sua frente. Você revisa e aprova.</span><span class="ndmeta">~7 perguntas · 2 min</span></button>
      <button class="ndm" id="ndForm"><span class="ndmt2">Preencher eu mesmo</span><span class="ndmd">Formulário com os campos do spec. Controle total, sem conversa.</span><span class="ndmeta">10 campos · passos</span></button>
      <button class="ndm ndm-orq" id="ndOrq"><span class="ndmtop"><span class="ndmt2">Orquestrar com subagentes</span><span class="ndmbadge" style="background:rgba(180,124,224,.2);color:#d9b8f2">problemas grandes</span></span><span class="ndmd">Você descreve o problema inteiro. Um agente orquestrador quebra em fases, abre uma tarefa por fase e comanda a execução — você aprova o plano antes.</span><span class="ndmeta">1 campo · plano em grafo</span></button>
    </div>
    <div class="ndfoot"><div class="ndfl">já tem um .md? <a id="ndImport">importar</a> · guia deste repo: <span class="mono">.cardume/SPEC.md</span></div><div class="ndft mono">tipo: ${esc(cur.name)}</div></div>
  </div></div>`;
  body.querySelectorAll('[data-ndtype]').forEach(b=>b.onclick=()=>{ ndType=b.dataset.ndtype; ndRenderStart(); });
  { const s=body.querySelector('#ndProj'); if(s) s.onchange=async()=>{ const p=s.value; if(p && p!==state.repo && window.switchProject){ await window.switchProject(p); } ndRenderStart(); }; }
  { const b=body.querySelector('#ndChat'); if(b) b.onclick=()=>{ if(window.openTab) window.openTab('planner'); }; }
  { const b=body.querySelector('#ndForm'); if(b) b.onclick=()=>{ window.ntPresetType=ndType; if(window.openTab) window.openTab('form'); }; }
  { const b=body.querySelector('#ndOrq'); if(b) b.onclick=()=>{ if(window.openTab) window.openTab('orq'); }; }
  { const b=body.querySelector('#ndImport'); if(b) b.onclick=()=>{ window.ntPresetType=ndType; if(window.openTab) window.openTab('form'); setTimeout(()=>{ const im=$id('ntImport'); if(im) im.click(); }, 300); }; }
}
$id('dailyClose').onclick=()=>{ $id('dailyOverlay').style.display='none'; };
$id('dailyDate').onchange=loadDaily;
$id('dailyAI').onclick=dailyAISummary;
$id('dailyDoc').onclick=dailyGenDoc;
$id('dailyOverlay').addEventListener('click',e=>{ if(e.target.id==='dailyOverlay') $id('dailyOverlay').style.display='none'; });
