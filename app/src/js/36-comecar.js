// Starfork — 36-comecar
// ===== "Começar sem portões" (mesa de 27/09): a tela sem projeto vira "O que você quer fazer?".
// O texto vira um nome de pasta (local, sem IA), o app cria ~/Documents/Starfork/<nome> com git por baixo
// (SEM GitHub, sem gh) e abre o "Montar conversando" com o pedido já enviado.
// Os itens da barra lateral que não fazem nada sem projeto ficam apagados, com o motivo no tooltip.

// palavras que não ajudam a nomear a pasta ("um app de agendamento de aulas" → "app-agendamento-aulas")
const EM_STOP=new Set(('a o as os um uma uns umas de da do das dos d e ou em no na nos nas num numa pra pro pras pros para por '+
  'com sem que quero queria preciso gostaria fazer criar crie faca montar construir desenvolver ter tipo algo coisa '+
  'meu minha meus minhas seu sua nosso nossa esse essa este esta isso isto ao aos la lo me mim eu voce the an of to for and').split(' '));
function emSlug(text){
  const words=String(text||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
  const good=words.filter(w=>!EM_STOP.has(w) && w.length>1);
  let slug=(good.length?good:words).slice(0,4).join('-');
  if(slug.length>40) slug=slug.slice(0,40).replace(/-[^-]*$/,'')||slug.slice(0,40);
  return slug.replace(/^-+|-+$/g,'');
}
let emName='', emNameCustom=false, emEditing=false, emBusy=false, emTargetTimer=null, emTarget='';
function emCurName(){ return (emNameCustom && emName) ? emName :emSlug(($id('emWhat')||{}).value||''); }
function emRenderWhere(){
  const el=$id('emWhere'); if(!el) return;
  const nm=emCurName();
  if(emEditing){
    el.innerHTML=`<span class="dim">Nome da pasta:</span> <span class="mono dim">~/Documents/Starfork/</span><input class="in mono emnamein" id="emNameIn" value="${escA(nm)}" spellcheck="false"> <a id="emNameOk">ok</a>`;
    const i=$id('emNameIn');
    if(i){ i.focus(); i.select();
      // nome digitado pela pessoa: só limpa (acento, espaço, símbolo) — não tira palavras como o emSlug faz
      i.oninput=()=>{ emName=String(i.value||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9._]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60); emNameCustom=true; };
      i.onkeydown=(e)=>{ if(e.key==='Enter'){ e.preventDefault(); emEditing=false; emRenderWhere(); } if(e.key==='Escape'){ emEditing=false; emRenderWhere(); } };
      i.onblur=()=>setTimeout(()=>{ if(emEditing){ emEditing=false; emRenderWhere(); } },150); }
    bindClick('emNameOk', ()=>{ emEditing=false; emRenderWhere(); });
    return;
  }
  if(!nm){ el.innerHTML=''; return; }
  // o Rust diz o nome LIVRE (com -2, -3… se a pasta já existe); até responder, mostra o nome base
  const tl=pathBase(emTarget), shown=(tl===nm || (tl.startsWith(nm+'-') && /^\d+$/.test(tl.slice(nm.length+1)))) ? tl : nm;
  el.innerHTML=`Vou criar a pasta <span class="mono">~/Documents/Starfork/<b>${esc(shown)}</b></span> <span class="dim">·</span> <a id="emRename">mudar nome</a>`;
  bindClick('emRename', ()=>{ emName=nm; emNameCustom=true; emEditing=true; emRenderWhere(); });
  clearTimeout(emTargetTimer);
  emTargetTimer=setTimeout(async()=>{
    try{ const t=await invoke('quick_project_target',{ name:nm }); if(t && t!==emTarget && emCurName()===nm){ emTarget=String(t); emRenderWhere(); } }catch(_){}
  }, 350);
}
function emShowErr(msg){ const e=$id('emErr'); if(!e) return; e.style.display=msg?'block':'none'; e.textContent=msg||''; }
async function emStart(){
  if(emBusy) return;
  const ta=$id('emWhat'); const text=((ta&&ta.value)||'').trim();
  if(!text){ if(ta){ ta.focus(); ta.classList.add('ndshake'); setTimeout(()=>ta.classList.remove('ndshake'),450); } return; }
  const name=emCurName()||'meu-projeto';
  emBusy=true; emShowErr('');
  const b=$id('emGo'); if(b){ b.disabled=true; b.textContent='criando a pasta…'; }
  try{
    const path=await invoke('quick_create_project',{ name });
    selected=null; lastSig=''; if(typeof clearProjectCaches==='function') clearProjectCaches();
    await refresh(); if(typeof loadProjects==='function') await loadProjects();
    if(ta) ta.value=''; emName=''; emNameCustom=false; emTarget='';
    toast('Projeto criado em '+String(path||'').replace(/^\/Users\/[^/]+/,'~'),'ok');
    if(window.plStartWith) window.plStartWith(text);
  }catch(e){
    const m=String((e&&e.message)||e||'');
    emShowErr(/não está instalado/.test(m) ? m : 'Não deu pra criar o projeto: '+m); // git ausente: o Rust já manda a mensagem com o conserto
  }finally{
    emBusy=false; if(b){ b.disabled=false; b.textContent='Começar'; }
    emRenderWhere();
  }
}
{ const ta=$id('emWhat');
  if(ta){
    ta.addEventListener('input',()=>{ if(!emNameCustom) emRenderWhere(); emShowErr(''); });
    ta.addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); emStart(); } });
  }
  document.querySelectorAll('[data-emex]').forEach(c=>c.onclick=()=>{ const t=$id('emWhat'); if(!t) return; t.value=c.dataset.emex; emNameCustom=false; emRenderWhere(); t.focus(); });
  bindClick('emGo', emStart);
  emRenderWhere();
}

// ---- barra lateral sem projeto: apaga (não some) o que só funciona dentro de um projeto ----
const NOPROJ_IDS=['skillsBtn','issuesBtn','agentsBtn','pcBtn','dailyBtn'];
const NOPROJ_TIP='abra ou crie um projeto primeiro';
function noProjSync(){
  const none=!(typeof state!=='undefined' && state && state.repo);
  NOPROJ_IDS.forEach(id=>{ const b=$id(id); if(!b) return;
    if(b.dataset.tip0===undefined) b.dataset.tip0=b.getAttribute('title')||'';
    b.classList.toggle('noproj', none);
    b.setAttribute('aria-disabled', none?'true':'false');
    b.setAttribute('title', none ? NOPROJ_TIP : b.dataset.tip0);
  });
}
// clique num item apagado: explica e leva pra caixa "O que você quer fazer?" (captura: antes do handler do item)
document.addEventListener('click', e=>{
  const b=e.target.closest&&e.target.closest(NOPROJ_IDS.map(i=>'#'+i).join(','));
  if(!b || !b.classList.contains('noproj')) return;
  e.preventDefault(); e.stopImmediatePropagation();
  toast('Abra ou crie um projeto primeiro — é só dizer o que você quer fazer na tela inicial.','warn');
  if(window.openTab) window.openTab('flow');
  setTimeout(()=>{ const t=$id('emWhat'); if(t) t.focus(); }, 60);
}, true);
noProjSync();
