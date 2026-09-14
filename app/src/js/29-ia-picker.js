// Constellation — 29-ia-picker: "Com qual IA?" — motor + versão do modelo com ícones e recomendação pela demanda.
// Fonte da verdade continua sendo os selects escondidos #ntEngine e #ntModel (o CLI recebe --engine/--model).
// Como as versões chegam ao modelo: o Claude Code aceita um ALIAS (opus/sonnet/haiku = a versão mais nova do seu
// plano) ou o id COMPLETO (ex.: claude-opus-4-8). O app não descobre a lista sozinho — ela é curada aqui e
// qualquer id pode ser digitado em "outro id…". O gateway vem da config da conta (Configurações → Gateway próprio).
const AI_CLAUDE_MODELS=[
  {id:'',name:'Padrão da assinatura',tag:'auto'},
  {id:'opus',name:'Opus',tag:'alias · mais capaz'}, {id:'sonnet',name:'Sonnet',tag:'alias · equilíbrio'}, {id:'haiku',name:'Haiku',tag:'alias · mais veloz'},
  {id:'claude-fable-5-1',name:'Fable 5.1',tag:'id fixo'}, {id:'claude-opus-5',name:'Opus 5',tag:'id fixo'}, {id:'claude-sonnet-5',name:'Sonnet 5',tag:'id fixo'},
  {id:'claude-opus-4-8',name:'Opus 4.8',tag:'id fixo'}, {id:'claude-haiku-4-5-20251001',name:'Haiku 4.5',tag:'id fixo'},
];
const AI_ENGINES=[
  { id:'claude', name:'Claude', vendor:'Anthropic · assinatura', color:'#d97757', custom:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>',
    desc:'Claude Code — o mais completo: plano, ferramentas, provas e review na mesma sessão. Alias = sempre a versão mais nova do seu plano; id fixo trava a versão.',
    models:AI_CLAUDE_MODELS },
  { id:'codex', name:'Codex', vendor:'OpenAI', color:'#10a37f', custom:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2M3.15 5.2l9.7 5.6M3.15 10.8l9.7-5.6" stroke-linecap="round"/></svg>',
    desc:'Codex CLI com a chave OpenAI da sua conta (Conta → Chaves de modelo).',
    models:[ {id:'',name:'Padrão do Codex',tag:'auto'}, {id:'gpt-5-codex',name:'GPT-5 Codex',tag:'código'}, {id:'gpt-5',name:'GPT-5',tag:'geral'}, {id:'o4-mini',name:'o4-mini',tag:'rápido'} ] },
  { id:'gateway', name:'Gateway próprio', vendor:'OpenAI-compatível', color:'#5b9df9', custom:true, dynamic:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="4" rx="1.2"/><rect x="2.5" y="9" width="11" height="4" rx="1.2"/><path d="M5 5h.01M5 11h.01" stroke-width="2" stroke-linecap="round"/></svg>',
    desc:'O endpoint da SUA empresa (vLLM, LiteLLM, Azure, Ollama…). URL, chave e modelos ficam na sua conta: Configurações → Gateway próprio.',
    models:[] },
  { id:'mock', name:'Mock', vendor:'sem IA', color:'#8b959b',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.4" stroke-dasharray="2.6 2.2"/></svg>',
    desc:'Simula a execução sem chamar modelo — só pra testar o fluxo.', models:[] },
];
const AI_TIER_LABEL={ opus:'Claude Opus', sonnet:'Claude Sonnet', haiku:'Claude Haiku' };
// gateway configurado na conta (~/.constellation/llm.env): nome, endpoint e modelos
let _aiGw=null, _aiGwAt=0;
async function aiGatewayInfo(){
  if(_aiGw && Date.now()-_aiGwAt<15000) return _aiGw;
  let txt=''; try{ txt=await invoke('read_llm_env'); }catch(_){ }
  const g=k=>{ const m=String(txt||'').match(new RegExp('^'+k+'\\s*=(.*)$','m')); return m?m[1].trim():''; };
  const baseUrl=g('ALT_AI_BASE_URL'), key=g('ALT_AI_KEY')||g('LGCX_API_KEY');
  const isLgcx=/logcomex/i.test(baseUrl||'') || (!baseUrl && !!g('LGCX_API_KEY'));
  const model=g('ALT_AI_MODEL')||(isLgcx?'logcomex-v2':'');
  let models=g('ALT_AI_MODELS').split(',').map(s=>s.trim()).filter(Boolean);
  if(!models.length && isLgcx) models=['logcomex-v2','qwen3.8-27b'];
  if(model && !models.includes(model)) models.unshift(model);
  let host=''; try{ host=new URL(baseUrl||(isLgcx?'https://llm.logcomex.ai/v1':'')).host; }catch(_){ }
  _aiGw={ configured:!!key && !!(baseUrl||isLgcx), label:g('ALT_AI_LABEL')||(isLgcx?'Logcomex AI':'Gateway próprio'), host, model, models };
  _aiGwAt=Date.now(); return _aiGw;
}
// o que a tela sabe da demanda AGORA (por modo)
function aiSpecSnapshot(){
  const v=id=>{ const e=$id(id); return e?String(e.value||'').trim():''; };
  const m=(typeof ntMode!=='undefined')?ntMode:'build';
  const F={ build:['ntTitle','ntObj'], fix:['ntFixTitle','ntFixObj'], design:['ntDzTitle','ntDzObj'], invest:['ntInvTitle','ntInvObj'], review:['ntPr','ntPr'] }[m]||['ntTitle','ntObj'];
  const nReq=(m==='build'&&typeof ntReq!=='undefined')?ntReq.filter(Boolean).length:(m==='fix'&&typeof ntFixReq!=='undefined')?ntFixReq.filter(Boolean).length:0;
  return { mode:m, title:v(F[0]), objective:v(F[1]), nReq };
}
// heurística: tipo + tamanho + palavras-chave → versão do Claude (o motor que o app conhece melhor)
function aiRecommend(s){
  const txt=((s.title||'')+' '+(s.objective||'')).toLowerCase();
  const heavy=/(refator|arquitet|migra|segur|auth|autentic|concorr|performance|escal|banco|schema|integra|infra|deploy|\bci\b|streaming|websocket|multi|épico|epico|reescrev)/.test(txt);
  const light=/(typo|texto|label|rótulo|\bcor\b|cores|css|padding|margem|ícone|icone|\bdoc\b|docs|readme|comentário|renomear|traduz|tooltip)/.test(txt);
  const len=txt.length, nReq=s.nReq||0;
  let tier, why;
  if(s.mode==='review'){ tier='sonnet'; why='review de PR: Sonnet lê o diff com qualidade e custa menos'; }
  else if(s.mode==='invest'||s.mode==='design'){ tier='opus'; why=(s.mode==='invest'?'investigação':'design')+' pede raciocínio profundo e leitura ampla do código'; }
  else if(heavy||len>700||nReq>=4){ tier='opus'; why=heavy?'a demanda toca arquitetura/integração — vale o modelo mais capaz':'demanda longa, com vários critérios — vale o modelo mais capaz'; }
  else if(light&&len<260){ tier='haiku'; why='ajuste pequeno e bem delimitado — o mais veloz resolve em minutos'; }
  else { tier='sonnet'; why='escopo médio e claro — Sonnet equilibra qualidade, velocidade e custo'; }
  return { engine:'claude', model:tier, label:AI_TIER_LABEL[tier], reason:why };
}
function setSelValue(sel, v){ if(!sel) return; v=v||''; if(![...sel.options].some(o=>o.value===v)) sel.add(new Option(v, v)); sel.value=v; }
// ---- padrão do USUÁRIO (Configurações → IA padrão): vale pra toda demanda nova, do formulário ou do chat ----
function aiDefaults(){ return { eng:lsGet('defaultEngine')||'claude', model:lsGet('defaultModel')||'' }; }
function aiApplyDefaults(){ const d=aiDefaults(); setSelValue($id('ntEngine'), d.eng); setSelValue($id('ntModel'), d.model); const hm=$id('howModel'); if(hm) setSelValue(hm, d.model); }
function aiModelName(id){ if(!id) return 'padrão da assinatura'; for(const e of AI_ENGINES){ const m=(e.models||[]).find(x=>x.id===id); if(m) return m.name; } return id; }
// alvo do seletor: o FORMULÁRIO (selects escondidos) ou as CONFIGURAÇÕES (localStorage)
const AI_TARGET_FORM={ sel:'.aipick:not(.aipick-cfg)', get:()=>({ eng:($id('ntEngine')||{}).value||'claude', model:($id('ntModel')||{}).value||'' }), set:(e,m)=>{ setSelValue($id('ntEngine'), e); setSelValue($id('ntModel'), m); const hm=$id('howModel'); if(hm) setSelValue(hm, m); } };
const AI_TARGET_CFG={ sel:'.aipick-cfg', cfg:true, get:aiDefaults, set:(e,m)=>{ lsSet('defaultEngine', e||'claude'); lsSet('defaultModel', m||''); } };
function aiPickApply(eng, model, target){
  target=target||AI_TARGET_FORM; target.set(eng, model);
  aiPickRender(target);
}
let _aiCustomOpen=false;
function aiPickRender(target){
  target=target||AI_TARGET_FORM;
  const hosts=[...document.querySelectorAll(target.sel)]; if(!hosts.length) return;
  let { eng, model }=target.get(); if(eng==='logcomex'){ eng='gateway'; target.set('gateway', model); }
  const rec=aiRecommend(aiSpecSnapshot());
  const e=AI_ENGINES.find(x=>x.id===eng)||AI_ENGINES[0];
  // gateway: nome/modelos vêm da conta (assíncrono — renderiza de novo quando chegar)
  const gwCard=AI_ENGINES.find(x=>x.id==='gateway');
  if(!_aiGw){ aiGatewayInfo().then(()=>aiPickRender()); }
  const gw=_aiGw||{ configured:false, label:'Gateway próprio', host:'', model:'', models:[] };
  gwCard.name=gw.label; gwCard.vendor=gw.configured?(gw.host||'OpenAI-compatível'):'não configurado';
  gwCard.models=gw.configured?[{id:'',name:gw.model||'padrão do gateway',tag:'padrão'},...gw.models.filter(m=>m!==gw.model).map(m=>({id:m,name:m,tag:''}))]:[];
  const models=e.models||[];
  const known=models.some(m=>m.id===model);
  const isRecSel=rec.engine===eng&&rec.model===model;
  const html=`<div class="aieng">${AI_ENGINES.map(x=>`<button type="button" class="aicard${x.id===eng?' on':''}${x.dynamic&&!gw.configured?' off':''}" data-aieng="${x.id}"><span class="aiic" style="color:${x.color}">${x.icon}</span><span class="ain">${esc(x.name)}</span><span class="aiv">${esc(x.vendor)}</span></button>`).join('')}</div>`+
    `<div class="aidesc">${esc(e.desc)}${e.id==='gateway'&&!gw.configured?` <a data-aicfg>configurar agora</a>`:''}</div>`+
    (models.length||e.custom?`<div class="aimodels">${models.map(m=>{ const r=rec.engine===e.id&&rec.model===m.id; return `<button type="button" class="aimodel${m.id===model?' on':''}${r?' rec':''}" data-aimodel="${escA(m.id)}"><b>${esc(m.name)}</b>${m.tag?`<span>${esc(m.tag)}</span>`:''}${r?'<i>recomendado</i>':''}</button>`; }).join('')}`+
      (e.custom?`<button type="button" class="aimodel${(!known&&model)?' on':''}" data-aicustom><b>${(!known&&model)?esc(model):'outro id…'}</b><span>${(!known&&model)?'id digitado':'digite o id exato'}</span></button>`:'')+`</div>`:'')+
    (_aiCustomOpen?`<div class="aicustom"><input class="in mono" id="aiCustomId" placeholder="${e.id==='claude'?'ex.: claude-opus-4-8':e.id==='codex'?'ex.: gpt-5-codex':'id do modelo no gateway'}" value="${escA((!known&&model)?model:'')}"><button type="button" class="btn sm" data-aicustomok>usar</button></div>`:'')+
    (target.cfg?`<div class="airec">✓ padrão pra toda demanda nova — pelo formulário ou pelo chat. A recomendação por demanda continua sendo só uma sugestão.</div>`:`<div class="airec">${isRecSel?'✓ ':'✦ '}${esc(rec.reason)}${isRecSel?'':` — <a data-airec>usar ${esc(rec.label)}</a>`}</div>`);
  hosts.forEach(h=>{
    h.innerHTML=html;
    h.querySelectorAll('[data-aieng]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(b.dataset.aieng, '', target); });
    h.querySelectorAll('[data-aimodel]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(eng, b.dataset.aimodel, target); });
    h.querySelectorAll('[data-airec]').forEach(a=>a.onclick=()=>{ _aiCustomOpen=false; aiPickApply(rec.engine, rec.model, target); });
    h.querySelectorAll('[data-aicustom]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=true; aiPickRender(target); const i=h.querySelector('#aiCustomId'); if(i) i.focus(); });
    h.querySelectorAll('[data-aicustomok]').forEach(b=>b.onclick=()=>{ const i=h.querySelector('#aiCustomId'); const v=(i&&i.value.trim())||''; _aiCustomOpen=false; aiPickApply(eng, v, target); });
    { const i=h.querySelector('#aiCustomId'); if(i) i.onkeydown=ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); _aiCustomOpen=false; aiPickApply(eng, i.value.trim(), target); } }; }
    h.querySelectorAll('[data-aicfg]').forEach(a=>a.onclick=()=>{ if(typeof openCfg==='function') openCfg(); });
  });
}
// ---- trocar o modelo de uma demanda JÁ criada (menu ⋯ e cabeçalho da tarefa) ----
function openModelMenu(taskId, anchor){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  $id('tmenuPop')?.remove();
  const pop=document.createElement('div'); pop.id='tmenuPop';
  pop.style.cssText='position:fixed;z-index:9000;min-width:240px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);padding:5px';
  const cur=t.model||'';
  const head=document.createElement('div'); head.className='mono'; head.style.cssText='font-size:10px;letter-spacing:.08em;color:var(--muted);padding:6px 10px 4px;text-transform:uppercase'; head.textContent='modelo desta demanda'; pop.appendChild(head);
  const apply=async(id)=>{ pop.remove(); try{ await invoke('set_task_model',{ taskId, model:id }); lastSig=''; await refresh(); if(typeof renderWorkspace==='function' && typeof fwTask!=='undefined' && fwTask===taskId) renderWorkspace(); }catch(e){ alert('Falhou: '+e); } };
  const item=(label, id, on)=>{ const b=document.createElement('button'); b.innerHTML=`${on?'<span style="color:var(--accent)">✓</span> ':'<span style="opacity:0">✓</span> '}${esc(label)}`; b.style.cssText='display:block;width:100%;text-align:left;border:0;background:none;color:var(--text);font:inherit;font-size:12.5px;padding:7px 10px;border-radius:7px;cursor:pointer'; b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none'; b.onclick=()=>apply(id); pop.appendChild(b); };
  AI_CLAUDE_MODELS.forEach(m=>item(m.name+(m.tag?'  · '+m.tag:''), m.id, m.id===cur));
  if(cur && !AI_CLAUDE_MODELS.some(m=>m.id===cur)) item(cur+'  · id atual', cur, true);
  item('outro id…', '__custom', false);
  pop.querySelector('button:last-child').onclick=async()=>{ pop.remove(); const v=await askText('Id do modelo','ex.: claude-opus-4-8', cur); if(v!=null && v.trim()) apply(v.trim()); };
  const note=document.createElement('div'); note.className='dim'; note.style.cssText='font-size:10.5px;padding:6px 10px 4px;line-height:1.4'; note.textContent='vale a partir do próximo turno do agente'; pop.appendChild(note);
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect(); pop.style.top=Math.min(window.innerHeight-pop.offsetHeight-8, r.bottom+6)+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.left))+'px';
  setTimeout(()=>document.addEventListener('click', function h(e){ if(!pop.contains(e.target)){ pop.remove(); document.removeEventListener('click', h); } }), 0);
}
// aplica o padrão do usuário nos selects do formulário na carga (o chat/planner lê dali)
aiApplyDefaults();
// a recomendação acompanha o que você digita (design/investigação são página única)
let _aiPickT=null;
['ntDzTitle','ntDzObj','ntInvTitle','ntInvObj'].forEach(id=>{ const e=$id(id); if(e) e.addEventListener('input',()=>{ clearTimeout(_aiPickT); _aiPickT=setTimeout(aiPickRender,400); }); });
