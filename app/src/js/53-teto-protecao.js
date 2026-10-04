// Starfork — 53-teto-protecao
// Duas decisões da mesa (party mode 27/09):
//  (3) TETO DE CUSTO POR TAREFA: ao chegar no teto a tarefa PAUSA e fica em "Aguardando você"
//      com a pergunta "continuar com mais US$ X / parar aqui". O teto mora no spec da tarefa
//      (spec.budgetUsd, via patch_task_spec — sobrevive a reinício); sem ele vale o padrão de
//      Configurações (costCapDefault). O estado "bateu no teto" é spec.budgetHit.
//  (4) MODO PROTEGIDO: selo na tarefa + chave em Preferências do projeto (settings.json
//      `protect:<repo>`; o Rust passa CARDUME_PROTECT pro motor).

// ---------- (3) teto ----------
// A pergunta do teto é uma PENDÊNCIA sintética (id negativo) injetada no snapshot: assim ela
// aparece em TODO lugar que já sabe mostrar "aguardando você" (quadro, aba, notificação,
// conversa com os botões de opção) sem um caminho paralelo. resolvePending() desvia ids < 0 pra cá.
// teto SEMPRE ligado (mesa 03/10): 0 não é mais "sem teto" — vale o padrão de Configurações
function budgetOf(t){ const b=((t&&t.spec)||{}).budgetUsd; return (b!=null && b!=='' && +b>0) ? +b : costCapDefault(); }
function budgetPendId(taskId){ let h=0; for(const ch of String(taskId)) h=(h*31+ch.charCodeAt(0))|0; return -(Math.abs(h)%2000000000+1); }
// liberar mais NUNCA é um clique só (veto da Carla + pedido do Rafa): é sempre o VALOR escrito e o MOTIVO, que vai pro PR
const BUDGET_STOP_TXT='Parar aqui';
function budgetPrompt(t, hit){
  const cap=+hit.cap||budgetOf(t), usd=+hit.usd||0, pct=Math.round(usd/(cap||1)*100);
  return `A tarefa “${t.title||t.id}” já usou ${fmtCost(usd)} de ${fmtCost(cap)} (${pct}% do teto).\n\n`+
    (hit.mode==='stopped' ? 'O agente foi parado (neste sistema não dá pra congelar). ' : hit.mode==='etapa' ? 'Parei antes da próxima etapa — nada se perde. ' : 'O agente está pausado — nada se perde. ')+
    'Pra seguir, escreva quanto liberar e o motivo (ex.: “liberar 2 porque falta o teste de login”) — o motivo vai pro PR. Parar deixa o trabalho como está, pra você revisar.';
}
// chamada no refresh ANTES do detectNotifs: a pergunta nova vira notificação "Precisa de você"
function budgetInject(snap){
  if(!snap || !Array.isArray(snap.tasks)) return;
  const pend=Array.isArray(snap.pending)?snap.pending:(snap.pending=[]);
  for(const t of snap.tasks){
    const hit=(t.spec||{}).budgetHit; if(!hit) continue;
    if(!(t.status==='paused' || t.status==='needs-you' || (hit.mode==='stopped' && t.status==='review'))) continue;
    // F4: aviso do sistema, não pergunta de agente
    pend.push({ id:budgetPendId(t.id), taskId:t.id, agent:'Aviso do Starfork', kind:'budget', notice:true, createdAt:+hit.at||0,
      prompt:budgetPrompt(t, hit), options:[BUDGET_STOP_TXT] });
  }
}
const budgetBusy=new Set();
// o teto entrou no app em 28/09/2026 03:17 UTC: tarefa criada ANTES dele não tinha teto nenhum
const BUDGET_SINCE_MS=Date.UTC(2026,8,28,3,17);
function taskCreatedMs(t){ return taskTs(t); } // fonte única: taskTs (22-quadro-fluxo)
const IS_WIN=/win/i.test((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'');
// vigia do refresh (custo vem no snapshot — barato). Dispara UMA vez por teto: marca spec.budgetHit,
// e "continuar" sobe o teto. O custo entra no banco no FIM de cada turno de agente, então a
// checagem acontece entre turnos (não no meio de um).
function budgetWatch(){
  const tasks=(state&&state.tasks)||[];
  for(const t of tasks){
    if(budgetBusy.has(t.id)) continue;
    const sp=t.spec||{}, cap=budgetOf(t), spent=taskCost(t.id).usd;
    // tarefa do PILOTO AUTOMÁTICO: ninguém responde a pergunta do teto e pausar congelaria o piloto inteiro (o
    // grupo do processo é dele) — o teto dela (o que sobra do teto do piloto) é decidido pelo próprio piloto
    if(sp.autopilot) continue;
    const active=['running','thinking','queued'].includes(t.status);
    // reparo: tarefa ANTERIOR ao teto, pausada pelo teto padrão aplicado retroativamente (bug do PR #31,
    // o snapshot nem mostrava a pergunta) → desfaz a pausa indevida: teto a partir do gasto atual + retoma
    if(sp.budgetHit && (sp.budgetUsd==null || sp.budgetUsd==='') && taskCreatedMs(t)<BUDGET_SINCE_MS){
      budgetBusy.add(t.id);
      (async()=>{
        await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, budgetUsd:+(spent+(costCapDefault()||5)).toFixed(2) } });
        if(t.status==='paused'){ try{ await invoke('resume_task',{ taskId:t.id }); }catch(e){ console.error('teto: retomar', e); } }
        lastSig=''; await refresh();
      })().catch(e=>console.error('teto', e)).finally(()=>budgetBusy.delete(t.id));
      continue;
    }
    if(sp.budgetHit){
      // retomada por outro caminho (▶ retomar, nova mensagem): a pergunta caducou, mas o teto NÃO sobe sozinho —
      // limpa a marca e, se o gasto segue ≥ 80%, o próximo tick pausa e pergunta de novo (liberar = valor + motivo)
      if(active){ budgetBusy.add(t.id); invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, needsYou:null } }).catch(e=>console.error('teto', e)).finally(()=>budgetBusy.delete(t.id)); }
      continue;
    }
    // pausa a 80% do teto (o motor também confere antes de cada etapa — aqui é o meio de um turno longo)
    if(!active || capCheck(spent, cap)==='ok') continue;
    // tarefa que já tinha gastado além do teto PADRÃO antes de ter um teto próprio (ex.: criada antes do
    // teto existir): não congela no meio do trabalho — o teto passa a contar a partir do gasto atual
    if((sp.budgetUsd==null || sp.budgetUsd==='') && taskCreatedMs(t)<BUDGET_SINCE_MS){
      budgetBusy.add(t.id);
      invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetUsd:+(spent+cap).toFixed(2) } }).catch(e=>console.error('teto', e)).finally(()=>budgetBusy.delete(t.id));
      continue;
    }
    budgetBusy.add(t.id);
    (async()=>{
      let mode='paused';
      try{ if(IS_WIN) throw new Error('win'); await invoke('pause_task',{ taskId:t.id }); }
      catch(_){ mode='stopped'; try{ budgetQuiet.add(t.id); await invoke('stop_task',{ taskId:t.id }); }catch(e){ console.error('teto: parar', e); } }
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:{ usd:+spent.toFixed(4), cap, at:Date.now(), mode } } });
      lastSig=''; await refresh();
    })().catch(e=>console.error('teto', e)).finally(()=>budgetBusy.delete(t.id));
  }
}
// tarefas paradas pelo teto/pelo humano não disparam o falso "Pronta para review ✓"
const budgetQuiet=new Set();
async function budgetAnswer(pendId, answer){
  // não achou: ERRO (antes voltava calado e a tela tratava como respondida — opções travadas, tarefa parada)
  const p=((state&&state.pending)||[]).find(x=>x.id===pendId); if(!p) throw new Error('essa pergunta do teto de custo já não está aberta — atualize a tela');
  const t=(state.tasks||[]).find(x=>x.id===p.taskId); if(!t) throw new Error('não achei a tarefa desta pergunta do teto de custo');
  const hit=(t.spec||{}).budgetHit||{}, cap=+hit.cap||budgetOf(t);
  const stop=/^\s*(parar|para\b|pare|stop|n[ãa]o\b)/i.test(String(answer||''));
  budgetBusy.add(t.id);
  try{
    if(stop){
      // parar aqui: encerra o turno congelado e volta pra revisão (sem a notificação de "pronta")
      if(hit.mode!=='stopped'){ budgetQuiet.add(t.id); await invoke('stop_task',{ taskId:t.id }); }
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, needsYou:null } });
      toast('Parada no teto — o trabalho ficou como está','ok');
    } else {
      // liberar = valor + motivo escritos (conversa, celular ou a seção da tarefa) — sem os dois, nada muda
      const r=parseRelease(answer); if(!r.ok) throw new Error(r.why);
      budgetBusy.delete(t.id);
      await budgetRelease(t, r.usd, r.reason);
    }
  }
  // o erro SOBE (quem respondeu mostra e destrava as opções): antes era engolido aqui e a conversa achava que
  // a resposta tinha ido — opções travadas e a tarefa parada no teto sem aviso
  finally{ budgetBusy.delete(t.id); lastSig=''; refresh().catch(()=>{}); }
}
// teto máximo da política da organização gravado NA TAREFA (fonte única: liberação e aviso usam esta)
function budgetOrgMax(t){ const p=((t&&t.spec)||{}).orgPolicy; return p&&+p.tetoMaxUsd>0?+p.tetoMaxUsd:null; }
// LIBERAR MAIS (P6): sobe o teto pelo valor escrito, guarda {valor, motivo} em spec.budgetReleases (vai pro PR) e
// retoma do jeito que parou: pausada → continua o processo; parada → manda seguir; entre etapas (motor) → ▶.
// Liberar pouco demais (ainda ≥ 80% do teto novo) só pararia de novo na hora: recusa dizendo o mínimo.
async function budgetRelease(t, usd, reason){
  const r=releaseCheck(usd, reason); if(!r.ok) throw new Error(r.why);
  const sp=t.spec||{}, hit=sp.budgetHit||null, cap=budgetOf(t), spent=taskCost(t.id).usd;
  const capAfter=+(cap+r.usd).toFixed(2);
  // F5 · P14: o teto máximo da política da organização vale também pra liberação (em palavra, com o valor)
  { const max=budgetOrgMax(t);
    if(max!=null && capAfter>max+1e-9) throw new Error('a política da organização limita o teto a '+fmtCost(max,{usdOnly:true})+' por tarefa — dá pra liberar no máximo '+fmtCost(Math.max(0,+(max-cap).toFixed(2)),{usdOnly:true})); }
  if(capCheck(spent, capAfter)!=='ok'){ const min=Math.max(0.01, Math.ceil((spent/CAP_PAUSE_AT-cap)*100+1)/100); throw new Error(`com ${fmtCost(r.usd,{usdOnly:true})} a tarefa ainda fica acima de 80% do teto — libere pelo menos ${fmtCost(min,{usdOnly:true})}`); }
  const rel={ usd:r.usd, reason:r.reason, at:Date.now(), capBefore:cap, capAfter };
  budgetBusy.add(t.id);
  try{
    await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetUsd:capAfter, budgetHit:null, needsYou:null, budgetReleases:[...(Array.isArray(sp.budgetReleases)?sp.budgetReleases:[]), rel] } });
    if(hit && hit.mode==='stopped'){ if(typeof talkTask==='function') await talkTask(t.id, 'Pode continuar de onde parou (o teto de custo foi ampliado).'); }
    else if(hit && hit.mode==='etapa') await invoke('start_task',{ taskId:t.id });
    else if(hit || t.status==='paused') await invoke('resume_task',{ taskId:t.id });
    toast('Liberado: teto agora é '+fmtCost(capAfter,{usdOnly:true})+' — o motivo vai pro PR','ok');
  } finally { budgetBusy.delete(t.id); lastSig=''; refresh().catch(()=>{}); }
}
// F4 · G3: o teto atingido aparece como "Aviso do Starfork" (não é pergunta de um agente fictício) — na linha da Central e
// na tarefa: "Parar aqui" ou "liberar até US$ X" com motivo (vai pro PR). Componente único: budgetNoticeHtml + budgetNoticeWire.
function budgetNoticeHtml(t){
  const hit=((t&&t.spec)||{}).budgetHit; if(!hit) return '';
  const cap=+hit.cap||budgetOf(t), usd=+hit.usd||0, pct=Math.round(usd/(cap||1)*100);
  const max=budgetOrgMax(t);
  const sug=Math.max(1, Math.ceil(cap));
  return `<div class="bnotice" role="status" data-bnotice="${escA(t.id)}"><div class="bn-h">${(typeof IC!=='undefined'&&IC.warn)||''}<b>Aviso do Starfork</b><span class="dim">· não é pergunta de agente</span></div>
    <p>A tarefa chegou a <b>${pct}% do teto</b>: ${esc(fmtCost(usd,{usdOnly:true}))} de ${esc(fmtCost(cap))}. ${hit.mode==='stopped'?'O agente foi parado':'Ela está pausada'} e nada se perdeu.</p>
    <div class="bn-a"><button type="button" class="btn sm" data-bn="stop">${BUDGET_STOP_TXT}</button><span class="dim">ou liberar mais</span><span class="ajmoney"><i>US$</i><input class="in" type="number" min="0.5" step="0.5" value="${sug}" data-bn-usd aria-label="quanto liberar, em dólar"></span><input class="in" data-bn-why placeholder="motivo (vai pro PR)" aria-label="motivo"><button type="button" class="btn primary sm" data-bn="go">Liberar e continuar</button></div>
    <p class="dim bn-f">${max!=null?'A organização permite até '+esc(fmtCost(max,{usdOnly:true}))+' por tarefa (Regras da organização). ':''}O teto padrão fica em Ajustes › Custo e limites.</p><p class="bn-err" role="alert" hidden></p></div>`;
}
function budgetNoticeWire(root){
  if(!root) return;
  root.querySelectorAll('[data-bnotice]').forEach(box=>{
    const t=((state&&state.tasks)||[]).find(x=>String(x.id)===box.dataset.bnotice); if(!t) return;
    const err=m=>{ const e=box.querySelector('.bn-err'); if(e){ e.textContent=m; e.hidden=!m; } };
    box.querySelectorAll('[data-bn]').forEach(b=>b.onclick=async()=>{
      b.disabled=true; err('');
      try{
        const pend=((state&&state.pending)||[]).find(p=>p.kind==='budget' && String(p.taskId)===String(t.id));
        if(!pend && !((t.spec||{}).budgetHit)){ err('Este aviso já foi resolvido — a tela vai atualizar.'); b.disabled=false; return; }
        if(b.dataset.bn==='stop'){ if(pend) await budgetAnswer(pend.id, BUDGET_STOP_TXT); else { err('Este aviso já foi resolvido — a tela vai atualizar.'); b.disabled=false; } }
        else { const usd=parseFloat(String(box.querySelector('[data-bn-usd]').value).replace(',','.')), why=String(box.querySelector('[data-bn-why]').value||'').trim();
          if(!(usd>0)){ err('Escreva quanto liberar — um valor em US$ maior que 0.'); b.disabled=false; box.querySelector('[data-bn-usd]').focus(); return; }
          if(!why){ err('Escreva o motivo — ele vai pro PR.'); b.disabled=false; box.querySelector('[data-bn-why]').focus(); return; }
          await budgetRelease(t, usd, why); }
      }catch(e){ err(humanErr(e,'Não deu').msg); b.disabled=false; }
    });
  });
}
// teto escolhido na criação (planner / Como executar) → vai pro spec depois do new_task
let ntBudgetPending=null;
function budgetFieldHtml(id){
  const v=ntBudgetPending!=null?ntBudgetPending:costCapDefault();
  return `<label class="budgetfld" title="Teto sempre ligado: a 80% dele a tarefa para e pergunta. Liberar mais pede o valor e o motivo."><span>teto da tarefa US$</span><input class="in" id="${id}" type="number" min="0.5" step="0.5" value="${escA(String(v))}"><span class="dim" data-brl="${id}">≈ R$ ${fmtNumBR(v*usdBrlRate(),true)} · para a 80%</span></label>`;
}
function budgetFieldWire(id){
  const el=$id(id); if(!el) return;
  // 0/vazio não desliga: vira o padrão de Configurações (o teto fica sempre ligado)
  el.oninput=()=>{ const raw=parseFloat(el.value); const v=raw>0?raw:costCapDefault(); ntBudgetPending=v; const s=document.querySelector(`[data-brl="${id}"]`); if(s) s.textContent='≈ R$ '+fmtNumBR(v*usdBrlRate(),true)+' · para a 80%'; };
}
async function budgetApply(taskId){
  let v=ntBudgetPending>0?ntBudgetPending:costCapDefault(); ntBudgetPending=null;
  // F5 · P14: o motor já nasceu a tarefa no teto da política da org — gravar o escolhido nunca passa dele
  if(typeof orgPolMaxUsd==='function'){ const max=orgPolMaxUsd(); if(max!=null && !(v>0 && v<=max)) v=max; }
  if(!taskId) return; // grava SEMPRE (inclusive igual ao padrão): o motor lê o teto do spec antes de cada etapa
  try{ await invoke('patch_task_spec',{ taskId:String(taskId), patch:{ budgetUsd:v } }); }catch(e){ console.error('teto da tarefa', e); }
}
// estimativa grosseira (nº de agentes × faixa por modelo) — mesma régua do "Como executar?"
function roughEstimate(nAgents, model){
  const per=({opus:[0.40,1.60], sonnet:[0.12,0.50], haiku:[0.03,0.12]})[model]||[0.15,0.65];
  const n=Math.max(1, +nAgents||1); return [per[0]*n, per[1]*n];
}

// ---------- (4) modo protegido ----------
const PROTECT_BLOCKS=[
  'ler ou editar segredos: .env (e .env.local/.production…), *.pem, *.key, id_rsa, ~/.ssh, ~/.aws',
  'rm -rf na raiz ou na home (/ e ~)',
  'git push --force / -f',
  'curl … | sh e wget … | sh',
  'sudo',
];
let protectCache={}; // repo → true/false (settings.json)
let protectLoaded=false;
function protectLoad(){
  protectLoaded=true; // uma leitura só (o refresh chama a cada tick); sem resposta vale o padrão: protegido
  return invoke('read_settings').then(s=>{ const o=JSON.parse(s||'{}'); const m={}; for(const k in o){ if(k.startsWith('protect:')) m[k.slice(8)]=String(o[k])!=='0'; } protectCache=m; lastSig=''; }).catch(()=>{});
}
function protectOnFor(repo){ const r=repo||(state&&state.repo)||''; return protectCache[r]!==false; }
async function protectSet(repo, on){
  protectCache[repo]=!!on;
  await invoke('write_setting',{ key:'protect:'+repo, value:on?'1':'0' });
}
function protectTip(on){
  return on ? 'Modo protegido — o agente NÃO consegue:\n• '+PROTECT_BLOCKS.join('\n• ')+'\nSe precisar, ele pergunta pra você. Troque em Projeto › Regras.'
            : 'Modo livre — sem regras de bloqueio: o agente pode ler .env e rodar qualquer comando. Troque em Projeto › Regras.';
}
function protectBadgeHtml(t){
  const on=protectOnFor((t&&t.repo)||(state&&state.repo));
  return `<span class="protbadge${on?'':' off'}" title="${escA(protectTip(on))}">${on?IC.shield:''}<span class="pbt">${on?'protegido':'livre'}</span></span>`;
}
// bloco de Preferências do projeto
function protectPrefsHtml(repo){
  const on=protectOnFor(repo);
  return `<div class="seclbl2" style="margin-top:18px">Proteção dos agentes</div>
    <div class="protopts" id="protOpts">
      <label class="howopt${on?' on':''}"><input type="radio" name="protmode" value="1"${on?' checked':''}><span><span class="ht">Protegido <span class="rec">PADRÃO</span></span><div class="hd">O agente trabalha sozinho, mas não lê nem edita segredos (.env, chaves, ~/.ssh, ~/.aws) e não roda comandos destrutivos (rm -rf em / ou ~, git push --force, curl | sh, sudo). Quando precisar de um desses, ele pergunta pra você.</div></span></label>
      <label class="howopt${on?'':' on'}"><input type="radio" name="protmode" value="0"${on?'':' checked'}><span><span class="ht">Livre</span><div class="hd">Sem bloqueios: o agente pode ler .env e rodar qualquer comando. Use só em projeto de teste ou quando você confia no que ele vai fazer.</div></span></label>
    </div>
    <div class="dim" style="font-size:var(--fs-xs);margin-top:6px">Vale pras próximas execuções deste projeto (inclusive o planner). Tarefa já rodando mantém o modo com que começou.</div>`;
}
function protectPrefsWire(repo){
  const box=$id('protOpts'); if(!box) return;
  box.querySelectorAll('input[name="protmode"]').forEach(r=>r.onchange=async()=>{
    box.querySelectorAll('.howopt').forEach(l=>l.classList.toggle('on', l.querySelector('input').checked));
    try{ await protectSet(repo, r.value==='1'); toast(r.value==='1'?'Agentes em modo protegido':'Agentes em modo livre — sem bloqueios', r.value==='1'?'ok':'info'); lastSig=''; }
    catch(e){ showErr(e, 'Não salvou'); }
  });
}
