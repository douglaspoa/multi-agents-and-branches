// Starfork — 29-ia-picker: "Com qual IA?" — motor + versão do modelo com ícones e recomendação pela demanda.
// Fonte da verdade continua sendo os selects escondidos #ntEngine e #ntModel (o CLI recebe --engine/--model).
// Como as versões chegam ao modelo: o Claude Code aceita um ALIAS (opus/sonnet/haiku = a versão mais nova do seu
// plano) ou o id COMPLETO (ex.: claude-opus-5-5). O app não descobre a lista sozinho — ela é curada aqui e
// qualquer id pode ser digitado em "outro id…". O gateway vem da config da conta (Configurações → Gateway próprio).
const AI_CLAUDE_MODELS=[
  {id:'',name:'Padrão da assinatura',tag:'auto'},
  {id:'opus',name:'Opus',tag:'alias · mais capaz'}, {id:'sonnet',name:'Sonnet',tag:'alias · equilíbrio'}, {id:'haiku',name:'Haiku',tag:'alias · mais veloz'},
  {id:'claude-fable-5-1',name:'Fable 5.1',tag:'id fixo'}, {id:'claude-opus-5-5',name:'Opus 5.5',tag:'id fixo · mais novo'}, {id:'claude-opus-5',name:'Opus 5',tag:'id fixo'}, {id:'claude-sonnet-5',name:'Sonnet 5',tag:'id fixo'},
  {id:'claude-opus-4-8',name:'Opus 4.8',tag:'id fixo'}, {id:'claude-haiku-4-5-20251001',name:'Haiku 4.5',tag:'id fixo'},
];
// @cor-dado-inicio — cor de MARCA de cada fornecedor de IA (identidade do produto deles, igual nos dois temas)
const AI_ENGINES=[
  { id:'claude', name:'Claude', vendor:'Anthropic · assinatura', color:'#d97757', custom:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>',
    desc:'Claude Code — o mais completo: plano, ferramentas, provas e review na mesma sessão. Alias = sempre a versão mais nova do seu plano; id fixo trava a versão.',
    models:AI_CLAUDE_MODELS },
  { id:'codex', name:'Codex', vendor:'OpenAI', color:'#10a37f', custom:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2M3.15 5.2l9.7 5.6M3.15 10.8l9.7-5.6" stroke-linecap="round"/></svg>',
    desc:'Codex CLI com o login da sua conta do ChatGPT (Plus/Pro/Team — igual ao Claude Code com o plano Claude). Sem plano do ChatGPT, dá pra usar uma chave da OpenAI. Configure em Configurações → Sua IA.',
    models:[ {id:'',name:'Padrão do Codex',tag:'auto'}, {id:'gpt-5-codex',name:'GPT-5 Codex',tag:'código'}, {id:'gpt-5',name:'GPT-5',tag:'geral'}, {id:'o4-mini',name:'o4-mini',tag:'rápido'} ] },
  { id:'gateway', name:'Gateway próprio', vendor:'OpenAI-compatível', color:'#5b9df9', custom:true, dynamic:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="4" rx="1.2"/><rect x="2.5" y="9" width="11" height="4" rx="1.2"/><path d="M5 5h.01M5 11h.01" stroke-width="2" stroke-linecap="round"/></svg>',
    desc:'O endpoint da SUA empresa (vLLM, LiteLLM, Azure, Ollama…). URL, chave e modelos ficam na sua conta: Configurações → Gateway próprio.',
    models:[] },
  // BETA: DeepSeek Harness (dsh, MIT) — open source, pra quem não tem plano da Anthropic nem da OpenAI (ex.: alunos)
  { id:'deepseek', name:'DeepSeek beta', vendor:'open source · beta', color:'#4d6bfe', custom:true, beta:true,
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 9.2c1.6 2.9 5 4.1 8 2.7 2-.9 3.3-2.9 3.5-5-1 .9-2.2 1.2-3.4.9"/><path d="M2.2 9.2C2 6.4 4 4 6.8 3.6c1.6-.2 3.1.4 4.1 1.5"/><circle cx="10.6" cy="6.3" r=".6" fill="currentColor"/></svg>',
    desc:'BETA — DeepSeek Harness (open source, dsh) com a chave da DeepSeek da sua conta (Configurações → Sua IA). Instale com: npm i -g @deepseek-ai/dsh. Os logs das sessões NÃO são enviados à DeepSeek.',
    models:[ {id:'',name:'Padrão (capaz)',tag:'auto · v4-pro'}, {id:'deepseek-v4-pro',name:'DeepSeek V4 Pro',tag:'mais capaz'}, {id:'deepseek-flash',name:'DeepSeek Flash',tag:'mais veloz'} ] },
  { id:'mock', name:'Mock', vendor:'sem IA', color:'var(--muted)',
    icon:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.4" stroke-dasharray="2.6 2.2"/></svg>',
    desc:'Simula a execução sem chamar modelo — só pra testar o fluxo.', models:[] },
];
// @cor-dado-fim
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
// ---- padrão do USUÁRIO (Configurações → Sua IA): vale pra toda demanda nova, do formulário ou do chat ----
function aiDefaults(){ return { eng:lsGet('defaultEngine')||'claude', model:lsGet('defaultModel')||'' }; }
// ESPELHA a IA padrão em ~/.constellation/settings.json (aiEngine/aiModel): é dali que o Rust e o motor TS
// tiram a IA das chamadas auxiliares (spec com IA, título, previsão, relatórios, retro…) — sem isso,
// quem escolheu Codex/gateway continuava precisando do Claude Code. Mock não é IA: auxiliar segue no claude.
let _aiSynced='', _aiSyncQ=Promise.resolve(), _aiSyncRetry=false;
function aiSyncSettings(eng, model){
  if(eng===undefined){ const d=aiDefaults(); eng=d.eng; model=d.model; }
  let e=aiEngineOf(eng); if(e==='mock') e='claude';
  const m=String(model||''), sig=e+'|'+m;
  if(typeof invoke!=='function') return Promise.resolve(false);
  // FILA única: cada sync espera o anterior (duas em paralelo intercalavam aiEngine/aiModel de escolhas diferentes);
  // em série dentro dela também — o write_setting lê-altera-grava o arquivo inteiro
  const job=_aiSyncQ.then(()=>{
    if(sig===_aiSynced) return false;
    return invoke('write_setting',{ key:'aiEngine', value:e }).then(()=>invoke('write_setting',{ key:'aiModel', value:m }))
      .then(()=>{ _aiSynced=sig; return true; })
      .catch(()=>{ aiSyncRetryOnFocus(); return false; });
  });
  _aiSyncQ=job.catch(()=>false);
  return job;
}
// falhou (ex.: boot com o backend ainda subindo) → tenta UMA vez de novo quando a janela ganhar foco
function aiSyncRetryOnFocus(){
  if(_aiSyncRetry || typeof window==='undefined' || !window.addEventListener) return;
  _aiSyncRetry=true;
  window.addEventListener('focus', function h(){ window.removeEventListener && window.removeEventListener('focus', h); aiSyncSettings(); }, { once:true }); // uma vez só (o flag não volta)
}
function aiSaveDefaults(eng, model){ lsSet('defaultEngine', eng||'claude'); lsSet('defaultModel', model||''); aiSyncSettings(eng||'claude', model||''); }
function aiApplyDefaults(){ const d=aiDefaults(); setSelValue($id('ntEngine'), d.eng); setSelValue($id('ntModel'), d.model); const hm=$id('howModel'); if(hm) setSelValue(hm, d.model); }
function aiModelName(id){ if(!id) return 'padrão da assinatura'; for(const e of AI_ENGINES){ const m=(e.models||[]).find(x=>x.id===id); if(m) return m.name; } return id; }
// motor de um papel/tarefa pelo rótulo salvo — MESMA regra do engineKind do motor (src/orchestrator.ts)
function aiEngineOf(e){ const n=String(e||'').trim().toLowerCase(); return n==='mock'||!n?'mock':n.startsWith('codex')?'codex':(n.startsWith('deepseek')||/^dsh\b/.test(n))?'deepseek':(n.startsWith('gateway')||n.startsWith('logcomex'))?'gateway':'claude'; }
function aiCanTalk(e){ return aiEngineOf(e)!=='mock'; } // qualquer motor real conversa/retoma (não só o Claude)
// "Claude · Opus 5.5", "Codex · GPT-5", "Logcomex AI · logcomex-v2" — o que roda (ou rodou) nesta tarefa
function aiRunLabel(engine, model){
  const k=aiEngineOf(engine);
  if(k==='mock') return 'Mock (sem IA)';
  const eng=k==='gateway'?((_aiGw&&_aiGw.label)||'Gateway'):(AI_ENGINES.find(x=>x.id===k)||{}).name||k;
  if(!model) return eng+(k==='claude'?' · padrão da assinatura':'');
  const n=(typeof modelFriendly==='function')?modelFriendly(model):aiModelName(model);
  return eng+' · '+n;
}
// IA que responde os chats de várias rodadas (chat do projeto, issues, orquestrador): a IA PADRÃO do usuário
// (spec-chats-sem-claude); "mock" não é IA → esses chats seguem no Claude (mesma regra do ai_once no Rust)
function aiChatRunLabel(){ const d=aiDefaults(); return aiEngineOf(d.eng)==='mock'?aiRunLabel('claude',''):aiRunLabel(d.eng, d.model); }
// pílula do composer desses chats: a escolha deles JÁ mora no painel Sua IA (vale pra todos) — a pílula mostra qual
// é e leva até lá; não cria uma segunda configuração
function aiChatModelPill(id){
  return { id, popup:'', label:aiChatRunLabel(), title:'IA dos chats = a sua IA padrão — clique pra trocar em Configurações → Sua IA (vale a partir da próxima mensagem)',
    onPick:()=>{ if(typeof suaIaOpenCfg==='function') suaIaOpenCfg(); else if(typeof openCfg==='function') openCfg(); } };
}
// modelo pros chats que rodam no CLAUDE (planner, chat do projeto, issues, orquestrador): o padrão do usuário
// só vale se o motor padrão for o Claude — um id do Codex/gateway no --model do claude derrubava a chamada.
function aiClaudeModel(eng, model){ const d=aiDefaults(); if(eng===undefined){ eng=d.eng; model=d.model; } return aiEngineOf(eng)==='claude' && model ? model : null; }
// alvo do seletor: o FORMULÁRIO/planner (selects escondidos). A IA padrão é escolhida no painel Sua IA (30-sua-ia.js).
const AI_TARGET_FORM={ sel:'.aipick', get:()=>({ eng:($id('ntEngine')||{}).value||'claude', model:($id('ntModel')||{}).value||'' }), set:(e,m)=>{ setSelValue($id('ntEngine'), e); setSelValue($id('ntModel'), m); const hm=$id('howModel'); if(hm) setSelValue(hm, m); } };
function aiPickApply(eng, model, target){
  target=target||AI_TARGET_FORM; target.set(eng, model);
  aiPickRender(target);
}
let _aiCustomOpen=false;
// estado de cada motor no cartão do seletor (painel Sua IA, 30-sua-ia.js) — pronto · falta instalar · falta login · falta chave
function aiPickStateHtml(id){
  if(id==='mock' || typeof suaIaOf!=='function') return '';
  // sem estado, estado vazio (falhou) ou velho (>20s, ou zerado por uma chave nova) → relê em segundo plano;
  // quando chegar, o painel redesenha os seletores (suaIaRefresh)
  if(typeof suaIaStale==='function' && suaIaStale()) suaIaLoad().catch(()=>{});
  const s=suaIaOf(id); if(!s) return '';
  return `<span class="aist ${s.ready?'ok':'bad'}">${esc(suaIaStateText(s))}</span>`;
}
// "configurar" (formulário/planner) leva ao painel Sua IA nas Configurações; "configurar agora" quando o motor não está pronto
function aiPickCfgLink(id, gw){
  if(id==='mock') return '';
  const s=typeof suaIaOf==='function'?suaIaOf(id):null;
  const pend=s?!s.ready:(id==='gateway'&&!(gw&&gw.configured));
  return ` <a data-aicfg>${pend?'configurar agora':'configurar'}</a>`;
}
function aiPickRender(target){
  target=target||AI_TARGET_FORM;
  const hosts=[...document.querySelectorAll(target.sel)]; if(!hosts.length) return;
  // F4 · D12: no Formulário (e onde mais usar o alvo do formulário) o seletor completo virou a PÍLULA ÚNICA (iaPick):
  // a fonte da verdade continua nos selects escondidos #ntEngine/#ntModel; a recomendação pela demanda segue valendo
  if(target===AI_TARGET_FORM && typeof iaPick==='function'){
    const cur=target.get();
    hosts.forEach(h=>{ if(!h.__ia || !h.contains(h.__ia.pill)){ h.innerHTML=''; h.__ia=iaPick(h, { value:{ engine:cur.eng, model:cur.model }, scope:'demanda', recommend:()=>aiRecommend(aiSpecSnapshot()),
        onChange:(v)=>{ target.set(v.engine, v.model); hosts.forEach(o=>{ if(o!==h && o.__ia) o.__ia.set(v); }); } }); h.__ia.pill=h.querySelector('.iapill'); }
      else h.__ia.set({ engine:cur.eng, model:cur.model }); });
    return;
  }
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
  const html=`<div class="aieng">${AI_ENGINES.map(x=>`<button type="button" class="aicard${x.id===eng?' on':''}${x.dynamic&&!gw.configured?' off':''}" data-aieng="${x.id}"><span class="aiic" style="color:${x.color}">${x.icon}</span><span class="ain">${esc(x.name)}</span><span class="aiv">${esc(x.vendor)}</span>${aiPickStateHtml(x.id)}</button>`).join('')}</div>`+
    `<div class="aidesc">${esc(e.desc)}${aiPickCfgLink(e.id, gw)}</div>`+
    (models.length||e.custom?`<div class="aimodels">${models.map(m=>{ const r=rec.engine===e.id&&rec.model===m.id; return `<button type="button" class="aimodel${m.id===model?' on':''}${r?' rec':''}" data-aimodel="${escA(m.id)}"><b>${esc(m.name)}</b>${m.tag?`<span>${esc(m.tag)}</span>`:''}${r?'<i>recomendado</i>':''}</button>`; }).join('')}`+
      (e.custom?`<button type="button" class="aimodel${(!known&&model)?' on':''}" data-aicustom><b>${(!known&&model)?esc(model):'outro id…'}</b><span>${(!known&&model)?'id digitado':'digite o id exato'}</span></button>`:'')+`</div>`:'')+
    (_aiCustomOpen?`<div class="aicustom"><input class="in mono" id="aiCustomId" placeholder="${e.id==='claude'?'ex.: claude-opus-5-5':e.id==='codex'?'ex.: gpt-5-codex':e.id==='deepseek'?'ex.: deepseek-v4-pro':'id do modelo no gateway'}" value="${escA((!known&&model)?model:'')}"><button type="button" class="btn sm" data-aicustomok>usar</button></div>`:'')+
    `<div class="airec">${isRecSel?'✓ ':IC.starforkEm+' '}${esc(rec.reason)}${isRecSel?'':` — <a data-airec>usar ${esc(rec.label)}</a>`}</div>`;
  hosts.forEach(h=>{
    h.innerHTML=html;
    h.querySelectorAll('[data-aieng]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(b.dataset.aieng, '', target); });
    h.querySelectorAll('[data-aimodel]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=false; aiPickApply(eng, b.dataset.aimodel, target); });
    h.querySelectorAll('[data-airec]').forEach(a=>a.onclick=()=>{ _aiCustomOpen=false; aiPickApply(rec.engine, rec.model, target); });
    h.querySelectorAll('[data-aicustom]').forEach(b=>b.onclick=()=>{ _aiCustomOpen=true; aiPickRender(target); const i=h.querySelector('#aiCustomId'); if(i) i.focus(); });
    h.querySelectorAll('[data-aicustomok]').forEach(b=>b.onclick=()=>{ const i=h.querySelector('#aiCustomId'); const v=(i&&i.value.trim())||''; _aiCustomOpen=false; aiPickApply(eng, v, target); });
    { const i=h.querySelector('#aiCustomId'); if(i) i.onkeydown=ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); _aiCustomOpen=false; aiPickApply(eng, i.value.trim(), target); } }; }
    h.querySelectorAll('[data-aicfg]').forEach(a=>a.onclick=()=>{ if(typeof suaIaOpenCfg==='function') suaIaOpenCfg(); else if(typeof openCfg==='function') openCfg(); });
  });
}
// ---- trocar o modelo de uma demanda JÁ criada (pílula do composer da tarefa e menu do card no quadro) ----
// Só troca o MODELO dentro do motor da tarefa (set_task_model) — o motor é fixo (stickEngines no orchestrator).
// Abre pra cima quando não cabe embaixo (a pílula mora no rodapé do chat); teclado: ↓/↑/Home/End, Esc fecha e
// devolve o foco pra pílula (a11yMenu, 54-acessibilidade.js). Clicar de novo em quem abriu fecha.
function openModelMenu(taskId, anchor){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t) return;
  const old=$id('tmenuPop');
  if(old){ const same=old.__anchor===anchor; if(old.__close) old.__close(false); else old.remove(); if(same) return; }
  const pop=document.createElement('div'); pop.id='tmenuPop'; pop.__anchor=anchor;
  pop.style.cssText='position:fixed;z-index:9000;min-width:240px;max-width:min(360px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow-y:auto;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:var(--shadow-pop);padding:5px';
  const cur=t.model||'';
  // lista do MOTOR desta tarefa (antes: sempre a do Claude — numa tarefa Codex dava pra pôr "opus" no codex)
  const ek=aiEngineOf(t.engine), eng=AI_ENGINES.find(x=>x.id===ek)||AI_ENGINES[0];
  const list=(ek==='gateway'&&_aiGw&&_aiGw.configured)?[{id:'',name:_aiGw.model||'padrão do gateway',tag:'padrão'},..._aiGw.models.filter(m=>m!==_aiGw.model).map(m=>({id:m,name:m,tag:''}))]:(eng.models||[]);
  const head=document.createElement('div'); head.className='mono'; head.style.cssText='font-size:var(--fs-xs);letter-spacing:.08em;color:var(--muted);padding:6px 10px 4px;text-transform:uppercase'; head.textContent='modelo desta demanda · '+(ek==='gateway'?((_aiGw&&_aiGw.label)||'Gateway'):eng.name); pop.appendChild(head);
  // quem abriu pode ter sido recriado (re-render do chat) — o foco volta pro elemento VIVO com o mesmo id
  const back=()=>{ const a=(anchor&&anchor.id&&$id(anchor.id))||anchor; if(a&&a.isConnected&&a.focus) a.focus({preventScroll:true}); };
  const onOut=(e)=>{ if(!pop.contains(e.target) && !(anchor&&anchor.contains&&anchor.contains(e.target))) close(false); };
  function close(focusBack){ pop.remove(); document.removeEventListener('mousedown', onOut, true);
    if(anchor&&anchor.setAttribute) anchor.setAttribute('aria-expanded','false');
    if(focusBack) back(); }
  pop.__close=close;
  const apply=async(id)=>{ close(false); try{ await invoke('set_task_model',{ taskId, model:id }); lastSig=''; await refresh(); if(typeof renderWorkspace==='function' && typeof fwTask!=='undefined' && fwTask===taskId) renderWorkspace(); }catch(e){ showErr(e, 'Falhou'); } back(); };
  const item=(label, id, on, fn)=>{ const b=document.createElement('button'); b.type='button'; b.setAttribute('role','menuitemradio'); b.setAttribute('aria-checked', on?'true':'false');
    b.innerHTML=`${on?'<span style="color:var(--accent)" aria-hidden="true">✓</span> ':'<span style="opacity:0" aria-hidden="true">✓</span> '}${esc(label)}`; b.style.cssText='display:block;width:100%;text-align:left;border:0;background:none;color:var(--text);font:inherit;font-size:var(--fs-sm);padding:7px 10px;border-radius:7px;cursor:pointer'; b.onmouseenter=()=>b.style.background='var(--surface-2)'; b.onmouseleave=()=>b.style.background='none'; b.onclick=fn||(()=>apply(id)); pop.appendChild(b); return b; };
  list.forEach(m=>item(m.name+(m.tag?'  · '+m.tag:''), m.id, m.id===cur));
  if(cur && !list.some(m=>m.id===cur)) item(cur+'  · id atual', cur, true);
  item('outro id…', '__custom', false, async()=>{ close(false); const v=await askText('Id do modelo','ex.: claude-opus-5-5', cur); if(v!=null && v.trim()) apply(v.trim()); else back(); }).setAttribute('role','menuitem');
  const note=document.createElement('div'); note.className='dim'; note.style.cssText='font-size:var(--fs-xs);padding:6px 10px 4px;line-height:1.4'; note.textContent='vale a partir do próximo turno do agente'; pop.appendChild(note);
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect(), h=pop.offsetHeight, room=window.innerHeight-r.bottom-6-8;
  // embaixo se cabe; senão pra cima (pílula no rodapé); sem espaço nenhum → encostado na borda de baixo
  const top=(h<=room)?r.bottom+6:(r.top-6-h>=8?r.top-6-h:Math.max(8, window.innerHeight-h-8));
  pop.style.top=top+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.left))+'px';
  setTimeout(()=>document.addEventListener('mousedown', onOut, true), 0);
  if(typeof a11yMenu==='function') a11yMenu(pop, anchor, close);
  else pop.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(true); } });
}
// aplica o padrão do usuário nos selects do formulário na carga (o chat/planner lê dali)
aiApplyDefaults();
// boot: settings.json passa a refletir o padrão atual (localStorage) — Rust/motor leem dali
aiSyncSettings();
// a recomendação acompanha o que você digita (design/investigação são página única)
let _aiPickT=null;
['ntDzTitle','ntDzObj','ntInvTitle','ntInvObj'].forEach(id=>{ const e=$id(id); if(e) e.addEventListener('input',()=>{ clearTimeout(_aiPickT); _aiPickT=setTimeout(aiPickRender,400); }); });

// ======================= SELETOR DE IA ÚNICO (F4 · D12) =======================
// UMA pílula ("Claude · Sonnet 5 ▾") + UMA folha ancorada (motor + modelo + estado/login + dica de custo + recomendação
// + "usar como padrão"). Substitui o cartão "Com qual IA?" do planner, o seletor completo do Formulário, o select +
// texto livre do Piloto e o Sonnet fixo da Mesa. API documentada em _bmad-output/redesign/helpers-comuns.md.
//   const ctl=iaPick(el, { value:{engine,model}, onChange(v,{asDefault}), scope:'demanda'|'sessao'|'piloto'|'padrao'|texto,
//                          recommend?:()=>({engine,model,reason}), allowDefault?:true, engines?:['claude',…], title? });
//   ctl.get() · ctl.set(v) · ctl.open() · ctl.close() · ctl.el
// @ia-pick-puro-inicio — sem DOM (testado em app/tests/ia-pick.test.mjs)
const IA_PICK_SCOPE={ demanda:'vale só pra esta demanda', sessao:'vale só pra esta sessão', piloto:'vale pra todas as tarefas do piloto', padrao:'vira o seu padrão', mesa:'vale pra todas as personas desta mesa' };
function iaPickNorm(v){
  v=v||{}; const eng=aiEngineOf(v.engine||v.eng||'claude');
  return { engine:eng==='mock'&&!(v.engine||v.eng)?'claude':eng, model:String(v.model||'') };
}
// rótulo da pílula: "Claude · Sonnet 5", "Codex · GPT-5", "Logcomex AI · padrão"
function iaPickLabel(v){ const n=iaPickNorm(v); return aiRunLabel(n.engine, n.model).replace(' · padrão da assinatura',' · padrão'); }
// dica de custo curta (relativa — não é preço): Opus/Fable mais caro, Haiku mais barato…
function iaPickCostHint(v){
  const n=iaPickNorm(v), m=n.model.toLowerCase();
  if(n.engine==='mock') return 'sem custo (simulado)';
  if(n.engine==='codex') return 'cobra na sua conta do ChatGPT';
  if(n.engine==='deepseek') return 'barato por token (beta)';
  if(n.engine==='gateway') return 'custo da IA da sua empresa';
  if(/opus|fable/.test(m)) return 'o mais caro (~3× o Sonnet)';
  if(/haiku/.test(m)) return 'o mais barato (~⅓ do Sonnet)';
  if(/sonnet/.test(m)) return 'equilíbrio de custo e qualidade';
  return 'o modelo padrão do seu plano';
}
// opções da folha: cada motor com estado (pronto · falta login · falta chave…) — `stateOf(id)` devolve o estado do
// painel Sua IA ({ready,state}) ou null (ainda verificando: não bloqueia). Motor não pronto fica desligado com o motivo.
function iaPickOptions(stateOf, engines, gw){
  const ids=engines&&engines.length?engines:['claude','codex','gateway','deepseek'];
  return ids.map(id=>{
    const e=AI_ENGINES.find(x=>x.id===id)||{ id, name:id, models:[] };
    const s=typeof stateOf==='function'?stateOf(id):null;
    const gwOff=id==='gateway' && gw && !gw.configured;
    const ready=s?!!s.ready:!gwOff;
    const st=s?(typeof suaIaStateText==='function'?suaIaStateText(s):(s.ready?'pronto':'indisponível')):(gwOff?'falta configurar':'');
    const name=id==='gateway'?((gw&&gw.configured&&gw.label)?gw.label+' (gateway)':'IA da sua empresa (gateway)'):id==='deepseek'?'DeepSeek':e.name;
    const models=id==='gateway'?((gw&&gw.configured)?[{id:'',name:gw.model||'padrão do gateway'}].concat((gw.models||[]).filter(m=>m!==gw.model).map(m=>({id:m,name:m}))):[])
      :(e.models||[]).filter(m=>!/^(opus|sonnet|haiku)$/.test(m.id)); // os aliases ficam no "outro id…" (id fixo é mais claro)
    return { id, name, beta:!!e.beta, ready, state:st, hint:ready?(e.vendor||''):'configurar em Ajustes › IA e modelos', models };
  });
}
// escolha → o que mudou (onChange só quando muda de verdade)
// a recomendação vem em alias (opus/sonnet/haiku); a folha mostra ids fixos — o mesmo modelo, versão travada
const IA_PICK_ALIAS={ opus:'claude-opus-5-5', sonnet:'claude-sonnet-5', haiku:'claude-haiku-4-5-20251001' };
function iaPickSame(a, b){ const x=iaPickNorm(a), y=iaPickNorm(b); return x.engine===y.engine && x.model===y.model; }
// @ia-pick-puro-fim
let _iaPickOpen=null; // { sheet, close }
function iaPick(el, opts){
  opts=opts||{};
  const ctl={ el, v:iaPickNorm(opts.value||aiDefaults()), get:()=>Object.assign({}, ctl.v), set:(v)=>{ ctl.v=iaPickNorm(v); paint(); }, open:()=>openSheet(), close:()=>{ if(_iaPickOpen && _iaPickOpen.ctl===ctl) _iaPickOpen.close(false); } };
  if(!el) return ctl;
  function paint(){
    el.innerHTML=`<button type="button" class="iapill" aria-haspopup="dialog" aria-expanded="false" title="${escA(opts.title||'trocar a IA e o modelo')}"><span class="iadot" aria-hidden="true"></span><span class="ialbl">${esc(iaPickLabel(ctl.v))}</span><svg class="iachev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    const b=el.querySelector('.iapill'); ctl.pill=b; b.onclick=()=>{ if(_iaPickOpen && _iaPickOpen.ctl===ctl){ _iaPickOpen.close(true); return; } openSheet(); };
  }
  function openSheet(){
    if(_iaPickOpen) _iaPickOpen.close(false);
    if(typeof suaIaStale==='function' && suaIaStale() && typeof suaIaLoad==='function') suaIaLoad().then(()=>{ if(_iaPickOpen && _iaPickOpen.ctl===ctl) draw(); }).catch(()=>{});
    if(!_aiGw) aiGatewayInfo().then(()=>{ if(_iaPickOpen && _iaPickOpen.ctl===ctl) draw(); }).catch(()=>{});
    const pill=el.querySelector('.iapill');
    const sh=document.createElement('div'); sh.className='iasheet'; sh.setAttribute('role','dialog'); sh.setAttribute('aria-label','Com qual IA?'); sh.tabIndex=-1;
    let pick=Object.assign({}, ctl.v), custom=false, asDef=false;
    function draw(){
      const list=iaPickOptions(typeof suaIaOf==='function'?suaIaOf:null, opts.engines, _aiGw);
      const cur=list.find(x=>x.id===pick.engine)||list[0];
      const rec0=typeof opts.recommend==='function'?opts.recommend():null, rec=rec0?Object.assign({}, rec0, { model:IA_PICK_ALIAS[rec0.model]||rec0.model }):null;
      const known=cur.models.some(m=>m.id===pick.model);
      sh.innerHTML=`<div class="ias-h"><b>Com qual IA?</b><span>${esc(IA_PICK_SCOPE[opts.scope]||opts.scope||IA_PICK_SCOPE.demanda)}</span><em>esc fecha</em></div>`+
        list.map(x=>`<button type="button" class="ias-opt${x.id===pick.engine?' on':''}" data-iaeng="${escA(x.id)}"${x.ready?'':' disabled aria-disabled="true"'}><span class="ias-rd" aria-hidden="true"></span><b>${esc(x.name)}${x.beta?' <small>beta</small>':''}</b>${x.state?`<em class="${x.ready?'ok':'w'}">${esc(x.state)}</em>`:''}<span class="ias-d">${esc(x.hint)}</span></button>`).join('')+
        `<div class="ias-models">${cur.models.map(m=>`<button type="button" class="ias-mc${m.id===pick.model&&!custom?' on':''}" data-iamodel="${escA(m.id)}">${esc(m.name)}${rec&&rec.engine===cur.id&&rec.model===m.id?'<small>recomendado</small>':''}</button>`).join('')}`+
          `<button type="button" class="ias-mc${(custom||(!known&&pick.model))?' on':''}" data-iacustom>${(!known&&pick.model)?esc(pick.model):'outro id…'}</button></div>`+
        (custom?`<div class="ias-custom"><input class="in mono" data-iacustomin placeholder="${cur.id==='claude'?'ex.: claude-opus-5-5':'id exato do modelo'}" value="${escA(known?'':pick.model)}" aria-label="id do modelo"></div>`:'')+
        `<div class="ias-cost">${esc(iaPickCostHint(pick))}</div>`+
        (rec&&rec.reason?`<div class="ias-rec">${(typeof IC!=='undefined'&&IC.starforkEm)||''} ${esc(rec.reason)}${iaPickSame(rec,pick)?'':` — <button type="button" class="lnk" data-iarec>usar ${esc(iaPickLabel(rec))}</button>`}</div>`:'')+
        `<div class="ias-f">${opts.allowDefault===false?'<span></span>':`<label class="ias-chk"><input type="checkbox" data-iadef${asDef?' checked':''}> usar como padrão nas próximas</label>`}<button type="button" class="btn primary sm" data-iaok>Usar esta</button></div>`;
      sh.querySelectorAll('[data-iaeng]').forEach(b=>b.onclick=()=>{ if(b.disabled) return; pick={ engine:b.dataset.iaeng, model:'' }; custom=false; draw(); });
      sh.querySelectorAll('[data-iamodel]').forEach(b=>b.onclick=()=>{ pick.model=b.dataset.iamodel; custom=false; draw(); });
      sh.querySelectorAll('[data-iacustom]').forEach(b=>b.onclick=()=>{ custom=true; draw(); const i=sh.querySelector('[data-iacustomin]'); if(i) i.focus(); });
      sh.querySelectorAll('[data-iacustomin]').forEach(i=>{ i.oninput=()=>{ pick.model=i.value.trim(); }; i.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); commit(); } }; });
      sh.querySelectorAll('[data-iarec]').forEach(b=>b.onclick=()=>{ pick=iaPickNorm(rec); custom=false; draw(); });
      sh.querySelectorAll('[data-iadef]').forEach(c=>c.onchange=()=>{ asDef=c.checked; });
      sh.querySelectorAll('[data-iaok]').forEach(b=>b.onclick=commit);
      place();
    }
    function commit(){
      const nv=iaPickNorm(pick), changed=!iaPickSame(nv, ctl.v);
      ctl.v=nv; if(asDef) aiSaveDefaults(nv.engine, nv.model);
      close(true); paint();
      if((changed||asDef) && typeof opts.onChange==='function') opts.onChange(ctl.get(), { asDefault:asDef });
    }
    function place(){
      const r=pill.getBoundingClientRect(), w=sh.offsetWidth, h=sh.offsetHeight;
      const x=Math.min(Math.max(8, r.left), innerWidth-w-8);
      let y=r.bottom+8; if(y+h>innerHeight-8) y=Math.max(8, r.top-h-8);
      sh.style.left=x+'px'; sh.style.top=y+'px'; sh.style.setProperty('--ax', Math.max(12, Math.min(w-24, r.left+r.width/2-x-6))+'px');
      sh.classList.toggle('up', y<r.top);
    }
    const onOut=e=>{ if(!sh.contains(e.target) && !el.contains(e.target)) close(false); };
    const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(true); } };
    function close(refocus){ sh.remove(); document.removeEventListener('mousedown', onOut, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place);
      if(_iaPickOpen && _iaPickOpen.sheet===sh) _iaPickOpen=null; const p=el.querySelector('.iapill'); if(p){ p.setAttribute('aria-expanded','false'); if(refocus) try{ p.focus({ preventScroll:true }); }catch(_){ } } }
    document.body.appendChild(sh); pill.setAttribute('aria-expanded','true');
    _iaPickOpen={ ctl, sheet:sh, close };
    draw();
    setTimeout(()=>{ document.addEventListener('mousedown', onOut, true); document.addEventListener('keydown', onKey, true); }, 0);
    window.addEventListener('resize', place);
    try{ const f=sh.querySelector('.ias-opt.on')||sh; f.focus({ preventScroll:true }); }catch(_){ }
  }
  paint();
  return ctl;
}
window.iaPick=iaPick;

// ---- folha ancorada genérica (menu ⋯ e confirmação) — o MESMO visual do seletor de IA; Esc/clique fora fecham ----
// g2Sheet(anchor, html, wire) → { el, close }. g2SheetMenu(anchor, [{label, hint?, fn, danger?, disabled?}]).
// g2SheetConfirm(anchor, { title, sub?, body?, ok, cancel?, onOk, danger? }) → confirmação ancorada no botão (D23).
let _g2Sheet=null;
function g2Sheet(anchor, html, wire, cls){
  if(_g2Sheet){ const same=_g2Sheet.anchor===anchor; _g2Sheet.close(false); if(same) return null; }
  const sh=document.createElement('div'); sh.className='iasheet g2sheet'+(cls?' '+cls:''); sh.setAttribute('role','dialog'); sh.tabIndex=-1; sh.innerHTML=html;
  document.body.appendChild(sh);
  const place=()=>{ const r=anchor.getBoundingClientRect(), w=sh.offsetWidth, h=sh.offsetHeight;
    const x=Math.min(Math.max(8, r.right-w), innerWidth-w-8); let y=r.bottom+8; if(y+h>innerHeight-8) y=Math.max(8, r.top-h-8);
    sh.style.left=x+'px'; sh.style.top=y+'px'; sh.style.setProperty('--ax', Math.max(12, Math.min(w-24, r.left+r.width/2-x-6))+'px'); sh.classList.toggle('up', y<r.top); };
  const onOut=e=>{ if(!sh.contains(e.target) && !anchor.contains(e.target)) close(false); };
  const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(true); } };
  function close(refocus){ sh.remove(); document.removeEventListener('mousedown', onOut, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place); if(_g2Sheet&&_g2Sheet.el===sh) _g2Sheet=null; try{ anchor.setAttribute('aria-expanded','false'); if(refocus&&anchor.isConnected) anchor.focus({ preventScroll:true }); }catch(_){ } }
  _g2Sheet={ el:sh, anchor, close };
  try{ anchor.setAttribute('aria-expanded','true'); }catch(_){ }
  if(wire) wire(sh, close);
  place(); window.addEventListener('resize', place);
  setTimeout(()=>{ document.addEventListener('mousedown', onOut, true); document.addEventListener('keydown', onKey, true); }, 0);
  try{ const f=sh.querySelector('button:not([disabled]),input'); (f||sh).focus({ preventScroll:true }); }catch(_){ }
  return _g2Sheet;
}
function g2SheetMenu(anchor, items){
  items=(items||[]).filter(Boolean);
  return g2Sheet(anchor, `<div class="g2menu" role="menu">${items.map((it,i)=>`<button type="button" role="menuitem" class="g2mi${it.danger?' danger':''}" data-g2mi="${i}"${it.disabled?' disabled':''}><b>${esc(it.label)}</b>${it.hint?`<span>${esc(it.hint)}</span>`:''}</button>`).join('')}</div>`,
    (sh, close)=>sh.querySelectorAll('[data-g2mi]').forEach(b=>b.onclick=()=>{ const it=items[+b.dataset.g2mi]; close(false); if(it&&it.fn) it.fn(anchor); }), 'g2menuw');
}
function g2SheetConfirm(anchor, o){
  o=o||{};
  return g2Sheet(anchor, `<div class="ias-h"><b>${esc(o.title||'Confirmar?')}</b>${o.sub?`<span>${esc(o.sub)}</span>`:''}<em>esc fecha</em></div>${o.body?`<div class="g2sb">${o.body}</div>`:''}<div class="ias-f"><button type="button" class="btn quiet sm" data-g2no>${esc(o.cancel||'Cancelar')}</button><button type="button" class="btn ${o.danger?'danger':'primary'} sm" data-g2ok>${esc(o.ok||'Confirmar')}</button></div>`,
    (sh, close)=>{ sh.querySelector('[data-g2no]').onclick=()=>close(true); sh.querySelector('[data-g2ok]').onclick=()=>{ close(false); if(o.onOk) o.onOk(sh); }; if(o.wire) o.wire(sh); });
}
window.g2Sheet=g2Sheet; window.g2SheetMenu=g2SheetMenu; window.g2SheetConfirm=g2SheetConfirm;
// ícones que as telas do G2 usam (só preenche o que a casca ainda não definiu)
if(typeof IC!=='undefined'){ const S=(p,w)=>`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w||1.5}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const G2_IC={ dots:S('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
    pc:S('<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/>',1.4), plus:S('<path d="M8 3.5v9M3.5 8h9"/>'), list:S('<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"/>'),
    users:S('<circle cx="6" cy="6" r="2.3"/><path d="M2 13c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4M10.5 4a2.2 2.2 0 0 1 0 4.2M12 9.8c1.2.5 1.9 1.6 2 3.2"/>',1.4),
    arrow:S('<path d="M3 8h10M9 4l4 4-4 4"/>'), lock:S('<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',1.4), chev:S('<path d="M4.5 6.5l3.5 3.5 3.5-3.5"/>',1.6) };
  for(const k in G2_IC) if(!IC[k]) IC[k]=G2_IC[k]; }
