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
function budgetOf(t){ const b=((t&&t.spec)||{}).budgetUsd; return (b!=null && b!=='' && +b>=0) ? +b : costCapDefault(); }
function budgetPendId(taskId){ let h=0; for(const ch of String(taskId)) h=(h*31+ch.charCodeAt(0))|0; return -(Math.abs(h)%2000000000+1); }
const BUDGET_STEP_TXT='Continuar com mais ';
function budgetPrompt(t, hit){
  const cap=+hit.cap||budgetOf(t);
  return `A tarefa “${t.title||t.id}” chegou no teto de ${fmtCost(cap)}. Já gastou ${fmtCost(+hit.usd||0)}.\n\n`+
    (hit.mode==='stopped' ? 'O agente foi parado (neste sistema não dá pra congelar). ' : 'O agente está pausado — nada se perde. ')+
    'Continuar libera mais um teto igual; parar deixa o trabalho como está, pra você revisar.';
}
// chamada no refresh ANTES do detectNotifs: a pergunta nova vira notificação "Precisa de você"
function budgetInject(snap){
  if(!snap || !Array.isArray(snap.tasks)) return;
  const pend=Array.isArray(snap.pending)?snap.pending:(snap.pending=[]);
  for(const t of snap.tasks){
    const hit=(t.spec||{}).budgetHit; if(!hit) continue;
    if(!(t.status==='paused' || (hit.mode==='stopped' && t.status==='review'))) continue;
    const cap=+hit.cap||budgetOf(t);
    pend.push({ id:budgetPendId(t.id), taskId:t.id, agent:'Starfork', kind:'budget', createdAt:+hit.at||0,
      prompt:budgetPrompt(t, hit), options:[BUDGET_STEP_TXT+fmtCost(cap,{usdOnly:true}), 'Parar aqui'] });
  }
}
const budgetBusy=new Set();
// o teto entrou no app em 28/09/2026 03:17 UTC: tarefa criada ANTES dele não tinha teto nenhum
const BUDGET_SINCE_MS=Date.UTC(2026,8,28,3,17);
function taskCreatedMs(t){ const v=t&&(t.createdAt||t.created_at); const n=typeof v==='number'?v:Date.parse(v||''); return n>0&&n<1e12?n*1000:(n||0); }
const IS_WIN=/win/i.test((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'');
// vigia do refresh (custo vem no snapshot — barato). Dispara UMA vez por teto: marca spec.budgetHit,
// e "continuar" sobe o teto. O custo entra no banco no FIM de cada turno de agente, então a
// checagem acontece entre turnos (não no meio de um).
function budgetWatch(){
  const tasks=(state&&state.tasks)||[];
  for(const t of tasks){
    if(budgetBusy.has(t.id)) continue;
    const sp=t.spec||{}, cap=budgetOf(t), spent=taskCost(t.id).usd;
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
      // retomada por outro caminho (▶ retomar, nova mensagem): a pergunta caducou → libera mais um teto
      if(active){ budgetBusy.add(t.id); invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, budgetUsd:Math.max(cap, spent)+(costCapDefault()||cap||5) } }).catch(e=>console.error('teto', e)).finally(()=>budgetBusy.delete(t.id)); }
      continue;
    }
    if(!active || !(cap>0) || spent<cap) continue;
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
  const p=((state&&state.pending)||[]).find(x=>x.id===pendId); if(!p) return;
  const t=(state.tasks||[]).find(x=>x.id===p.taskId); if(!t) return;
  const hit=(t.spec||{}).budgetHit||{}, cap=+hit.cap||budgetOf(t);
  const stop=/^\s*(parar|para\b|pare|stop|n[ãa]o\b)/i.test(String(answer||''));
  budgetBusy.add(t.id);
  try{
    if(stop){
      // parar aqui: encerra o turno congelado e volta pra revisão (sem a notificação de "pronta")
      if(hit.mode!=='stopped'){ budgetQuiet.add(t.id); await invoke('stop_task',{ taskId:t.id }); }
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null } });
      toast('Parada no teto — o trabalho ficou como está','ok');
    } else {
      const next=+(Math.max(cap, +hit.usd||0)+(cap||costCapDefault()||5)).toFixed(2);
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, budgetUsd:next } });
      if(hit.mode==='stopped'){ if(typeof talkTask==='function') await talkTask(t.id, 'Pode continuar de onde parou (o teto de custo foi ampliado).'); }
      else await invoke('resume_task',{ taskId:t.id });
      toast('Teto ampliado pra '+fmtCost(next),'ok');
    }
  }catch(e){ showErr(e, 'Não deu pra aplicar a resposta do teto'); }
  finally{ budgetBusy.delete(t.id); lastSig=''; await refresh(); }
}
// teto escolhido na criação (planner / Como executar) → vai pro spec depois do new_task
let ntBudgetPending=null;
function budgetFieldHtml(id){
  const v=ntBudgetPending!=null?ntBudgetPending:costCapDefault();
  return `<label class="budgetfld" title="Quando o custo desta tarefa chegar aqui, ela pausa e pergunta se continua. 0 = sem teto."><span>parar e me perguntar se passar de US$</span><input class="in" id="${id}" type="number" min="0" step="1" value="${escA(String(v))}"><span class="dim" data-brl="${id}">${v>0?'≈ R$ '+fmtNumBR(v*usdBrlRate(),true):'sem teto'}</span></label>`;
}
function budgetFieldWire(id){
  const el=$id(id); if(!el) return;
  el.oninput=()=>{ const v=Math.max(0, parseFloat(el.value)||0); ntBudgetPending=v; const s=document.querySelector(`[data-brl="${id}"]`); if(s) s.textContent=v>0?'≈ R$ '+fmtNumBR(v*usdBrlRate(),true):'sem teto'; };
}
async function budgetApply(taskId){
  const v=ntBudgetPending; ntBudgetPending=null;
  if(!taskId || v==null || v===costCapDefault()) return; // igual ao padrão: não grava (segue o padrão)
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
  return on ? 'Modo protegido — o agente NÃO consegue:\n• '+PROTECT_BLOCKS.join('\n• ')+'\nSe precisar, ele pergunta pra você. Troque em Preferências do projeto.'
            : 'Modo livre — sem regras de bloqueio: o agente pode ler .env e rodar qualquer comando. Troque em Preferências do projeto.';
}
function protectBadgeHtml(t){
  const on=protectOnFor((t&&t.repo)||(state&&state.repo));
  return `<span class="protbadge${on?'':' off'}" title="${escA(protectTip(on))}">${on?'🛡 protegido':'livre'}</span>`;
}
// bloco de Preferências do projeto
function protectPrefsHtml(repo){
  const on=protectOnFor(repo);
  return `<div class="seclbl2" style="margin-top:18px">Proteção dos agentes</div>
    <div class="protopts" id="protOpts">
      <label class="howopt${on?' on':''}"><input type="radio" name="protmode" value="1"${on?' checked':''}><span><span class="ht">Protegido <span class="rec">PADRÃO</span></span><div class="hd">O agente trabalha sozinho, mas não lê nem edita segredos (.env, chaves, ~/.ssh, ~/.aws) e não roda comandos destrutivos (rm -rf em / ou ~, git push --force, curl | sh, sudo). Quando precisar de um desses, ele pergunta pra você.</div></span></label>
      <label class="howopt${on?'':' on'}"><input type="radio" name="protmode" value="0"${on?'':' checked'}><span><span class="ht">Livre</span><div class="hd">Sem bloqueios: o agente pode ler .env e rodar qualquer comando. Use só em projeto de teste ou quando você confia no que ele vai fazer.</div></span></label>
    </div>
    <div class="dim" style="font-size:11.5px;margin-top:6px">Vale pras próximas execuções deste projeto (inclusive o planner). Tarefa já rodando mantém o modo com que começou.</div>`;
}
function protectPrefsWire(repo){
  const box=$id('protOpts'); if(!box) return;
  box.querySelectorAll('input[name="protmode"]').forEach(r=>r.onchange=async()=>{
    box.querySelectorAll('.howopt').forEach(l=>l.classList.toggle('on', l.querySelector('input').checked));
    try{ await protectSet(repo, r.value==='1'); toast(r.value==='1'?'Agentes em modo protegido':'Agentes em modo livre — sem bloqueios', r.value==='1'?'ok':'info'); lastSig=''; }
    catch(e){ showErr(e, 'Não salvou'); }
  });
}
