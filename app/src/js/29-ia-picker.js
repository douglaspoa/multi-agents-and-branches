// Constellation — 29-ia-picker: "Com qual IA?" — motor + versão do modelo com ícones e recomendação pela demanda.
// Fonte da verdade continua sendo os selects escondidos #ntEngine e #ntModel (o CLI recebe --engine/--model).
const AI_ENGINES=[
  { id:'claude', name:'Claude', vendor:'Anthropic · assinatura', color:'#d97757',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>',
    desc:'Claude Code — o mais completo: plano, ferramentas, provas e review na mesma sessão.',
    models:[ {id:'',name:'Padrão da assinatura',tag:'auto'}, {id:'opus',name:'Opus',tag:'mais capaz'}, {id:'sonnet',name:'Sonnet',tag:'equilíbrio'}, {id:'haiku',name:'Haiku',tag:'mais veloz'} ] },
  { id:'codex', name:'Codex', vendor:'OpenAI', color:'#10a37f',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2M3.15 5.2l9.7 5.6M3.15 10.8l9.7-5.6" stroke-linecap="round"/></svg>',
    desc:'Codex CLI com a chave OpenAI da sua conta (Conta → Chaves de modelo).',
    models:[ {id:'',name:'Padrão do Codex',tag:'auto'}, {id:'gpt-5-codex',name:'GPT-5 Codex',tag:'código'}, {id:'gpt-5',name:'GPT-5',tag:'geral'}, {id:'o4-mini',name:'o4-mini',tag:'rápido'} ] },
  { id:'logcomex', name:'Logcomex AI', vendor:'gateway interno', color:'#5b9df9',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 10.5h11l-1.6 2.6H4.1z"/><path d="M4.2 10.5V6.2h4.6l2.6 2.4v1.9"/><path d="M6.5 6.2V3.6h2.3v2.6" stroke-linecap="round"/></svg>',
    desc:'Servidor de modelos da Logcomex (LGCX_API_KEY da conta). Bom pra volume e custo.',
    models:[ {id:'',name:'logcomex-v2',tag:'DeepSeek V4 Flash · 1M'}, {id:'qwen3.8-27b',name:'Qwen 3.8 27B',tag:'3× mais rápido'} ] },
  { id:'mock', name:'Mock', vendor:'sem IA', color:'#8b959b',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.4" stroke-dasharray="2.6 2.2"/></svg>',
    desc:'Simula a execução sem chamar modelo — só pra testar o fluxo.', models:[] },
];
const AI_TIER_LABEL={ opus:'Claude Opus', sonnet:'Claude Sonnet', haiku:'Claude Haiku' };
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
function aiPickRender(){
  const hosts=[...document.querySelectorAll('.aipick')]; if(!hosts.length) return;
  const eng=($id('ntEngine')||{}).value||'claude', model=($id('ntModel')||{}).value||'';
  const rec=aiRecommend(aiSpecSnapshot());
  const e=AI_ENGINES.find(x=>x.id===eng)||AI_ENGINES[0];
  const isRecSel=rec.engine===eng&&rec.model===model;
  const html=`<div class="aieng">${AI_ENGINES.map(x=>`<button type="button" class="aicard${x.id===eng?' on':''}" data-aieng="${x.id}"><span class="aiic" style="color:${x.color}">${x.icon}</span><span class="ain">${esc(x.name)}</span><span class="aiv">${esc(x.vendor)}</span></button>`).join('')}</div>`+
    `<div class="aidesc">${esc(e.desc)}</div>`+
    (e.models.length?`<div class="aimodels">${e.models.map(m=>{ const r=rec.engine===e.id&&rec.model===m.id; return `<button type="button" class="aimodel${m.id===model?' on':''}${r?' rec':''}" data-aimodel="${escA(m.id)}"><b>${esc(m.name)}</b>${m.tag?`<span>${esc(m.tag)}</span>`:''}${r?'<i>recomendado</i>':''}</button>`; }).join('')}</div>`:'')+
    `<div class="airec">${isRecSel?'✓ ':'✦ '}${esc(rec.reason)}${isRecSel?'':` — <a data-airec>usar ${esc(rec.label)}</a>`}</div>`;
  hosts.forEach(h=>{
    h.innerHTML=html;
    h.querySelectorAll('[data-aieng]').forEach(b=>b.onclick=()=>aiPickApply(b.dataset.aieng, ''));
    h.querySelectorAll('[data-aimodel]').forEach(b=>b.onclick=()=>aiPickApply(eng, b.dataset.aimodel));
    h.querySelectorAll('[data-airec]').forEach(a=>a.onclick=()=>aiPickApply(rec.engine, rec.model));
  });
}
// a recomendação acompanha o que você digita (design/investigação são página única)
let _aiPickT=null;
['ntDzTitle','ntDzObj','ntInvTitle','ntInvObj'].forEach(id=>{ const e=$id(id); if(e) e.addEventListener('input',()=>{ clearTimeout(_aiPickT); _aiPickT=setTimeout(aiPickRender,400); }); });
