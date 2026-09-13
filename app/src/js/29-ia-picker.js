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
function aiPickApply(eng, model){
  setSelValue($id('ntEngine'), eng); setSelValue($id('ntModel'), model);
  const hm=$id('howModel'); if(hm) setSelValue(hm, model);
  aiPickRender();
}
let _aiCustomOpen=false;
function aiPickRender(){
  const hosts=[...document.querySelectorAll('.aipick')]; if(!hosts.length) return;
  let eng=($id('ntEngine')||{}).value||'claude'; if(eng==='logcomex'){ eng='gateway'; setSelValue($id('ntEngine'),'gateway'); }
  const model=($id('ntModel')||{}).value||'';
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
    `<div class="airec">${isRecSel?'✓ ':'✦ '}${esc(rec.reason)}${isRecSel?'':` — <a data-airec>usar ${esc(rec.label)}</a>`}</div>`;
  hosts.forEach(h=>{
    h.innerHTML=html;
    h.querySelectorAll('[data-aieng]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(b.dataset.aieng, ''); });
    h.querySelectorAll('[data-aimodel]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(eng, b.dataset.aimodel); });
    h.querySelectorAll('[data-airec]').forEach(a=>a.onclick=()=>{ _aiCustomOpen=false; aiPickApply(rec.engine, rec.model); });
    h.querySelectorAll('[data-aicustom]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=true; aiPickRender(); const i=h.querySelector('#aiCustomId'); if(i) i.focus(); });
    h.querySelectorAll('[data-aicustomok]').forEach(b=>b.onclick=()=>{ const i=h.querySelector('#aiCustomId'); const v=(i&&i.value.trim())||''; _aiCustomOpen=false; aiPickApply(eng, v); });
    { const i=h.querySelector('#aiCustomId'); if(i) i.onkeydown=ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); _aiCustomOpen=false; aiPickApply(eng, i.value.trim()); } }; }
    h.querySelectorAll('[data-aicfg]').forEach(a=>a.onclick=()=>{ if(typeof openCfg==='function') openCfg(); });
  });
}
// a recomendação acompanha o que você digita (design/investigação são página única)
let _aiPickT=null;
['ntDzTitle','ntDzObj','ntInvTitle','ntInvObj'].forEach(id=>{ const e=$id(id); if(e) e.addEventListener('input',()=>{ clearTimeout(_aiPickT); _aiPickT=setTimeout(aiPickRender,400); }); });
