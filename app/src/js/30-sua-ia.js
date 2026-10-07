// Starfork — 30-sua-ia: painel "Sua IA" — escolher e configurar o motor (Claude Code, Codex, DeepSeek beta, gateway).
// UM componente (suaIaMount) usado em dois lugares: o passo "Qual IA você vai usar?" do primeiro acesso (tour,
// 15-config-abas-onboarding) e as Configurações (no lugar do antigo "IA padrão"). Os dois podem estar montados
// ao mesmo tempo: toda busca de elemento é ESCOPADA no container (nada de id global).
// - estado de cada motor: comando Rust ÚNICO ai_engines_status (mesma disponibilidade do ai_once/Ambiente);
// - chave digitada no cartão: caminho das chaves da conta (secretSet → cofre na nuvem + llm.env), com o NOME certo
//   por motor (vem do Rust: OPENAI_API_KEY, DEEPSEEK_API_KEY) — a pessoa nunca digita nome de variável e o valor
//   salvo nunca aparece (só "chave salva ✓" + trocar/remover);
// - gateway: a config "Gateway próprio" que já existe (41-assinatura-chaves: routeAiCfgHtml/wireRouteAiCfg);
// - "testar": ai_test (chamada mínima forçando o motor, prazo curto); "usar como padrão": aiSaveDefaults.
// - IA padrão: a fonte é o localStorage (aiDefaults — espelhado no settings.json que o Rust lê).
// Nunca instala nada pela pessoa (só copia o comando) e nunca mexe no motor de tarefas já criadas.
let suaIaList=null, suaIaAt=0, _suaIaP=null, _suaIaFailAt=0, _suaIaSeq=0;
const suaIaUi={ model:{}, msg:{}, busy:{}, editKey:{}, gwOpen:false, obPick:null };
const _suaIaHosts=new Set();
const SUA_IA_STATE={ ready:'pronto', install:'falta instalar', login:'falta login', key:'falta chave', node:'falta atualizar o Node' };
const SUA_IA_ORDER=['claude','codex','deepseek','gateway'];
// @sua-ia-puro-inicio
function suaIaStateText(s){
  if(!s) return 'verificando…';
  if(s.id==='gateway' && s.state==='key') return 'falta configurar';
  return SUA_IA_STATE[s.state]||String(s.state||'');
}
// nada pronto → o caminho mais curto: um login (1 comando) > uma chave num motor já instalado > instalar o Claude Code
function suaIaShortest(list){
  const L=Array.isArray(list)?list:[];
  if(!L.length || L.some(s=>s.ready)) return null;
  return L.find(s=>s.state==='login') || L.find(s=>s.state==='key' && s.installed && s.keyName) || L.find(s=>s.id==='claude') || L[0];
}
// 1º acesso: o padrão atual NÃO está pronto e há motor pronto → candidatos (na ordem do painel); com UM só, ele
// já vem escolhido (o "continuar" do tour aplica). null = nada a sugerir (padrão pronto, ou nenhum pronto).
function suaIaObSuggest(list, defEng){
  const L=Array.isArray(list)?list:[];
  const def=L.find(s=>s.id===defEng);
  if(def && def.ready) return null;
  const cand=SUA_IA_ORDER.filter(id=>L.some(s=>s.id===id && s.ready));
  if(!cand.length) return null;
  return { candidates:cand, pick:cand.length===1?cand[0]:null };
}
// etiqueta do modelo sem jargão ("alias", "id fixo"): sobra só o que ajuda a escolher (mais capaz, mais veloz…)
function suaIaTagPt(tag){ const t=String(tag||''); if(!t || t==='auto') return ''; return t.split('·').map(x=>x.trim()).filter(x=>x && !/^(alias|id fixo)$/i.test(x)).join(' · '); }
// @sua-ia-puro-fim
function suaIaOf(id){ const k=typeof aiEngineOf==='function'?aiEngineOf(id):id; return (suaIaList||[]).find(s=>s.id===k)||null; }
function suaIaEngine(id){ return (typeof AI_ENGINES!=='undefined'?AI_ENGINES:[]).find(e=>e.id===id)||{ id, name:id, color:'var(--muted)', icon:'', models:[] }; }
function suaIaDefEng(){ return aiEngineOf(aiDefaults().eng); }
// modelos do cartão: catálogo do seletor (29-ia-picker); gateway = os da config da conta (vêm no status; o 1º é o padrão = '')
function suaIaModels(s){
  if(s.id==='gateway'){ const ms=s.models||[]; return ms.length?[{ id:'', name:ms[0]+' (padrão do gateway)' }, ...ms.slice(1).map(m=>({ id:m, name:m }))]:[{ id:'', name:'padrão do gateway' }]; }
  return (suaIaEngine(s.id).models||[]).map(m=>({ id:m.id, name:m.name+(suaIaTagPt(m.tag)?' · '+suaIaTagPt(m.tag):'') }));
}
// mesmo modelo, mesma opção: o padrão do gateway salvo pelo nome (ms[0]) é a opção '' (sem "(outro modelo)" duplicado)
function suaIaNormModel(id, m){
  m=String(m||'');
  if(id==='gateway'){ const s=suaIaOf('gateway'); if(s && (s.models||[])[0]===m) return ''; }
  return m;
}
// nome no painel: o rótulo do Rust (gateway = nome da config da conta); o "beta" do DeepSeek vira etiqueta
function suaIaName(s){ return String((s&&s.label)||suaIaEngine(s&&s.id).name||'').replace(/\s*\(beta\)\s*$/i,''); }
function suaIaModel(id){
  if(Object.prototype.hasOwnProperty.call(suaIaUi.model, id)) return suaIaUi.model[id];
  const d=aiDefaults(); return aiEngineOf(d.eng)===id ? suaIaNormModel(id, d.model) : '';
}
// forçado durante uma leitura em andamento: espera ela e lê DE NOVO (a em andamento pode ser de antes da mudança)
function suaIaLoad(force){
  if(_suaIaP){ if(!force) return _suaIaP; return _suaIaP.then(()=>suaIaLoad(true)); }
  if(!force && suaIaList && suaIaList.length && Date.now()-suaIaAt<20000) return Promise.resolve(suaIaList);
  if(typeof aiCodexRefresh==='function') aiCodexRefresh().then(()=>suaIaRefresh()).catch(()=>{}); // versões reais do Codex instalado
  _suaIaP=Promise.resolve().then(()=>invoke('ai_engines_status'))
    .then(r=>{
      suaIaList=Array.isArray(r)?r:[]; suaIaAt=Date.now(); suaIaUi.loadErr='';
      const cl=suaIaList.find(s=>s.id==='claude');
      if(cl && cl.statuslineInstalled) suaIaSlStatusLoad(); else suaIaUi.slStatus=null;
      return suaIaList;
    })
    .catch(e=>{ if(!suaIaList) suaIaList=[]; _suaIaFailAt=Date.now(); suaIaUi.loadErr=String((e&&e.message)||e||''); return suaIaList; })
    .finally(()=>{ _suaIaP=null; suaIaRefresh(); });
  return _suaIaP;
}
// os seletores pedem leitura quando: nunca leu, a leitura veio vazia (falha) ou ficou velha (>20s / zerada por chave nova)
// — sem martelar: depois de uma falha espera 20s, e nada enquanto há leitura em andamento
function suaIaStale(){
  if(_suaIaP) return false;
  if(_suaIaFailAt && Date.now()-_suaIaFailAt<20000) return false;
  return suaIaList===null || !suaIaList.length || Date.now()-suaIaAt>20000;
}
// correções: uma linha por opção (MESMA regra da aba Ambiente — envFixLines); comando ganha "copiar"
function suaIaFixesHtml(fixes){
  const lines=(fixes||[]).flatMap(f=>typeof envFixLines==='function'?envFixLines(f):[{ text:String(f), cmd:!/^(configure|reinstale)/i.test(String(f)) }]);
  return lines.map((f,i)=>`<div class="suaia-fix">${i?'<span class="dim">ou</span>':''}${f.cmd
    ?`<span class="dim">rode no Terminal:</span><code class="mono" title="${escA(f.text)}">${esc(f.text)}</code><button type="button" class="btn sm" data-envfix="${escA(f.text)}" data-sa="copy">copiar</button>`
    :`<span>${esc(f.text)}</span>`}</div>`).join('');
}
function suaIaKeyHtml(s, hk){
  if(!s.keyName) return '';
  const what=s.id==='codex'?'chave da OpenAI':s.id==='deepseek'?'chave da DeepSeek':'chave';
  const busy=suaIaUi.busy[s.id]==='key'?' disabled':'';
  if(s.keySaved && !suaIaUi.editKey[s.id]) return `<div class="suaia-key"><span class="suaia-ok">${esc(what)} salva ✓</span><span style="flex:1"></span><button type="button" class="btn sm" data-sa="keyedit" data-id="${s.id}"${busy}>trocar</button><button type="button" class="btn sm" data-sa="keydel" data-id="${s.id}"${busy}>remover</button></div>`;
  // Codex pronto pelo login do ChatGPT (sem chave salva): a chave é só alternativa — não mostra o campo, só um link
  if(s.id==='codex' && s.ready && !s.keySaved && !suaIaUi.editKey[s.id]) return `<div class="suaia-key"><button type="button" class="linkbtn dim" data-sa="keyedit" data-id="${s.id}"${busy}>usar uma chave da OpenAI em vez do login do ChatGPT</button></div>`;
  const lead=s.id==='codex'&&!s.ready?'sem plano do ChatGPT? cole uma chave da OpenAI (opcional):':s.id==='codex'?'chave da OpenAI (opcional — o login do ChatGPT já basta):':'cole a chave da DeepSeek:';
  const fid=`suaIaKey-${hk}-${s.id}`; // único por container (o tour e as Configurações podem estar abertos juntos)
  return `<div class="suaia-key"><label class="dim suaia-lbl" for="${fid}">${esc(lead)}</label><input class="in mono" type="password" id="${fid}" data-sakey="${s.id}" autocomplete="off" spellcheck="false" placeholder="${s.id==='deepseek'?'chave de platform.deepseek.com':'sk-…'}"${busy}><button type="button" class="btn sm" data-sa="keysave" data-id="${s.id}"${busy}>${suaIaUi.busy[s.id]==='key'?'salvando…':'salvar'}</button>${s.keySaved?`<button type="button" class="btn sm" data-sa="keycancel" data-id="${s.id}">cancelar</button>`:''}</div>`;
}
// Claude: interruptor da % real do plano no medidor (barra de status do Claude Code). Só mexe no settings.json do
// Claude com este clique; a instalação/remoção é do CLI (src/claude-statusline.ts) via claude_statusline_set.
function suaIaSlHtml(s, hk){
  const fid=`suaIaSl-${hk}`, on=!!s.statuslineInstalled, busy=!!suaIaUi.busy.sl;
  const st=on?suaIaUi.slStatus:null;
  const repair=on && (s.statuslineRepair || (st && st.installed && st.nodeOk===false));
  const over=st && Array.isArray(st.overriddenBy) ? st.overriddenBy : [];
  const base=f=>String(f).split(/[\\/]/).slice(-2).join('/');
  return `<div class="suaia-sl"><input type="checkbox" role="switch" id="${fid}" data-sasl="1"${on?' checked':''}${busy?' disabled aria-busy="true"':''} aria-describedby="${fid}-d"><label for="${fid}">${busy?(on?'desativando…':'ativando…'):'Mostrar a % do plano do Claude no medidor'}</label></div>
    <div class="suaia-why dim" id="${fid}-d">${on?'Ativo: a barra de status do Claude Code manda a % das janelas de 5 h e da semana pro medidor.':'Instala uma barra de status no Claude Code que manda a % das janelas de 5 h e da semana pro medidor.'} Requer plano Pro/Max no Claude Code (com chave de API não há %). Se você já tem uma barra de status, ela continua aparecendo; desligar desfaz.</div>
    ${repair?`<div class="suaia-secret" role="status" data-sasl-repair="1">⚠ a barra de status do Claude precisa ser reparada — desligue e ligue de novo.</div>`:''}
    ${over.length?`<div class="suaia-secret" role="note" data-sasl-over="1">⚠ o projeto aberto define a própria barra de status (${esc(over.map(base).join(', '))}) — ela substitui a do Starfork nesse projeto, e a % do Claude não chega enquanto você usar o Claude Code nele.</div>`:''}`;
}
// estado detalhado da barra (node ok? o projeto aberto tem barra própria?) — só com ela ligada; sem bloquear o painel
function suaIaSlStatusLoad(){
  return Promise.resolve().then(()=>invoke('claude_statusline_status'))
    .then(r=>{ suaIaUi.slStatus=r&&typeof r==='object'?r:null; suaIaRefresh(); })
    .catch(()=>{ suaIaUi.slStatus=null; });
}
function suaIaCardHtml(s, opts, shortest, ob){
  const e=suaIaEngine(s.id), d=aiDefaults(), isDef=suaIaDefEng()===s.id, hk=opts.hk||'h';
  const model=suaIaModel(s.id), models=suaIaModels(s);
  if(model && !models.some(m=>m.id===model)) models.push({ id:model, name:model+' (outro modelo)' });
  const busy=suaIaUi.busy[s.id], msg=suaIaUi.msg[s.id];
  const name=suaIaName(s);
  const used=(suaIaList||[]).find(x=>x.inUse);
  // Ajustes (F4): o formulário do gateway mora DENTRO do cartão (um cartão só pra IA da sua empresa); recolhido quando pronto
  const gwCfg=s.id==='gateway' && opts.ctx==='ajustes' ? `<details class="suaia-gwd"${s.ready?'':' open'}><summary>endereço, chave e modelo</summary><div class="suaia-gw" data-sagw="${hk}"></div></details>`
    : s.id==='gateway' && !s.ready ? (opts.ctx==='cfg'
      ? `<div class="suaia-fix"><span>O endereço, a chave e o modelo ficam logo abaixo, em <b>IA da sua empresa</b>.</span><button type="button" class="btn sm" data-sa="gwscroll">configurar</button></div>`
      : (suaIaUi.gwOpen?`<div class="suaia-gw" data-sagw="${hk}"></div>`:`<div class="suaia-fix"><span>Use o endpoint da sua empresa (OpenAI-compatível): URL, chave e modelo.</span><button type="button" class="btn sm" data-sa="gwopen">configurar aqui</button></div>`)) : '';
  const note=isDef&&!s.ready ? ` · <b>seu padrão não está pronto</b>${used?` — por enquanto as chamadas usam ${esc(suaIaName(used))}`:''}`
    : (s.inUse&&!isDef ? ' · <b>em uso agora</b> (seu padrão não está pronto)' : '');
  const cand=ob && ob.candidates.includes(s.id), picked=ob && suaIaObPickId()===s.id;
  return `<div class="suaia-card${isDef?' def':''}${shortest&&shortest.id===s.id?' short':''}${cand?' cand':''}${picked?' pick':''}" data-suaia="${s.id}">
    <div class="suaia-head"><span class="aiic" style="color:${e.color}">${e.icon||''}</span><b class="suaia-name">${esc(name)}</b>${s.id==='deepseek'?'<span class="suaia-tag">beta</span>':''}
      <span class="suaia-st ${s.ready?'ok':'bad'}" title="${escA(s.reason||'')}">${s.ready?'● ':'○ '}${esc(suaIaStateText(s))}</span>${isDef?'<span class="suaia-tag def">padrão</span>':''}${picked?'<span class="suaia-tag def">✓ escolhida</span>':''}</div>
    <div class="suaia-why">${esc(s.reason||'')}${note}</div>
    ${SUAIA_SECRET_NOTE[s.id]?`<details class="suaia-secret dim" data-suaia-secret="${s.id}"><summary>privacidade nos chats</summary>${esc(SUAIA_SECRET_NOTE[s.id])}</details>`:''}
    ${s.ready?'':suaIaFixesHtml(s.fixes)}${gwCfg}${suaIaKeyHtml(s, hk)}${s.id==='claude'&&s.installed?suaIaSlHtml(s, hk):''}
    <div class="suaia-row">
      ${s.state==='install'?'':`<select class="in suaia-model" data-samodel="${s.id}" aria-label="modelo do ${escA(name)}">${models.map(m=>`<option value="${escA(m.id)}"${m.id===model?' selected':''}>${esc(m.name)}</option>`).join('')}</select>`}
      <button type="button" class="btn sm" data-sa="test" data-id="${s.id}"${busy==='test'||!s.ready?' disabled':''} title="${s.ready?'faz uma chamada curtinha de verdade':'configure antes de testar'}">${busy==='test'?'testando…':'testar'}</button>
      <button type="button" class="btn sm" data-sa="recheck" data-id="${s.id}"${_suaIaP?' disabled':''}>verificar de novo</button>
      <span style="flex:1"></span>
      ${cand&&!picked?`<button type="button" class="btn sm" data-sa="obpick" data-id="${s.id}">escolher esta</button>`:''}
      ${isDef&&suaIaNormModel(s.id, d.model)===model?'<span class="suaia-ok">✓ seu padrão</span>':`<button type="button" class="btn${s.ready?' primary':''} sm" data-sa="default" data-id="${s.id}">usar como padrão</button>`}
    </div>
    ${msg?`<div class="suaia-out ${msg.ok?'ok':'bad'}" role="status" title="${escA(msg.raw||'')}">${esc(msg.text)}</div>`:''}
  </div>`;
}
// Fora do Claude o "modo protegido" (deny de .env/chaves do claude) não existe: o sandbox só-leitura do Codex e o do
// dsh não têm lista de caminhos proibidos pra LEITURA — o chat só pede no prompt pra não ler. Aviso visível no cartão.
// O gateway não lê arquivo nenhum (sem ferramentas), mas recebe o que você escrever na conversa.
const SUAIA_SECRET_NOTE={
  codex:'Fora do Claude, a IA dos chats consegue ler arquivos como .env do projeto (o Codex só-leitura não bloqueia caminhos) — o app pede pra ela não ler, mas não impede.',
  deepseek:'Fora do Claude, a IA dos chats consegue ler arquivos como .env do projeto (o DeepSeek só-leitura não bloqueia caminhos) — o app pede pra ela não ler, mas não impede.',
  gateway:'Fora do Claude, os chats não leem arquivos do projeto pelo gateway — mas tudo o que você escrever na conversa vai pro gateway.',
};
// HTML do painel inteiro (sem efeitos) — opts.ctx: 'cfg' | 'onboarding'; opts.hk: chave única do container
function suaIaHtml(list, opts){
  opts=opts||{};
  if(!list) return `<div class="dim suaia-loading">verificando as IAs deste computador…</div>`;
  if(!list.length) return `<div class="suaia-none">Não consegui verificar as IAs agora${suaIaUi.loadErr?' ('+esc(suaIaUi.loadErr.slice(0,120))+')':''}. <button type="button" class="btn sm" data-sa="recheck">verificar de novo</button></div>`;
  const sh=suaIaShortest(list);
  const ob=opts.ctx==='onboarding'?suaIaObSuggest(list, suaIaDefEng()):null;
  const head=sh?`<div class="suaia-none" role="note"><b>Nenhuma IA pronta neste computador ainda.</b> O caminho mais curto: <b>${esc(suaIaName(sh))}</b> — ${esc(sh.reason||suaIaStateText(sh))}. Faça o passo destacado abaixo e clique em <b>verificar de novo</b>.</div>`
    : ob ? `<div class="suaia-none" role="note">Seu padrão ainda não está pronto neste computador. ${ob.pick?`Vamos usar <b>${esc(suaIaName(suaIaOf(ob.pick)))}</b>, que já está pronta — é só continuar.`:'Escolha uma das IAs prontas abaixo (<b>escolher esta</b>) e continue.'}</div>` : '';
  const sorted=[...list].sort((a,b)=>SUA_IA_ORDER.indexOf(a.id)-SUA_IA_ORDER.indexOf(b.id));
  return head+`<div class="suaia-list">${sorted.map(s=>suaIaCardHtml(s, opts, sh, ob)).join('')}</div>`;
}
// o elemento focado vira um seletor ESCOPADO (data-*), pra devolver o foco depois do redesenho
function suaIaFocusSel(host){
  const a=document.activeElement; if(!a || !host.contains(a) || !a.dataset) return '';
  if(a.dataset.sakey) return `[data-sakey="${a.dataset.sakey}"]`;
  if(a.dataset.samodel) return `[data-samodel="${a.dataset.samodel}"]`;
  if(a.dataset.sa) return `[data-sa="${a.dataset.sa}"]${a.dataset.id?`[data-id="${a.dataset.id}"]`:''}`;
  return '';
}
function suaIaRender(host){
  if(!host) return;
  const opts=host.__suaIa||{};
  // não apaga o que a pessoa está digitando (chaves) nem o form do gateway montado no cartão
  const typing={}; host.querySelectorAll('[data-sakey]').forEach(i=>{ if(i.value) typing[i.dataset.sakey]=i.value; });
  const focusSel=suaIaFocusSel(host);
  const oldGw=host.querySelector('[data-sagw]');
  if(oldGw && oldGw.parentNode) oldGw.parentNode.removeChild(oldGw);
  host.innerHTML=suaIaHtml(suaIaList, opts);
  Object.keys(typing).forEach(k=>{ const i=host.querySelector(`[data-sakey="${k}"]`); if(i) i.value=typing[k]; });
  const ph=host.querySelector('[data-sagw]');
  if(ph){
    if(oldGw && oldGw.firstChild) ph.replaceWith(oldGw);
    // a config "Gateway próprio" (41-assinatura-chaves), montada DENTRO do cartão e escopada nele
    else if(typeof routeAiCfgHtml==='function' && typeof wireRouteAiCfg==='function'){ ph.innerHTML=routeAiCfgHtml(); wireRouteAiCfg(ph); }
  }
  if(focusSel){ const f=host.querySelector(focusSel); if(f && f.focus) f.focus(); }
  if(typeof opts.onPick==='function'){ const id=suaIaObPickId(); try{ opts.onPick(id, id?suaIaName(suaIaOf(id)):''); }catch(_){ } }
}
function suaIaRefresh(){
  _suaIaHosts.forEach(h=>{ if(!h.isConnected) _suaIaHosts.delete(h); else suaIaRender(h); });
  // seletores (formulário/planner) mostram o estado em cada cartão
  if(typeof aiPickRender==='function' && document.querySelector('.aipick')) aiPickRender();
}
// ---- ações (exportadas pros testes) ----
async function suaIaSaveKey(id, value){
  const s=suaIaOf(id); const v=String(value||'').trim();
  if(!s || !s.keyName || !v) return false;
  if(typeof SB==='undefined' || !SB.sess()) throw new Error('Entre na sua conta pra salvar a chave — ela fica no cofre da conta e vale em todos os seus computadores.');
  await secretSet(s.keyName, v);
  await suaIaLoad(true);
  // o secretSet engole falha do sync nuvem → llm.env: só é "salva" se ESTE computador já enxerga a chave
  const s2=suaIaOf(id);
  if(!s2 || !s2.keySaved) throw new Error('A chave foi salva na conta mas não chegou neste computador — verifique o login e tente de novo.');
  suaIaUi.editKey[id]=false;
  return true;
}
async function suaIaRemoveKey(id){
  const s=suaIaOf(id); if(!s || !s.keyName) return false;
  if(!await askYes('Remover a chave do '+suaIaName(s)+' da sua conta (e deste computador)?')) return false;
  await secretDel(s.keyName);
  await suaIaLoad(true);
  return true;
}
// motor não pronto só vira padrão depois de confirmar (as demandas novas falhariam até configurar)
async function suaIaUseDefault(id, model){
  const s=suaIaOf(id); if(model===undefined) model=suaIaModel(id);
  if(!s || !s.ready){
    const nm=s?suaIaName(s):suaIaEngine(id).name;
    if(!await askYes(`${nm} ainda não está pronto (${suaIaStateText(s)}). Usar como padrão mesmo assim? As demandas novas vão falhar até você terminar de configurar.`, 'Sua IA')) return false;
  }
  aiSaveDefaults(id, model||'');
  suaIaUi.model[id]=model||'';
  if(typeof aiApplyDefaults==='function') aiApplyDefaults();
  if(typeof pmRender==='function') pmRender(); // a linha do medidor minimizado é a IA padrão
  suaIaRefresh();
  return true;
}
// interruptor da barra de status do Claude: liga/desliga pelo CLI e relê o painel e o medidor
async function suaIaSetStatusline(on){
  suaIaUi.busy.sl=true; suaIaUi.msg.claude=null; suaIaRefresh();
  try{
    const r=await invoke('claude_statusline_set',{ on:!!on })||{};
    suaIaUi.msg.claude={ ok:true, text:'✓ '+(r.message||(on?'% do Claude ativada':'% do Claude desativada')) };
  }catch(e){
    const raw=String((e&&e.message)||e||'');
    const ctx=on?'Não consegui ativar a % do Claude':'Não consegui desativar a % do Claude';
    suaIaUi.msg.claude={ ok:false, text:'✕ '+(typeof humanErr==='function'?humanErr(e, ctx).msg:ctx+': '+raw), raw };
  }
  suaIaUi.busy.sl=false;
  await suaIaLoad(true);
  if(typeof planMeterReset==='function') planMeterReset();
  return suaIaUi.msg.claude;
}
// 1º acesso: o motor que o "continuar" vai aplicar (escolha da pessoa entre os candidatos, ou o único pronto)
function suaIaObPickId(){
  const ob=suaIaObSuggest(suaIaList, suaIaDefEng()); if(!ob) return null;
  if(suaIaUi.obPick && ob.candidates.includes(suaIaUi.obPick)) return suaIaUi.obPick;
  return ob.pick;
}
// "continuar" do passo de IA: aplica a escolha (motor pronto → sem pergunta). "decido depois" não chama isto.
function suaIaObApply(){
  const id=suaIaObPickId(); if(!id) return null;
  aiSaveDefaults(id, suaIaModel(id)||'');
  if(typeof aiApplyDefaults==='function') aiApplyDefaults();
  suaIaRefresh();
  return id;
}
window.suaIaObApply=suaIaObApply;
async function suaIaTest(id){
  const model=suaIaModel(id);
  suaIaUi.busy[id]='test'; suaIaUi.msg[id]=null; suaIaRefresh();
  try{
    const r=await invoke('ai_test',{ engine:id, model:model||null })||{};
    const secs=((Number(r.ms)||0)/1000).toFixed(1).replace('.',',');
    const used=r.model?r.model:'o modelo padrão';
    suaIaUi.msg[id]={ ok:true, text:`✓ ${r.engine||suaIaEngine(id).name} respondeu “${String(r.text||'').slice(0,80)}” com ${used} em ${secs}s`
      +(r.fallback?` — atenção: “${r.requested||model}” não foi aceito, respondeu ${r.model?r.model:'o padrão'}`:'') };
  }catch(e){
    const raw=String((e&&e.message)||e||'');
    suaIaUi.msg[id]={ ok:false, text:'✕ '+(raw.split('\n\n')[0]||'O teste falhou — tente de novo.'), raw };
  }
  suaIaUi.busy[id]=null; suaIaRefresh();
  return suaIaUi.msg[id];
}
// abre o painel em Ajustes › IA e modelos (link "configurar" dos seletores, medidor, erros) — aba, não modal
function suaIaOpenCfg(){
  if(typeof ajustesOpen==='function') ajustesOpen('motores'); else if(window.openTab) window.openTab('cfg');
  setTimeout(()=>{ const el=$id('suaIaCfg'); if(el && el.scrollIntoView) el.scrollIntoView(typeof scrollOpts==='function'?scrollOpts('start'):{ block:'start' }); }, 120);
}
window.suaIaOpenCfg=suaIaOpenCfg;
function suaIaWire(host){
  host.onclick=async ev=>{
    const b=ev.target.closest && ev.target.closest('[data-sa]'); if(!b || !host.contains(b) || b.disabled) return;
    // cliques DENTRO do form do gateway são dele
    if(b.closest('[data-sagw]')) return;
    const a=b.dataset.sa, id=b.dataset.id;
    if(a==='copy'){ if(typeof envCopy==='function') envCopy(b); return; }
    if(a==='recheck'){ if(typeof secretsAvailRefresh==='function') secretsAvailRefresh(); /* + medidor do plano */ const p=suaIaLoad(true); suaIaRender(host); await p; return; }
    if(a==='test'){ await suaIaTest(id); return; }
    if(a==='obpick'){ suaIaUi.obPick=id; suaIaRefresh(); return; }
    if(a==='default'){ try{ if(await suaIaUseDefault(id)) toast('IA padrão: '+(typeof aiRunLabel==='function'?aiRunLabel(id, suaIaModel(id)):id),'ok'); }catch(e){ showErr(e,'Não consegui salvar a IA padrão'); } return; }
    if(a==='keyedit'){ suaIaUi.editKey[id]=true; suaIaRefresh(); const i=host.querySelector(`[data-sakey="${id}"]`); if(i) i.focus(); return; }
    if(a==='keycancel'){ suaIaUi.editKey[id]=false; suaIaRefresh(); return; }
    if(a==='keysave'){ const i=host.querySelector(`[data-sakey="${id}"]`); await suaIaKeyGo(id, i&&i.value, host); return; }
    if(a==='keydel'){ suaIaUi.busy[id]='key'; suaIaRefresh(); try{ await suaIaRemoveKey(id); }catch(e){ suaIaUi.msg[id]={ ok:false, text:'✕ '+humanErr(e,'Não consegui remover a chave').msg }; } suaIaUi.busy[id]=null; suaIaRefresh(); return; }
    if(a==='gwopen'){ suaIaUi.gwOpen=true; suaIaRefresh(); return; }
    // o "Gateway próprio" das Configurações fica logo abaixo do painel, no mesmo container
    if(a==='gwscroll'){ const r=host.parentElement && host.parentElement.querySelector('#raHost'); if(r && r.scrollIntoView) r.scrollIntoView(typeof scrollOpts==='function'?scrollOpts('start'):{ block:'start' }); return; }
  };
  host.onchange=ev=>{ const sl=ev.target.closest && ev.target.closest('[data-sasl]'); if(sl && host.contains(sl)){ suaIaSetStatusline(!!sl.checked); return; } const s=ev.target.closest && ev.target.closest('[data-samodel]'); if(!s || !host.contains(s)) return; suaIaUi.model[s.dataset.samodel]=s.value; suaIaUi.msg[s.dataset.samodel]=null; suaIaRefresh(); };
  host.onkeydown=ev=>{ const i=ev.target.closest && ev.target.closest('[data-sakey]'); if(i && host.contains(i) && ev.key==='Enter'){ ev.preventDefault(); suaIaKeyGo(i.dataset.sakey, i.value, host); } };
}
async function suaIaKeyGo(id, value, host){
  if(!String(value||'').trim()){ suaIaUi.msg[id]={ ok:false, text:'Cole a chave antes de salvar.' }; suaIaRefresh(); return; }
  suaIaUi.busy[id]='key'; suaIaUi.msg[id]=null; suaIaRefresh();
  try{
    await suaIaSaveKey(id, value);
    const i=host && host.querySelector(`[data-sakey="${id}"]`); if(i) i.value='';
    const s=suaIaOf(id);
    // chave salva mas a IA ainda não roda aqui (ex.: DeepSeek sem instalar): não é sucesso — diz o que falta
    suaIaUi.msg[id]=s&&s.ready?{ ok:true, text:'✓ chave salva — pronto pra usar' }:{ ok:false, text:'Chave salva, mas ainda falta um passo'+(s&&s.reason?': '+s.reason:'')+' — veja acima.' };
  }catch(e){ suaIaUi.msg[id]={ ok:false, text:'✕ '+humanErr(e,'Não consegui salvar a chave').msg, raw:String((e&&e.message)||e||'') }; }
  suaIaUi.busy[id]=null; suaIaRefresh();
}
// monta o painel num container (Configurações ou passo do primeiro acesso). opts: { ctx, fresh, onPick(id, nome) }
function suaIaMount(host, opts){
  if(!host) return;
  host.__suaIa=Object.assign({}, opts||{}, { hk:(host.__suaIa&&host.__suaIa.hk)||('h'+(++_suaIaSeq)) });
  host.classList.add('suaia');
  _suaIaHosts.add(host);
  suaIaWire(host);
  suaIaRender(host);
  suaIaLoad(!!(opts&&opts.fresh)).catch(()=>{});
}
window.suaIaMount=suaIaMount;
