// Starfork — 63-politica-org
// F5 da decisão da mesa de 03/10/2026 ("Governança e extras"), tudo dentro da aba Meu time (nunca modal):
//  - P14: POLÍTICA DA ORGANIZAÇÃO para agentes (plano Empresa) — portão obrigatório, teto máximo, revisor obrigatório,
//    revisor em motor/modelo diferente e quem aprova o aprendizado compartilhado. Mora em orgs.policy.agentes (nuvem);
//    o app só lê com sessão + org Empresa ativa e manda pro motor no new_task (≡ src/org-policy.ts, fixture dourado
//    tests/fixtures/ciclo-golden/politica.json). Sem login (Grátis) nada daqui roda: o local é livre e sem plano.
//  - P17: COMPARTILHAR APRENDIZADO POR ITEM com o time (Pro/Empresa) — "⇡ compartilhar" passa de novo pelo filtro de
//    segredo/injeção e pelo aviso de "nome de cliente"; a política diz quem aprova; trazer pro agente cai na fila
//    "pra você decidir" (aceite item a item, versão, volta). Nunca sincronia automática: a lista só é lida ao abrir.
//  - P15: TESTAR NUMA AMOSTRA (só o revisor, local) — reexecuta só a revisão da versão atual numa cópia descartável de
//    uma tarefa passada e põe o veredito de antes ao lado do de agora. Preço previsto em faixa + teto + askYes.

// @politica-puro-inicio (testado em app/tests/agentes-f5.test.mjs — sem DOM nem estado global)
const ORG_POL_DEFAULT=Object.freeze({ portao:false, tetoMaxUsd:null, revisor:false, revisorDiferente:false, aprovaAprendizado:'admins' });
// ≡ orgAgentPolicy (TS): lixo/ausente → nada exigido. Aceita { agentes:{…} } ou o bloco direto.
function orgAgentPolicy(raw){
  const o0=raw&&typeof raw==='object'?raw:{};
  const o=o0.agentes&&typeof o0.agentes==='object'?o0.agentes:o0;
  const t=Number(o.tetoMaxUsd);
  return { portao:o.portao===true, tetoMaxUsd:Number.isFinite(t)&&t>0?Math.round(t*100)/100:null, revisor:o.revisor===true,
    revisorDiferente:o.revisorDiferente===true, aprovaAprendizado:o.aprovaAprendizado==='membros'?'membros':'admins' };
}
function orgPolActive(p){ return !!p && (p.portao || p.tetoMaxUsd!=null || p.revisor || p.revisorDiferente); }
function polUsd(n){ return 'US$ '+(Math.round((Number(n)||0)*100)/100).toFixed(2).replace('.',','); }
// ≡ policyRules (TS): as regras em frases
function policyRules(p){
  const out=[];
  if(p.portao) out.push('toda tarefa passa pelo portão — nenhum PR abre sozinho e a prova é obrigatória');
  if(p.tetoMaxUsd!=null) out.push('teto de no máximo '+polUsd(p.tetoMaxUsd)+' por tarefa');
  if(p.revisor) out.push('toda equipe tem um revisor');
  if(p.revisorDiferente) out.push('o revisor roda em motor ou modelo diferente de quem constrói');
  out.push(p.aprovaAprendizado==='membros'?'aprendizado compartilhado com o time é aprovado por outra pessoa da organização':'aprendizado compartilhado com o time é aprovado por um admin da organização');
  return out;
}
// ≡ producerIndex / reviewerIsSame (src/lifecycle.ts) — o motor é quem decide, então a regra é a dele, letra por letra
function polProducerIdx(roles, ri){ for(let j=ri-1;j>=0;j--) if(['builder','docs','designer'].includes(roles[j].role)) return j; return -1; }
function polSame(a, b){ if(!a||!b) return false; return String(a.engine).toLowerCase()===String(b.engine).toLowerCase() && String(a.model==null?'':a.model).trim().toLowerCase()===String(b.model==null?'':b.model).trim().toLowerCase(); }
// ≡ teamPolicyIssues (TS)
function teamPolicyIssues(roles, p){
  const out=[], rs=Array.isArray(roles)?roles:[];
  const ri=rs.findIndex(r=>r.role==='reviewer');
  if(p.revisor && ri<0) out.push({ rule:'revisor', text:'a política da organização exige um revisor nesta equipe' });
  if(p.revisorDiferente && ri>=0){ const pi=polProducerIdx(rs, ri); if(pi>=0 && polSame(rs[pi], rs[ri])) out.push({ rule:'revisorDiferente', text:'a política da organização exige o revisor em motor ou modelo diferente de quem constrói ('+rs[ri].name+' e '+rs[pi].name+' estão no mesmo)' }); }
  return out;
}
// o que a equipe montada fere e se o motor conserta sozinho ao criar a tarefa (≡ applyOrgPolicy): revisor que falta
// entra do catálogo; revisor igual no Claude vai pra outro modelo. Senão a criação é recusada — "bloqueado".
function teamPolicyView(roles, p, catalogHasReviewer){
  return teamPolicyIssues(roles, p).map(x=>{
    if(x.rule==='revisor') return { text:x.text, blocked:!catalogHasReviewer, fix:catalogHasReviewer?'ao criar a tarefa, o revisor do catálogo entra no fim':'' };
    const ri=(roles||[]).findIndex(r=>r.role==='reviewer'), pi=ri>=0?polProducerIdx(roles, ri):-1;
    const claude=pi>=0 && String(roles[pi].engine).toLowerCase().startsWith('claude');
    return { text:x.text, blocked:!claude, fix:claude?'ao criar a tarefa, o revisor vai pra outro modelo do Claude':'' };
  });
}
// papéis de uma equipe do catálogo como o MOTOR monta (`cardume new --workflow` aplica o --engine/--model da tarefa
// em todos os papéis — toRole de src/config.ts): é isso que a política confere
function polWorkflowRoles(steps, agents, engine, model){
  const byId=Object.fromEntries((agents||[]).map(a=>[a.id,a]));
  return (steps||[]).map(id=>byId[id]).filter(Boolean).map(a=>({ role:a.role||'builder', name:a.name, engine:engine||a.engine||'claude', model:model!=null&&model!==''?model:(a.model||'') }));
}
// plano da org pras superfícies de nuvem: 'empresa' (política vale) · 'pago' (licença com validade) · '' (nada)
function orgPlanOf(org, now){
  if(!org) return '';
  const until=org.paid_until?new Date(org.paid_until).getTime():null;
  if(org.plan==='enterprise' && (until==null || until>now)) return 'empresa';
  if(until!=null && until>now) return 'pago';
  return '';
}
// recurso de nuvem do aprendizado (Pro/Empresa) ≡ org_cloud_ok da 0031: licença da org OU assinatura ativa
function orgCloudPaid(org, billing, now){ return !!org && (orgPlanOf(org, now)!=='' || !!(billing && ['active','trialing'].includes(billing.status))); }
// quem decide um item compartilhado ≡ org_learning_can_decide (0031): nunca quem compartilhou
function canDecideLearning(p, meRole, me, sharedBy){
  if(!me || me===sharedBy) return false;
  return meRole==='owner' || meRole==='admin' || (p && p.aprovaAprendizado==='membros');
}
function approverWords(p){ return p && p.aprovaAprendizado==='membros'?'outra pessoa da organização':'um admin da organização'; }
// "nome de cliente" antes de mandar pro time: e-mail, domínio/URL, CNPJ/CPF e nome próprio no meio da frase.
// Não bloqueia (quem decide é a pessoa) — vira aviso no askYes com os nomes achados.
const SHARE_KNOWN=new Set(['starfork','claude','codex','deepseek','github','git','supabase','react','node','typescript','javascript','rust','python','google','apple','windows','linux','mac','macos','ios','android','chrome','safari','tauri','vite','jest','playwright','sqlite','postgres','markdown','json','docker','vercel','stripe','pix','figma','slack','jira','linear','notion','expo','xcode','swift','kotlin','java','go','npm','yarn','pnpm','eslint','prettier','tailwind','next','vue','svelte','angular','sonnet','opus','haiku','gpt','openai','anthropic','português','inglês','brasil','segunda','terça','quarta','quinta','sexta','sábado','domingo','janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']);
function shareNames(text, ignore){
  let t=String(text==null?'':text);
  const skip=new Set((ignore||[]).map(x=>String(x||'').toLowerCase()).filter(Boolean));
  const out=[]; const add=x=>{ x=String(x).trim(); if(x && !out.some(y=>y.toLowerCase()===x.toLowerCase())) out.push(x); };
  t=t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, m=>{ add(m); return ' '; });
  t=t.replace(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|br|net|org|io|app|dev|gov|edu|co|me|ai)(?:\.[a-z]{2})?(?:\/\S*)?/gi, m=>{ add(m.replace(/\/.*$/,'').replace(/^https?:\/\//i,'')); return ' '; });
  t=t.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, m=>{ add('CNPJ '+m); return ' '; });
  t=t.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, m=>{ add('CPF '+m); return ' '; });
  // nome próprio: palavra com maiúscula que NÃO abre frase/linha/item/título e não é sigla curta nem nome conhecido
  const re=/(^|[\s(“"'])([A-ZÀ-Ý][a-zà-ÿ]{2,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ]{2,})*)/g; let m;
  while((m=re.exec(t))){
    const word=m[2], at=m.index+m[1].length, raw=t.slice(0, at);
    if(/(^|\n)[ \t]*(?:(?:[-*•]|\d+[.)]|#+)[ \t]+)?[(“"']*$/.test(raw)) continue;      // abre linha, item ou título
    if(/[.!?:;][\s(“"']*$/.test(raw)) continue;                                         // abre frase
    const parts=word.split(/\s+/).filter(w=>!SHARE_KNOWN.has(w.toLowerCase()) && !skip.has(w.toLowerCase()));
    if(parts.length) add(parts.join(' '));
  }
  return out.slice(0, 8);
}
// P15: tarefas passadas em que o agente deu veredito (as mais recentes primeiro) — a amostra
function polVerOf(text){ const parts=String(text==null?'':text).split(' · '); if(parts.length<2 || !/^skills ativas:/.test(parts[0])) return null; const m=/^\S.*@v(\d+)$/.exec(parts[1].trim()); return m?+m[1]:null; }
function sampleCandidates(rows, agentId, max){
  const seen=new Set(), out=[];
  for(const r of [...(rows||[])].filter(r=>r && r.agentId===agentId && +r.rounds>0).sort((a,b)=>(+b.createdAt||0)-(+a.createdAt||0))){
    if(seen.has(r.taskId)) continue; seen.add(r.taskId);
    out.push({ taskId:r.taskId, title:r.title||r.taskId, v:polVerOf(r.papel), muda:+r.muda>0 });
    if(out.length>=(max||8)) break;
  }
  return out;
}
// P15: preço previsto de UMA rodada de revisão desse agente, em faixa (nunca um número só) + o teto da amostra
function sampleEstimate(rows, agentId){
  const per=[...(rows||[])].filter(r=>r && r.agentId===agentId && +r.rounds>0 && +r.usd>0).sort((a,b)=>(+b.createdAt||0)-(+a.createdAt||0)).slice(0, 10).map(r=>(+r.usd)/Math.max(1, +r.rounds));
  let lo, hi;
  if(!per.length){ lo=0.05; hi=0.5; }
  else if(per.length<3){ const avg=per.reduce((s,x)=>s+x,0)/per.length; lo=avg*0.5; hi=avg*1.5; }
  else { lo=Math.min(...per); hi=Math.max(...per); }
  const r2=x=>Math.max(0.01, Math.round(x*100)/100);
  lo=r2(lo); hi=Math.max(r2(hi), lo);
  const cap=Math.max(0.25, Math.ceil(hi*2*20)/20);
  return { lo, hi, n:per.length, cap, text:polUsd(lo)+'–'+polUsd(hi).replace('US$ ','')+(per.length?'':' (sem histórico ainda)') };
}
function sampleVerdictText(v){
  if(!v || !v.kind) return 'sem veredito gravado';
  if(v.kind==='aprova') return 'aprova';
  if(v.kind==='muda') return 'muda ('+((v.items||[]).length)+')';
  return 'veredito ilegível';
}
// a comparação em palavra: mesmo veredito / veredito mudou — a palavra da Júlia nunca aparece
function sampleCompareText(r){
  const a=r&&r.old&&r.old.kind, b=r&&r.now&&r.now.kind;
  if(!a) return 'não havia veredito gravado nessa tarefa';
  return a===b?'mesmo veredito':'veredito mudou';
}
// @politica-puro-fim

// ---------------------------------------------------------------- estado (contido aqui)
const ORGP={ pol:null, at:0, key:'' };            // política lida (10 min em memória; a última fica em localStorage)
const ORGL={ id:null, rows:null, err:'', busy:false }; // itens do time do agente aberto na ficha
const SMP={ id:null, repo:'', list:null, running:'', runRepo:'', sel:'' };   // amostras do revisor aberto na ficha

function orgSessOk(){ return typeof SB!=='undefined' && SB.configured && SB.configured() && !!SB.sess(); }
function orgCur(){ return (typeof cloudData!=='undefined' && cloudData && cloudData.org) || null; }
function orgMe(){ return typeof cloudUserId==='function'?cloudUserId():''; }
function orgIsAdmin(){ const r=typeof cloudData!=='undefined'&&cloudData?cloudData.meRole:''; return r==='owner'||r==='admin'; }
// a RLS de `orgs` (0001: orgs_update) só deixa o DONO da org gravar — o formulário da política é só dele
function orgIsOwner(){ return typeof cloudData!=='undefined' && !!cloudData && cloudData.meRole==='owner'; }
function orgCloudOk(){ return orgSessOk() && orgCloudPaid(orgCur(), typeof myBilling!=='undefined'?myBilling:null, Date.now()); }

// P14: a política vigente (null = nenhuma). Sem sessão/Grátis: null sem tocar na rede. Offline com sessão: a última lida.
async function orgPolGet(force){
  if(!orgSessOk()){ ORGP.pol=null; return null; } // saiu da conta = Grátis: nada da política antiga fica valendo
  const me=orgMe(), org=orgCur(), lk='orgpol:'+me+':'+(org?org.id:(lsGet('orgpol-last:'+me)||''));
  const cached=()=>{ try{ const j=JSON.parse(lsGet(lk)||'null'); return j?orgAgentPolicy(j):null; }catch(_){ return null; } };
  if(!org){                                          // a nuvem ainda não carregou (ou está fora): vale a última lida
    if(typeof cloudData!=='undefined' && cloudData){ ORGP.pol=null; return null; } // carregou e não há org
    return cached();
  }
  try{ lsSet('orgpol-last:'+me, org.id); }catch(_){ }
  if(orgPlanOf(org, Date.now())!=='empresa'){ ORGP.pol=null; try{ lsSet(lk, 'null'); }catch(_){ } return null; }
  if(!force && ORGP.pol && ORGP.key===org.id && Date.now()-ORGP.at<10*60*1000) return ORGP.pol;
  try{
    // rede presa (VPN, portal cativo) não segura a criação da tarefa: 3 s e vale a última lida
    const rows=await Promise.race([sbGet('orgs?select=policy&id=eq.'+org.id), new Promise((_,rej)=>setTimeout(()=>rej(new Error('sem resposta da nuvem')), 3000))]);
    const p=orgAgentPolicy(((rows&&rows[0])||{}).policy||{});
    Object.assign(ORGP, { pol:p, at:Date.now(), key:org.id }); try{ lsSet(lk, JSON.stringify(p)); }catch(_){ }
    return p;
  }catch(_){ const c=cached(); if(c) Object.assign(ORGP, { pol:c, at:Date.now(), key:org.id }); return c; }
}
// todo new_task passa por aqui (chamado no começo do trkBeforeNewTask): põe a política no payload; o que o motor não
// conseguiria cumprir é recusado AQUI, em palavra, antes de criar worktree
async function orgPolBeforeNewTask(payload){
  let p=null; try{ p=await orgPolGet(); }catch(_){ p=null; }
  if(!p || !orgPolActive(p) || !payload) return payload;
  // o catálogo DESTE projeto, lido agora (state.config pode não ter carregado); sem cardume.config.json o motor usa o
  // catálogo padrão (que tem revisor) — aí quem julga é ele
  let cfg=null; try{ cfg=await invoke('config'); }catch(_){ cfg=state&&state.config; }
  const cat=(cfg&&cfg.agents)||[];
  if(p.revisor && cat.length && !cat.some(a=>a&&a.role==='reviewer')) throw new Error('a política da organização exige um revisor e o catálogo deste projeto não tem nenhum agente revisor — crie um em Meu time');
  if(p.revisorDiferente && payload.workflow){
    const w=((cfg&&cfg.workflows)||[]).find(x=>x.id===payload.workflow);
    const roles=w?polWorkflowRoles(w.steps, cat, payload.engine, payload.model):[];
    const bad=teamPolicyView(roles, Object.assign({}, p, { revisor:false }), true).find(x=>x.blocked);
    if(bad) throw new Error(bad.text+' — troque o motor ou o modelo do revisor na ficha dele (Meu time)');
  }
  payload.orgPolicy=p;
  return payload;
}
window.orgPolBeforeNewTask=orgPolBeforeNewTask;
// o teto máximo da política JÁ lida (budgetApply de 53-teto-protecao): null = sem máximo
function orgPolMaxUsd(){ const p=orgSessOk()?ORGP.pol:null; return p && p.tetoMaxUsd!=null ? p.tetoMaxUsd : null; }
// piloto automático: com o portão obrigatório ele não começa (aprova e mergeia sozinho); o resto vai pro motor
async function orgPolForPilot(){
  let p=null; try{ p=await orgPolGet(); }catch(_){ p=null; }
  if(!p || !orgPolActive(p)) return null;
  if(p.portao) throw new Error('a política da organização exige o portão em toda tarefa — o piloto automático aprova e mergeia sozinho, então ele não roda nesta organização');
  return p;
}
window.orgPolForPilot=orgPolForPilot;
// PATCH/DELETE que a RLS filtra devolvem 200 com 0 linhas — sem conferir, "salvo" mentiria
async function orgWrite(path, method, body){
  const r=await sbFetch(path, { method, headers:{ 'Prefer':'return=representation' }, body:body==null?undefined:JSON.stringify(body) });
  if(!Array.isArray(r) || !r.length) throw new Error('a nuvem não aceitou (sem permissão pra isso, ou alguém mudou agora há pouco)');
  return r;
}

// com a política exigindo revisor diferente, o aviso genérico "revisor igual ao builder" sai (a regra da org já diz)
function orgPolCovers(){ return !!(ORGP.pol && ORGP.pol.revisorDiferente); }
// avisos inline nas equipes (prontas e montadas): usa a política JÁ lida ao abrir a aba — nenhuma chamada aqui
function orgPolIssuesHtml(roles){
  const p=ORGP.pol; if(!p || !orgPolActive(p)) return '';
  const hasRev=(typeof cfgEdit!=='undefined'&&cfgEdit&&cfgEdit.agents||[]).some(a=>a&&a.role==='reviewer');
  return teamPolicyView(roles, p, hasRev).map(x=>`<p class="agwarn${x.blocked?' agpol-b':''}" role="note">${x.blocked?'bloqueado: ':''}${esc(x.text)}${x.fix?` <span class="dim">— ${esc(x.fix)}</span>`:''}</p>`).join('');
}

// "⇡ compartilhar com o time" de uma EQUIPE (escondido desde a F3 à espera da F5): só admin de org com nuvem paga
// (a RLS de org_workflows já é de admin) e só equipe que cumpre a política — o catálogo do time nunca recebe o que a
// organização proíbe
function orgCanShareTeams(){ return orgCloudOk() && orgIsAdmin(); }
function orgTeamShareBlock(roles){
  const p=ORGP.pol; if(!p || !orgPolActive(p)) return '';
  const bad=teamPolicyIssues(roles, p); return bad.length?bad[0].text:'';
}

// ---------------------------------------------------------------- P14: seção "Política da organização" (aba Meu time)
// A seção "Política da organização" saiu de Meu time: virou Ajustes › Regras da organização (UMA página com os padrões
// de demanda, versão e só leitura pra quem não é o dono). Aqui fica o atalho + a leitura que os avisos das equipes usam.
async function orgPolRender(){
  const el=$id('agPolicy'); if(!el) return;
  const org=orgCur();
  if(!orgSessOk() || !org){ el.innerHTML=''; return; }
  el.innerHTML=`<div class="ajband"><span>As regras da organização (portão, teto máximo, revisor, padrões de demanda) agora ficam em <b>Ajustes › Regras da organização</b>.</span><span class="r"><button type="button" class="btn sm" id="agPolGo">abrir</button></span></div>`;
  bindClick('agPolGo', ()=>{ if(typeof ajustesOpen==='function') ajustesOpen('regras'); });
  try{ await orgPolGet(); }catch(_){ }
  if(typeof renderTeams==='function') renderTeams(); if(typeof renderWf==='function') renderWf(); // os avisos inline usam a política lida
}
// ---------------------------------------------------------------- Ajustes › Regras da organização (F4 · G3)
// junta orgs.policy (padrões de demanda: minRequirements/provas/testes/doc/costWarn + o bloco agentes da P14) e
// orgs.spec_template. Salvar é EXPLÍCITO porque cria versão (ajPolicyNext: histórico no próprio jsonb, até 20);
// se a versão não puder ser gravada, cai no salvar simples. Quem não é o dono vê em modo leitura.
const ORGR={ orgId:'', saved:null, tpl:'', draft:null, draftTpl:'', canVersion:true, err:'' };
function orgRulesFlat(pol, tpl){
  const p=Object.assign({ minRequirements:1, proofRequired:true, testsRequired:true, docRequired:false, costWarn:25 }, pol||{});
  const a=orgAgentPolicy(p);
  return { minRequirements:+p.minRequirements||1, proofRequired:!!p.proofRequired, testsRequired:!!p.testsRequired, docRequired:!!p.docRequired, costWarn:+p.costWarn||0,
    tetoMaxUsd:a.tetoMaxUsd, portao:a.portao, revisor:a.revisor, revisorDiferente:a.revisorDiferente, aprovaAprendizado:a.aprovaAprendizado, tpl:String(tpl||'') };
}
async function orgRulesRender(host, d){
  const org=d.org, owner=d.meRole==='owner';
  if(ORGR.orgId!==org.id || !ORGR.saved){
    host.innerHTML=(typeof ajSecHead==='function'?ajSecHead('regras',''):'')+skeletonHtml('lista',{ n:5, label:'lendo as regras' });
    try{ const rows=await sbGet('orgs?select=policy,spec_template&id=eq.'+org.id); const r=(rows&&rows[0])||{}; ORGR.saved=r.policy||{}; ORGR.tpl=r.spec_template||''; ORGR.canVersion=true; }
    catch(e){ ORGR.saved=(org.policy||{}); ORGR.tpl=org.spec_template||''; ORGR.canVersion=false; ORGR.err=(typeof cloudErrMsg==='function')?cloudErrMsg(e,'Não consegui ler o histórico'):String(e); }
    ORGR.orgId=org.id; ORGR.draft=orgRulesFlat(ORGR.saved, ORGR.tpl);
  }
  const ver=ajPolicyVersion(ORGR.saved), saved=orgRulesFlat(ORGR.saved, ORGR.tpl), f=ORGR.draft;
  const ownerName=((d.orgMembers||[]).find(m=>m.role==='owner')||{}).user_id;
  const who=ownerName&&typeof ajPName==='function'?ajPName(d, ownerName):'o dono da organização';
  const when=ORGR.saved&&ORGR.saved.savedAt?new Date(ORGR.saved.savedAt).toLocaleDateString('pt-BR',{ day:'2-digit', month:'2-digit' }):'';
  const by=ORGR.saved&&ORGR.saved.savedBy&&typeof ajPName==='function'?ajPName(d, ORGR.saved.savedBy):'';
  const dis=owner?'':' disabled';
  const ck=(k,label,help)=>ajRow(label, help||'', `<input type="checkbox" class="ajchk" data-orgr="${k}"${f[k]?' checked':''}${dis} aria-label="${escA(label)}">`);
  const hist=Array.isArray(ORGR.saved&&ORGR.saved.history)?ORGR.saved.history.slice().reverse():[];
  host.innerHTML=ajSecHead('regras', `Valem para todos os projetos da ${esc(org.name)}. Cada projeto pode apertar em Projeto › Regras, nunca afrouxar. Junta a antiga “Política” (Meu time) e os “Padrões de demanda” (Conta e time).`,
      `<span class="ajtag">versão ${ver}${when?' · '+esc(when):''}${by?' por '+esc(by):''}</span>`)
    +(owner?'':`<div class="ajband">Só leitura. Quem muda estas regras: ${esc(who)}.</div>`)
    +(ORGR.canVersion?'':`<div class="ajband warn">Sem o histórico da nuvem agora (${esc(ORGR.err)}) — salvar grava só a regra, sem versão.</div>`)
    +`<div class="${owner?'':'ajro'}"><h3 class="ajh3">Toda demanda precisa ter</h3><div class="ajrows">`
    +ajRow('Mínimo de requisitos', 'Requisitos verificáveis no plano antes de rodar.', `<input class="in ajnum" type="number" min="1" max="10" data-orgr="minRequirements" value="${escA(String(f.minRequirements))}"${dis} aria-label="mínimo de requisitos">`)
    +ck('proofRequired','Prova real (prints ou vídeo)','Cada requisito com prova antes de entregar.')+ck('testsRequired','Testes comprovando')+ck('docRequired','Documento de arquitetura')
    +ck('portao','Toda tarefa passa pela revisão antes do PR','nenhum PR abre sozinho; a prova é obrigatória (plano Enterprise)')
    +ck('revisor','Toda equipe tem um revisor')+ck('revisorDiferente','O revisor roda em outra IA ou outro modelo','diferente de quem constrói')
    +`</div><h3 class="ajh3">Custo</h3><div class="ajrows">`
    +ajRow('Aviso de custo da organização', '', `<span class="ajmoney"><i>US$</i><input class="in" type="number" min="0" step="1" data-orgr="costWarn" value="${escA(String(f.costWarn))}"${dis}></span>`)
    +ajRow('Teto máximo por tarefa', 'Ninguém libera acima disso. Vazio = sem máximo.', `<span class="ajmoney"><i>US$</i><input class="in" type="text" inputmode="decimal" data-orgr="tetoMaxUsd" value="${f.tetoMaxUsd!=null?escA(String(f.tetoMaxUsd)):''}" placeholder="sem máximo"${dis}></span>`, 'orgrTetoErr')
    +ajRow('Quem aprova aprendizado compartilhado', '', `<select class="in" data-orgr="aprovaAprendizado"${dis}><option value="admins"${f.aprovaAprendizado==='admins'?' selected':''}>um admin da organização</option><option value="membros"${f.aprovaAprendizado==='membros'?' selected':''}>outra pessoa da organização</option></select>`)
    +`</div><h3 class="ajh3">Guia de demanda</h3><textarea class="in ajta mono" data-orgr="tpl" rows="9" placeholder="${escA(typeof DEFAULT_SPEC_TEMPLATE!=='undefined'?DEFAULT_SPEC_TEMPLATE.split('\n').slice(0,4).join('\n'):'')}"${dis} aria-label="guia de demanda">${esc(f.tpl)}</textarea>
      <details class="ajvd"><summary>ver versões anteriores${hist.length?' ('+hist.length+')':''} · ninguém perde a versão anterior</summary>${hist.length?`<div class="ajlist">${hist.map(h=>`<div class="ajli"><div class="l"><b>versão ${esc(String(h.version||'?'))}</b><small>${h.savedAt?esc(new Date(h.savedAt).toLocaleString('pt-BR')):'antes do histórico'}${h.savedBy&&typeof ajPName==='function'?' · '+esc(ajPName(d,h.savedBy)):''} · ${esc(policyRules(orgAgentPolicy(h)).slice(0,2).join(' · '))}</small></div>${owner?`<button type="button" class="btn sm" data-orgrback="${escA(String(h.version))}">voltar pra esta</button>`:''}</div>`).join('')}</div>`:'<p class="dim">ainda não há versão anterior</p>'}</details></div>`
    +(owner?`<div class="ajsavebar" id="orgrBar" hidden><b id="orgrN"></b><span class="dim" id="orgrV"></span><span class="sp"></span><button type="button" class="btn sm" id="orgrDiscard">descartar</button><button type="button" class="btn primary sm" id="orgrSave"></button></div>`:'');
  if(!owner) return;
  const bar=$id('orgrBar');
  const sync=()=>{ const n=ajPolicyDiff(saved, ORGR.draft); bar.hidden=!n; $id('orgrN').textContent=n+(n===1?' mudança não salva':' mudanças não salvas');
    $id('orgrV').textContent=ORGR.canVersion?'em Regras da organização · vira a versão '+(ver+1):'em Regras da organização';
    $id('orgrSave').textContent=ORGR.canVersion?'salvar versão '+(ver+1):'salvar'; };
  host.querySelectorAll('[data-orgr]').forEach(el=>{ const k=el.dataset.orgr; const ev=el.type==='checkbox'||el.tagName==='SELECT'?'change':'input';
    el.addEventListener(ev, ()=>{ let v=el.type==='checkbox'?el.checked:el.value;
      if(k==='minRequirements') v=Math.max(1, Math.min(10, parseInt(v,10)||1)); else if(k==='costWarn') v=Math.max(0, parseFloat(String(v).replace(',','.'))||0);
      else if(k==='tetoMaxUsd'){ const t=String(v).trim().replace(',','.'); const e=$id('orgrTetoErr'); if(t && !(Number(t)>0)){ if(e){ e.textContent='Use um valor em US$ maior que zero (ex.: 5 ou 2,50) — ou deixe vazio pra sem máximo.'; e.hidden=false; } return; } if(e) e.hidden=true; v=t?Math.round(Number(t)*100)/100:null; }
      ORGR.draft[k]=v; sync(); }); });
  bindClick('orgrDiscard', ()=>{ ORGR.draft=orgRulesFlat(ORGR.saved, ORGR.tpl); orgRulesRender(host, d); });
  host.querySelectorAll('[data-orgrback]').forEach(b=>b.onclick=()=>{ const h=(ORGR.saved.history||[]).find(x=>String(x.version)===b.dataset.orgrback); if(!h) return; ORGR.draft=Object.assign(orgRulesFlat(h, ORGR.draft.tpl)); orgRulesRender(host, d); });
  bindClick('orgrSave', async()=>{ const b=$id('orgrSave'); if(b.disabled) return; b.disabled=true;
    const f2=ORGR.draft;
    const patch={ minRequirements:f2.minRequirements, proofRequired:f2.proofRequired, testsRequired:f2.testsRequired, docRequired:f2.docRequired, costWarn:f2.costWarn,
      agentes:orgAgentPolicy({ portao:f2.portao, revisor:f2.revisor, revisorDiferente:f2.revisorDiferente, tetoMaxUsd:f2.tetoMaxUsd, aprovaAprendizado:f2.aprovaAprendizado }) };
    const me=typeof cloudUserId==='function'?cloudUserId():'';
    let pol=ORGR.canVersion?ajPolicyNext(ORGR.saved, patch, me, Date.now()):Object.assign({}, ORGR.saved, patch);
    try{
      try{ await orgWrite('/rest/v1/orgs?id=eq.'+org.id, 'PATCH', { policy:pol, spec_template:f2.tpl.trim()||null }); }
      catch(e){ if(!ORGR.canVersion || /permiss/i.test(String(e&&e.message))) throw e; // versão recusada: grava a regra sem histórico
        const { history, version, savedAt, savedBy, ...plain }=pol; pol=plain; await orgWrite('/rest/v1/orgs?id=eq.'+org.id, 'PATCH', { policy:pol, spec_template:f2.tpl.trim()||null }); ORGR.canVersion=false; }
      ORGR.saved=pol; ORGR.tpl=f2.tpl; ORGR.draft=orgRulesFlat(pol, f2.tpl);
      if(typeof orgDefCache!=='undefined'){ orgDefCache=null; orgDefAt=0; } ORGP.at=0; orgPolGet(true).catch(()=>{});
      orgRulesRender(host, d); if(typeof ajSaved==='function') ajSaved(ORGR.canVersion?'versão '+ajPolicyVersion(pol)+' salva ✓':'salvo ✓');
    }catch(e){ b.disabled=false; toast((typeof cloudErrMsg==='function')?cloudErrMsg(e,'Não consegui salvar as regras'):String(e&&e.message||e),'err'); }
  });
  sync();
}
window.orgRulesRender=orgRulesRender;

// ---------------------------------------------------------------- P17: compartilhar aprendizado por item
function orgShareBtn(kind, key){
  if(!orgCloudOk()) return '';
  return `<button class="btn sm" data-agshare="${escA(kind)}" data-key="${escA(key)}" title="manda este item pro time como pendente — alguém aprova antes de qualquer colega poder trazer pro agente dele">⇡ compartilhar com o time</button>`;
}
// o item que o agente lembra → o que vai pra nuvem (nunca o arquivo inteiro, nunca caminho)
function orgShareItem(card, kind, key){
  const L=(card&&card.learnings)||{};
  if(kind==='skill'){ const s=(L.skills||[]).find(x=>x.name===key); return s?{ kind:'skill', title:s.name, description:s.description||'', body:s.body||'' }:null; }
  const n=(L.notes||[]).find(x=>x.id===key&&!x.forgottenAt); return n?{ kind:'nota', title:n.title||'', description:'', body:n.body||'' }:null;
}
// frase do item do time no mesmo jeito do cartão (37-memoria): "A Nyx vai lembrar: …"
function orgLearnSentence(r){
  const it=r.kind==='skill'?{ kind:'skill', agente:r.agent_id, agenteNome:r.agent_name, skill:{ nome:r.title, descricao:r.description } }:{ kind:'nota', agente:r.agent_id, agenteNome:r.agent_name, nota:{ title:r.title } };
  return typeof memLearnSentence==='function'?memLearnSentence(it):r.title;
}
async function orgTeamLoad(agentId){
  if(!orgCloudOk()){ ORGL.id=agentId; ORGL.rows=null; return; }
  const org=orgCur(); ORGL.id=agentId; ORGL.err='';
  try{
    const rows=await sbGet('org_learnings?select=*&org_id=eq.'+org.id+'&agent_id=eq.'+encodeURIComponent(agentId)+'&order=created_at.desc&limit=50');
    // recusados: só quem compartilhou vê (com o motivo) — e pode compartilhar de novo
    if(ORGL.id===agentId) ORGL.rows=(rows||[]).filter(r=>r.status!=='recusado' || r.shared_by===orgMe());
  }catch(e){ if(ORGL.id===agentId){ ORGL.rows=[]; ORGL.err=(typeof cloudErrMsg==='function')?cloudErrMsg(e,'Não consegui ler o que o time compartilhou'):String(e&&e.message||e); } }
}
function orgTeamLearnHtml(a){
  if(!orgCloudOk() || ORGL.id!==a.id) return '';
  if(ORGL.rows==null) return `<section class="agf-sec"><h3 class="agf-h3">Do time</h3><p class="dim">lendo o que o time compartilhou…</p></section>`;
  const p=ORGP.pol||orgAgentPolicy({}), me=orgMe(), role=(typeof cloudData!=='undefined'&&cloudData)?cloudData.meRole:'';
  const pend=ORGL.rows.filter(r=>r.status==='pendente'), ok=ORGL.rows.filter(r=>r.status==='aprovado'), no=ORGL.rows.filter(r=>r.status==='recusado');
  const by=r=>r.shared_by===me?'você':(r.shared_by_name||'alguém do time');
  const li=r=>{
    let acts='';
    if(r.status==='pendente'){
      if(canDecideLearning(p, role, me, r.shared_by)) acts=`<button class="btn sm primary" data-orgdec="aprovado" data-oid="${escA(r.id)}">aprovar pro time</button><button class="btn sm" data-orgdec="recusado" data-oid="${escA(r.id)}">recusar</button>`;
      else acts=`<span class="dim">esperando a aprovação de ${esc(approverWords(p))}</span>`+(r.shared_by===me?`<button class="btn sm" data-orgundo="${escA(r.id)}">desfazer</button>`:'');
    } else if(r.status==='recusado') acts=`<span class="dim">o time recusou${r.reason?': '+esc(r.reason):''}</span><button class="btn sm" data-orgundo="${escA(r.id)}">tirar da lista</button>`;
    else acts=`<button class="btn sm primary" data-orgimp="${escA(r.id)}">trazer pra ${esc(a.name||'ele')}</button>`;
    return `<li class="agf-li"><p class="agf-ls">${esc(orgLearnSentence(r))}</p><p class="dim agorg-by">compartilhado por ${esc(by(r))}${r.status==='aprovado'?' · aprovado pelo time':''}</p>
      <div class="agf-la">${acts}</div><details class="agf-det"><summary>ver detalhes</summary>${r.description?`<p>${esc(r.description)}</p>`:''}<pre class="memlbody">${esc(r.body||'')}</pre></details></li>`;
  };
  const body=(ORGL.err?`<p class="agf-err">${esc(ORGL.err)}</p>`:'')+(pend.length||ok.length
    ?`${ok.length?`<ul class="agf-list">${ok.map(li).join('')}</ul>`:''}${pend.length?`<h4 class="agorg-h4">Esperando aprovação</h4><ul class="agf-list">${pend.map(li).join('')}</ul>`:''}${no.length?`<h4 class="agorg-h4">Recusados (só você vê)</h4><ul class="agf-list">${no.map(li).join('')}</ul>`:''}`
    :no.length?`<h4 class="agorg-h4">Recusados (só você vê)</h4><ul class="agf-list">${no.map(li).join('')}</ul>`:`<p class="agf-empty">Ninguém do time compartilhou nada pra ${esc(a.name||'esse agente')} ainda. Trazer um item do time põe ele em "Pra você decidir" — só entra com o seu sim.</p>`);
  return `<section class="agf-sec agorg"><h3 class="agf-h3">Do time</h3>${body}</section>`;
}
function orgTeamWire(host, a, after){
  const repo=state.repo||'';
  host.querySelectorAll('[data-agshare]').forEach(b=>b.onclick=async()=>{
    const it=orgShareItem(AGF.card, b.dataset.agshare, b.dataset.key); if(!it) return;
    const text=[it.title, it.description, it.body].join('\n');
    let why=null; try{ why=await invoke('learn_check_text',{ text }); }catch(_){ why=null; }
    if(why){ toast(why==='segredo'?'Não compartilhei: parece conter um segredo (chave, senha ou valor de .env). Edite o item antes.':'Não compartilhei: parece conter instruções pro agente (injeção).','warn'); return; }
    const p=ORGP.pol||await orgPolGet()||orgAgentPolicy({});
    const names=shareNames(text, [a.name, a.id]);
    const sent=orgLearnSentence({ kind:it.kind, agent_id:a.id, agent_name:a.name, title:it.title, description:it.description });
    if(!await askYes('Compartilhar com o time?\n\n“'+sent+'”\n\nEntra como pendente: '+approverWords(p)+' aprova antes. Depois, cada colega decide se traz pro agente dele — nada é aplicado sozinho em ninguém.'+(names.length?'\n\nConfira antes — pode ter nome de cliente ou dado de fora: '+names.join(', ')+'.':''))) return;
    b.disabled=true;
    try{
      const org=orgCur(), me=orgMe(), prof=(cloudData&&cloudData.profileByUser&&cloudData.profileByUser[me])||{};
      await sbPost('org_learnings', { org_id:org.id, agent_id:a.id, agent_name:String(a.name||'').slice(0,80), kind:it.kind, title:it.title.slice(0,160), description:(it.description||'').slice(0,600), body:(it.body||'').slice(0,8000), shared_by_name:String(prof.name||prof.email||'').slice(0,120) });
      toast('Compartilhado com o time — esperando a aprovação de '+approverWords(p)+'.','ok');
      await orgTeamLoad(a.id); after();
    }catch(e){ const raw=String(e&&e.message||e); toast(/duplicate|unique|23505|409/i.test(raw)?'Esse item já foi compartilhado com o time.':((typeof cloudErrMsg==='function')?cloudErrMsg(e,'Não consegui compartilhar'):raw),'warn'); b.disabled=false; }
  });
  host.querySelectorAll('[data-orgdec]').forEach(b=>b.onclick=async()=>{
    const st=b.dataset.orgdec, id=b.dataset.oid, org=orgCur(); let reason=null;
    const row=(ORGL.rows||[]).find(x=>x.id===id);
    if(st==='aprovado' && !await askYes('Aprovar pro time?\n\n“'+(row?orgLearnSentence(row):'')+'”\n\nDepois de aprovado, qualquer pessoa da organização pode trazer pro agente dela (cada uma decide no próprio projeto). A decisão não volta atrás.')) return;
    if(st==='recusado'){ reason=typeof askText==='function'?await askText('Por que recusar? (vai junto, pra quem compartilhou)','ex.: vale só pro projeto dela',''):''; if(reason===null) return; }
    b.disabled=true;
    try{ await orgWrite('/rest/v1/org_learnings?org_id=eq.'+org.id+'&id=eq.'+encodeURIComponent(id), 'PATCH', { status:st, reason:reason||null });
      toast(st==='aprovado'?'Aprovado — o time já pode trazer pros agentes.':'Recusado.','ok'); await orgTeamLoad(a.id); after(); }
    catch(e){ showErr(e, 'Não consegui decidir'); b.disabled=false; }
  });
  host.querySelectorAll('[data-orgundo]').forEach(b=>b.onclick=async()=>{
    const org=orgCur(); b.disabled=true;
    try{ await orgWrite('/rest/v1/org_learnings?org_id=eq.'+org.id+'&id=eq.'+encodeURIComponent(b.dataset.orgundo), 'DELETE'); await orgTeamLoad(a.id); after(); }
    catch(e){ showErr(e, 'Não consegui desfazer'); b.disabled=false; }
  });
  host.querySelectorAll('[data-orgimp]').forEach(b=>b.onclick=async()=>{
    const r=(ORGL.rows||[]).find(x=>x.id===b.dataset.orgimp); if(!r) return;
    const item={ id:'time-'+r.id, kind:r.kind, taskId:'', taskTitle:'compartilhado pelo time'+(r.shared_by_name?' por '+r.shared_by_name:''), agente:a.id, papel:a.role||'', agenteNome:a.name||'', origem:'time',
      ...(r.kind==='skill'?{ skill:{ acao:'criar', nome:r.title, descricao:r.description||'', corpo:r.body||'', porque:'compartilhado pelo time' } }:{ nota:{ title:r.title, type:'regra', tags:[], body:r.body||'' } }) };
    b.disabled=true;
    try{ const res=await invoke('learn_import',{ repo, item });
      toast(res&&res.already?'Esse item já está na sua fila (ou você já decidiu sobre ele).':'Está em "Pra você decidir" — entra só com o seu sim.','ok'); await after(true); }
    catch(e){ showErr(e, 'Não consegui trazer'); b.disabled=false; }
  });
}

// ---------------------------------------------------------------- P15: testar numa amostra (só o revisor)
async function sampleLoad(repo, agentId){
  SMP.id=agentId; SMP.repo=repo;
  try{ const l=await invoke('agent_samples',{ repo, agentId }); if(SMP.id===agentId && SMP.repo===repo) SMP.list=Array.isArray(l)?l:[]; }catch(_){ if(SMP.id===agentId && SMP.repo===repo) SMP.list=[]; }
}
function sampleSectionHtml(a){
  if(a.role!=='reviewer') return '';
  const rows=(typeof agRowsOf==='function')?agRowsOf(a.id):[];
  const cand=sampleCandidates(rows, a.id, 8);
  const cur=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
  const vtx=cur!=null?'a v'+cur:'a versão atual';
  const est=sampleEstimate(rows, a.id);
  if(SMP.id===a.id && SMP.sel && !cand.some(c=>c.taskId===SMP.sel)) SMP.sel='';
  const sel=SMP.sel||(cand[0]&&cand[0].taskId)||'';
  const run=SMP.runRepo===(state.repo||'')?SMP.running:''; // amostra de outro projeto não aparece aqui
  const pick=cand.length?`<div class="agsmp-pick"><label for="agSmpSel">Tarefa</label><select class="sel" id="agSmpSel"${run?' disabled':''}>${cand.map(c=>`<option value="${escA(c.taskId)}"${c.taskId===sel?' selected':''}>${esc(c.title)}${c.v!=null?' · revisada na v'+c.v:''}</option>`).join('')}</select>
      <button class="btn sm primary" id="agSmpRun"${run?' disabled':''}>${run?'testando…':'testar '+esc(vtx)+' nesta tarefa'}</button></div>
      <p class="dim agsmp-cost">custo estimado <b>${esc(est.text)}</b> · teto ${esc(polUsd(est.cap))} — se o custo informado passar disso, a amostra para e o resultado diz</p>
      ${run?`<p class="agsmp-run" role="status">testando na tarefa "${esc((cand.find(c=>c.taskId===run)||{}).title||run)}" — a revisão leva alguns minutos; pode sair daqui, o resultado fica guardado.</p>`:''}`
    :`<p class="agf-empty">${esc(a.name||'Esse agente')} ainda não revisou nenhuma tarefa deste projeto — a amostra precisa de uma tarefa que ele já revisou.</p>`;
  const list=SMP.id===a.id&&SMP.repo===(state.repo||'')?(SMP.list||[]):[];
  const res=list.length?`<ul class="agsmp-l">${list.slice(0,8).map(r=>`<li><p class="agf-ls"><b>${esc(r.title||r.taskId)}</b> — ${r.old&&r.old.v!=null?'na v'+esc(r.old.v):'antes'}: ${esc(sampleVerdictText(r.old))} · na v${esc(r.now&&r.now.v!=null?r.now.v:'?')}: ${esc(sampleVerdictText(r.now))}</p>
      <p class="dim">${esc(sampleCompareText(r))} · ${esc(polUsd(r.usd))}${r.stopped?' · parou no teto':''} · ${esc(new Date(+r.at||0).toLocaleDateString('pt-BR'))}</p>
      <details class="agf-det"><summary>ver detalhes</summary>${['old','now'].map(k=>{ const v=r[k]||{}; return `<p><b>${k==='old'?'antes':'agora'}</b>: ${esc(sampleVerdictText(v))}</p>${(v.items||[]).length?`<ul>${v.items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}`; }).join('')}</details></li>`).join('')}</ul>`:'';
  return `<section class="agf-sec agsmp"><h3 class="agf-h3">Testar numa amostra</h3>
    <p class="dim">Roda só a revisão ${esc(cur!=null?'da v'+cur:'da versão atual')} numa tarefa que ${esc(a.name||'ele')} já revisou, numa cópia descartável da branch. A tarefa original não muda, e o veredito de antes aparece ao lado do de agora.</p>${pick}${res}</section>`;
}
function sampleWire(host, a, rerender){
  const s=host.querySelector('#agSmpSel'); if(s) s.onchange=()=>{ SMP.sel=s.value; };
  const b=host.querySelector('#agSmpRun'); if(!b) return;
  b.onclick=async()=>{
    if(SMP.running) return;
    const repo=state.repo||'', rows=(typeof agRowsOf==='function')?agRowsOf(a.id):[];
    const cand=sampleCandidates(rows, a.id, 8), taskId=(s&&s.value)||(cand[0]&&cand[0].taskId); if(!taskId) return;
    const c=cand.find(x=>x.taskId===taskId)||{ title:taskId };
    const est=sampleEstimate(rows, a.id);
    const cur=AGF.card&&AGF.card.versions?AGF.card.versions.current:null;
    if(!await askYes('Testar '+(a.name||'o revisor')+(cur!=null?' v'+cur:'')+' na tarefa "'+c.title+'"?\n\nRoda só a revisão, numa cópia descartável da branch. A tarefa original não muda.\n\nCusto estimado: '+est.text+'\nTeto: '+polUsd(est.cap)+' — para se passar disso.')) return;
    SMP.running=taskId; SMP.runRepo=repo; SMP.sel=taskId; rerender();
    try{
      const r=await invoke('agent_sample_review',{ repo, taskId, agentId:a.id, capUsd:est.cap });
      if(SMP.id===a.id && SMP.repo===repo && r) SMP.list=[r, ...(SMP.list||[]).filter(x=>x.at!==r.at)];
      toast('Amostra pronta: '+sampleCompareText(r)+'.','ok');
    }catch(e){ showErr(e, 'Não consegui testar na amostra'); }
    finally{ SMP.running=''; if(typeof agVisible==='function' && agVisible() && AGF.id===a.id) rerender(); }
  };
}
