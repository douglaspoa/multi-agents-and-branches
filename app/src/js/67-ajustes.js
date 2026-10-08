// Starfork — 67-ajustes: AJUSTES (ex-Configurações + ex-"Conta e time" + ex-Ambiente), PRIMEIROS PASSOS (ex-tour de 5
// passos + coach marks) e a aba DETALHES DO ERRO. Redesenho F4 · G3 (mock _bmad-output/redesign/telas/g3-ajustes-conta.html).
// - Ajustes é UMA aba (kind 'cfg', título "Ajustes") com busca, sub-navegação em 3 grupos e o selo de escopo trocando a
//   cada seção. Salva sozinho com "salvo ✓" inline; só "Regras da organização" tem salvar explícito (cria versão).
//   Nada fecha a aba. As abas antigas 'conta' e 'env' viram seções daqui (ajRoute).
// - O que vale só pra um projeto mora em Projeto (Regras, Espaço em disco, Agentes); a busca acha e leva.
// API pública: ajustesOpen(section?) · primeirosPassosOpen() · errTabOpen(h). Seções: ver AJ_SECTIONS (+ AJ_ALIAS).

// @ajustes-puro-inicio (testado em app/tests/redesign-f4-g3.test.mjs — sem DOM)
const AJ_GROUPS=[['ia','IA e modelos'],['pc','Este computador'],['conta','Conta e time']];
const AJ_SECTIONS=[
  { id:'motores', grp:'ia', label:'Motores e chaves', scope:'computador', kw:'ia claude code codex deepseek gemini opencode gateway ia da sua empresa chave api openai lgcx outras chaves modelo padrão testar privacidade medidor porcentagem plano seletor' },
  { id:'custo', grp:'pc', label:'Custo e limites', scope:'computador', kw:'teto tarefa aviso custo cotação dólar real tarefas ao mesmo tempo paralelo fila retomar limite' },
  { id:'modo', grp:'pc', label:'Como as tarefas rodam', scope:'computador', kw:'modo terminal automático aprovação navegador dos agentes janela previsão tempo custo antes de rodar' },
  { id:'aparencia', grp:'pc', label:'Aparência', scope:'computador', kw:'tema claro escuro sistema cor' },
  { id:'aprendizado', grp:'pc', label:'Aprendizado', scope:'computador', kw:'aprendizado contínuo retro revisão memória sugerir automático desligado' },
  { id:'github', grp:'pc', label:'GitHub', scope:'computador', kw:'github conta gh pr push envio sso trocar entrar' },
  { id:'verificacao', grp:'pc', label:'Verificação', scope:'computador', kw:'verificação ambiente git node github cli túnel prévia simulador ios emulador android maestro pesquisa ampliada instalar pendência' },
  { id:'notificacoes', grp:'pc', label:'Notificações', scope:'computador', kw:'notificações avisos macos sistema' },
  { id:'versao', grp:'pc', label:'Versão', scope:'computador', kw:'versão atualizar atualização build publicar release canal' },
  { id:'disco', grp:'pc', label:'Disco', scope:'computador', kw:'disco espaço pasta de trabalho limpar liberar cópias entregáveis' },
  { id:'sistema', grp:'pc', label:'Sistema', scope:'computador', kw:'sistema primeiros passos tour atalhos teclado servidor da conta avançado' },
  { id:'perfil', grp:'conta', label:'Perfil e segurança', scope:'conta', kw:'perfil nome e-mail email senha trocar sair conta' },
  { id:'org', grp:'conta', label:'Organização', scope:'org', kw:'organização plano enterprise assentos licença papel dono visão' },
  { id:'times', grp:'conta', label:'Times e pessoas', scope:'org', kw:'times pessoas membros lead adicionar remover novo time renomear organização criar' },
  { id:'convites', grp:'conta', label:'Convites', scope:'org', kw:'convites convidar e-mail token pendentes revogar copiar mensagem' },
  { id:'regras', grp:'conta', label:'Regras da organização', scope:'org', kw:'regras política padrões de demanda requisitos prova testes documento arquitetura teto máximo guia versão revisor portão' },
  { id:'assinatura', grp:'conta', label:'Assinatura e plano', scope:'org', kw:'assinatura plano pagamento cartão portal stripe gerenciar' },
];
// o que mudou de lugar (fora de Ajustes): a busca acha e leva
const AJ_ELSEWHERE=[
  { label:'Endereço base das issues', where:'Issues › Conexão', go:'issues', kw:'issues link código linear jira endereço base' },
  { label:'Limpar o espaço de um projeto', where:'Projeto › Espaço em disco', go:'projeto-disco', kw:'disco limpar liberar cópias de trabalho entregáveis' },
  { label:'Protegido ou livre, preferências do projeto', where:'Projeto › Regras', go:'projeto-regras', kw:'protegido livre preferências do projeto regras proteção' },
  { label:'Agentes e equipes da organização', where:'Projeto › Agentes › Equipes', go:'projeto-agentes', kw:'agentes equipes catálogo aplicar enviar compartilhar' },
  { label:'Visão da organização', where:'Time › Visão geral', go:'time', kw:'visão organização tarefas custo por time' },
];
const AJ_ALIAS={ conta:'perfil', ia:'motores', suaia:'motores', gateway:'motores', chaves:'motores', env:'verificacao', ambiente:'verificacao',
  execucao:'custo', navegador:'modo', previsao:'modo', politica:'regras', padroes:'regras', tema:'aparencia', time:'times', pessoas:'times', plano:'assinatura' };
function ajNorm(s){ return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim(); }
function ajSecId(s){ const k=String(s||'').trim(); const id=AJ_ALIAS[k]||k; return AJ_SECTIONS.some(x=>x.id===id)?id:'motores'; }
function ajSec(id){ return AJ_SECTIONS.find(x=>x.id===id)||AJ_SECTIONS[0]; }
// busca: todas as palavras precisam aparecer (rótulo, grupo ou palavras-chave). Vazio = tudo, sem "também em".
function ajSearch(q){
  const words=ajNorm(q).split(' ').filter(Boolean);
  if(!words.length) return { sections:AJ_SECTIONS.map(s=>s.id), elsewhere:[] };
  // cada palavra casa com o COMEÇO de uma palavra ("tema" acha Aparência, não "Sis-tema")
  const hit=txt=>{ const t=ajNorm(txt).split(/[^a-z0-9]+/).filter(Boolean); return words.every(w=>t.some(x=>x.startsWith(w))); };
  const grpName=g=>(AJ_GROUPS.find(x=>x[0]===g)||[])[1]||'';
  return { sections:AJ_SECTIONS.filter(s=>hit(s.label+' '+grpName(s.grp)+' '+s.kw)).map(s=>s.id),
    elsewhere:AJ_ELSEWHERE.filter(e=>hit(e.label+' '+e.where+' '+e.kw)) };
}
// rota das abas antigas: 'conta' (Conta e time) e 'env' (Ambiente) abrem Ajustes na seção certa
function ajRoute(kind, opts){
  if(kind==='conta') return { kind:'cfg', section:'perfil' };
  if(kind==='env') return { kind:'cfg', section:'verificacao' };
  if(kind==='cfg') return { kind:'cfg', section:(opts&&opts.section)?ajSecId(opts.section):null };
  return null;
}
// selo do cabeçalho: muda a cada seção (computador · sua conta · organização <nome>)
function ajScope(id, orgName){ const s=ajSec(id); return s.scope==='org' ? { scope:'org', scopeLabel:orgName||'' } : { scope:s.scope }; }
// @puro-inicio cfgValidate — valores do formulário (texto dos inputs) → null (ok) ou { field, msg } do 1º problema
function cfgValidate(v){
  const num=x=>String(x==null?'':x).trim()===''?NaN:Number(String(x).replace(',','.'));
  const n={ cap:num(v.cap), cost:num(v.cost), brl:num(v.brl), slots:num(v.slots), retry:num(v.retry) };
  if(!(n.cap>0)) return { field:'cfgCap', msg:'Use um valor maior que 0: o teto fica sempre ligado (a tarefa pausa a 80% dele e pergunta).' };
  if(!(n.cost>=0)) return { field:'cfgCost', msg:'O aviso de custo precisa ser um número maior ou igual a 0 (0 desliga).' };
  if(!(n.brl>0)) return { field:'cfgBrl', msg:'A cotação do dólar precisa ser maior que zero.' };
  if(!(Number.isInteger(n.slots) && n.slots>=1 && n.slots<=12)) return { field:'cfgSlots', msg:'Tarefas ao mesmo tempo: um número inteiro de 1 a 12.' };
  if(!(Number.isInteger(n.retry) && n.retry>=0 && n.retry<=240)) return { field:'cfgLimitRetry', msg:'Retomar depois do limite: de 0 a 240 minutos (0 desliga).' };
  return null;
}
// @puro-fim cfgValidate
// modo das tarefas na tela — espelha term.rs mode_default: terminal é o padrão; "auto" só vale se escolhido na tela nova
// (taskModeSet=2). Na tela antiga "Automático (padrão)" era gravado junto com o resto, sem ser escolha.
function cfgTaskModeOf(o){ return (o && String(o.taskModeSet)==='2' && o.taskMode==='auto') ? 'auto' : 'terminal'; }
// grava quando mudou, ou quando você escolhe Terminal e ele ainda não estava gravado (é o que liga o Codex no terminal)
function cfgTaskModeShouldSave(val, loaded, stored){ if(loaded===undefined) return false; return val!==loaded || (val==='terminal' && stored!=='terminal'); }
// modelos da retro (aprendizado contínuo) — uma lista só; valor do settings.json fora dela vira opção (não é trocado no salvar)
const RETRO_MODELS=[['claude-sonnet-5','Sonnet 5 (padrão)'],['claude-haiku-4-5-20251001','Haiku 4.5 (mais barato)']];
function retroModelSelect(sel, v){
  v=String(v==null?'':v).trim(); if(!v) return;
  if(![...sel.options].some(x=>x.value===v)){ const o=document.createElement('option'); o.value=v; o.textContent=v+' (personalizado)'; sel.appendChild(o); }
  sel.value=v;
}
// papel e plano em português (nada de owner/admin/member/enterprise cru na tela)
const AJ_ROLE={ owner:'dono', admin:'admin', member:'membro', lead:'lead' };
function ajRolePt(r){ return AJ_ROLE[r]||String(r||'membro'); }
const AJ_PLAN={ enterprise:'Enterprise', team:'Time', individual:'Solo', trial:'Avaliação', free:'Grátis' };
function ajPlanPt(p){ return AJ_PLAN[p]||(p?String(p).charAt(0).toUpperCase()+String(p).slice(1):'—'); }
// assinatura: org enterprise (ou liberada pelo admin) NUNCA vira "Individual · mensal … renova em " (bug do inventário)
// off = cobrança desligada no servidor: sem assinatura não é "inativo", é livre (e não há plano pra escolher)
function ajBillingLine(b, me, dt, off){
  dt=dt||(s=>s?new Date(s).toLocaleDateString('pt-BR'):'');
  if(off==='unknown' && !b) return { name:'Não consegui ler a assinatura', sub:'Tente de novo em instantes — o app segue funcionando.', active:false, unknown:true, mine:false };
  if(off===true && !(b && (b.org || ['trialing','active'].includes(b.status)))) return { name:'Uso livre', sub:'A cobrança ainda não está ligada — o app segue livre, sem plano pra escolher.', active:true, free:true, mine:false };
  if(!b) return { name:'Sem assinatura ativa', sub:'Escolha um plano pra seguir usando com o time.', active:false, mine:false };
  if(b.org) return { name:ajPlanPt(b.plan||'enterprise'), sub:'pago pela organização, por contrato — não renova por aqui', active:true, mine:false, org:true };
  if(!['trialing','active'].includes(b.status)) return { name:'Sem assinatura ativa', sub:'A última assinatura não está mais ativa.', active:false, mine:b.user_id===me };
  const nome=b.plan==='team'?'Time':b.plan==='enterprise'?'Enterprise':'Solo';
  const parts=[b.interval==='year'?'anual':'mensal'];
  if(b.status==='trialing' && b.trial_end) parts.push('teste grátis até '+dt(b.trial_end));
  else if(b.current_period_end) parts.push('renova em '+dt(b.current_period_end));
  parts.push(b.user_id===me?'você paga':'pago por outra pessoa do time');
  if(b.cancel_at_period_end) parts.push('cancela no fim do período');
  return { name:nome, sub:parts.join(' · '), active:true, mine:b.user_id===me };
}
// convite: sem times não há select vazio — estado guiado "crie um time antes"
function ajInviteState(canInvite, teams){ if(!canInvite) return 'none'; return (teams&&teams.length)?'form':'noteams'; }
// Regras da organização com versão: o histórico mora no próprio orgs.policy (sem tabela nova); máximo 20 versões
const AJ_POL_KEEP=20;
function ajPolicyVersion(p){ const v=Number(p&&p.version); return Number.isInteger(v)&&v>0?v:1; }
function ajPolicyNext(cur, patch, who, now){
  cur=(cur&&typeof cur==='object')?cur:{};
  const { history:_h, version:_v, savedAt:_s, savedBy:_b, ...snap }=cur;
  const hist=Array.isArray(cur.history)?cur.history.slice(-(AJ_POL_KEEP-1)):[];
  const had=Object.keys(snap).length>0;
  const next=Object.assign({}, snap, patch, { version:had?ajPolicyVersion(cur)+1:1, savedAt:now, savedBy:who||'' });
  next.history=had?hist.concat([Object.assign({}, snap, { version:ajPolicyVersion(cur), savedAt:cur.savedAt||null, savedBy:cur.savedBy||'' })]):hist;
  return next;
}
// diferença entre o salvo e o formulário (quantas mudanças não salvas)
function ajPolicyDiff(a, b){ const keys=new Set([...Object.keys(a||{}), ...Object.keys(b||{})]); let n=0; keys.forEach(k=>{ if(JSON.stringify((a||{})[k])!==JSON.stringify((b||{})[k])) n++; }); return n; }
// Primeiros passos: 5 passos (computador → IA → projeto → 1ª demanda → convite); cada um se marca sozinho
function ppSteps(c){
  c=c||{};
  const L=[
    { id:'pc', t:'Este computador está pronto', d:'git, Node e o que as tarefas precisam', done:c.envOk===true },
    { id:'ia', t:'Escolher a IA', d:'quem faz o trabalho nas suas demandas', done:!!c.iaReady },
    { id:'proj', t:'Abrir um projeto', d:'uma pasta com git, ou um projeto novo na Fábrica', done:!!c.hasRepo },
    { id:'dem', t:'Fazer a primeira demanda', d:'descreva em 1 ou 2 frases e converse com o planejador', done:(c.tasks||0)>0 },
  ];
  // convite: opcional e só pra quem está numa organização — nunca conta no progresso ("N de 4 feitos")
  if(c.inOrg) L.push({ id:'conv', t:'Convidar o time', d:'quem ainda não tem conta entra pelo convite', done:!!c.invited, opt:true });
  const req=L.filter(s=>!s.opt);
  const next=req.find(s=>!s.done) || null;
  return { steps:L, done:req.filter(s=>s.done).length, total:req.length, next:next&&next.id };
}
// @ajustes-puro-fim

// @atrap-conta-puro-inicio (testado em app/tests/atrap-conta.test.mjs — sem DOM)
// Primeiros passos › "Este computador": SÓ o computador. As IAs (Motor de IA, Claude Code, Codex, DeepSeek, gateway)
// são o passo 2 — antes o passo 1 só ficava verde com a IA instalada e listava o mesmo comando duas vezes.
const PP_AI_RE=/motor de ia|claude|codex|deepseek|gateway/i;
function ppPcList(list){ return (Array.isArray(list)?list:[]).filter(c=>!PP_AI_RE.test(String((c&&c.name)||''))); }
// o que falta, sem repetir comando, com a etiqueta (opcional/recomendado) da Verificação; obrigatório primeiro
function ppPcItems(list, kindOf){
  const seen=new Set(), out=[];
  for(const c of ppPcList(list)){ if(c.ok) continue;
    const k=kindOf?kindOf(c):'req';
    const fix=String(c.fix||'').split('\n').map(x=>x.trim()).filter(Boolean)[0]||'';
    if(fix && seen.has(fix)) continue; if(fix) seen.add(fix);
    out.push({ name:String(c.name||'').replace(/\s*\((opcional|recomendado)[^)]*\)/i,''), kind:k, fix, c }); }
  return out.sort((a,b)=>(a.kind==='req'?0:1)-(b.kind==='req'?0:1));
}
// abre sozinho no boot só se a pessoa ainda está na Central (não troca a aba que ela abriu)
function ppAutoOk(activeTab){ return !activeTab || activeTab==='flow'; }
// criar organização: os dois nomes são obrigatórios (antes criava "Minha organização"/"Time 1" calado)
function ajOrgFormErr(org, team){
  if(!String(org||'').trim()) return { field:'sbOrgName', msg:'Dê um nome pra organização (ex.: o nome da empresa).' };
  if(!String(team||'').trim()) return { field:'sbTeamName', msg:'Dê um nome pro primeiro time (ex.: Produto).' };
  return null;
}
// o convite recém-gravado: a linha devolvida, ou a da lista relida (o servidor pode gravar sem devolver a linha)
// Só vale o convite AINDA VÁLIDO desse e-mail NESSE time; a lista vem order=expires_at.desc → o 1º é o mais novo.
function ajInvRow(rows, mail, teamId, now){
  const m=String(mail||'').toLowerCase(); now=now||Date.now();
  return (Array.isArray(rows)?rows:[]).find(x=>x && x.token && String(x.email||'').toLowerCase()===m && (!teamId || x.team_id===teamId)
    && !x.accepted_at && (!x.expires_at || new Date(x.expires_at).getTime()>now))||null;
}
// quem já está numa organização não aceita convite de outra por aqui (a RPC accept_invite não checa — ver ajAcceptInvite)
function ajOtherOrgMsg(orgName){ return 'Você já está em '+orgName+'. Pra entrar noutra organização, fale com o admin dela ou saia desta primeiro.'; }
// @atrap-conta-puro-fim
// erro ao criar a organização: sem org não existe "lead do time" — a mensagem de permissão genérica não serve aqui
function ajOrgCreateErr(e){
  const m=cloudErrMsg(e,'Não consegui criar a organização');
  return /não tem permissão/i.test(m) ? 'Não consegui criar a organização: o servidor recusou a permissão desta conta. Saia e entre de novo; se continuar, fale com o suporte do Starfork.' : m;
}
// aceitar convite pelo código — SÓ sem organização (cartão "Entrar num time").
// TODO(migration futura): a correção definitiva é a RPC accept_invite RECUSAR convite de outra org quando a pessoa já
// é membro de uma (hoje ela aceita e a pessoa fica em DUAS orgs; o cloudLoad pega orgs[0] ao acaso). Até lá, a tela
// não oferece o aceite com organização e, se a resposta vier de outra org, não troca o time atual e avisa.
async function ajAcceptInvite(b, tok, er, inp){
  if(b && b.disabled) return;
  if(!tok){ if(er){ er.textContent='Cole o código do convite (ou peça um convite pro seu e-mail — aí você entra sozinho).'; er.hidden=false; } if(inp) inp.focus(); return; }
  if(b){ b.disabled=true; b.textContent='entrando…'; } // duplo clique não manda 2 pedidos
  const cur=(cloudData&&cloudData.org)||null;
  try{ const j=await sbRpc('accept_invite',{ p_token:tok }); if(!j || !j.ok) throw new Error((j&&j.error)||'convite inválido ou expirado');
    if(cur && j.org_id && j.org_id!==cur.id){ cloudMsg=ajOtherOrgMsg(cur.name)+' O convite foi registrado, mas o seu time atual não mudou.'; }
    else { lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ você entrou no time'; } }
  catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui aceitar o convite'); }
  ajSectionPaint();
}

// ============================================================ estado + abertura
const AJ={ sec:'motores', q:'', saved:{}, polDraft:null, polSaved:null, polErr:'', memQ:'' };
function ajIcon(k){
  const P={
    motores:'<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 1.5v1.5M10 1.5v1.5M6 13v1.5M10 13v1.5M1.5 6h1.5M1.5 10h1.5M13 6h1.5M13 10h1.5"/>',
    custo:'<rect x="2" y="4" width="12" height="8" rx="1.5"/><circle cx="8" cy="8" r="1.8"/>',
    modo:'<circle cx="8" cy="8" r="5.6"/><path d="M6.6 5.6l4 2.4-4 2.4z" stroke-linejoin="round"/>',
    aparencia:'<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2" /><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/>',
    aprendizado:'<path d="M2 6l6-3 6 3-6 3z" stroke-linejoin="round"/><path d="M4.5 7.3v3c1 .9 2.2 1.3 3.5 1.3s2.5-.4 3.5-1.3v-3"/>',
    github:'<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-6 1.5-6 3"/>',
    verificacao:'<path d="M3 8.5l3 3 7-7" stroke-linejoin="round"/>',
    notificacoes:'<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" stroke-linejoin="round"/><path d="M6.8 14h2.4"/>',
    versao:'<path d="M8 2.5v8m0 0L5.2 7.7M8 10.5l2.8-2.8"/><path d="M3 13.5h10"/>',
    disco:'<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
    sistema:'<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4"/>',
    perfil:'<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 14c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4"/>',
    org:'<rect x="3" y="2.5" width="10" height="11" rx="1"/><path d="M6 5.5h1M9 5.5h1M6 8h1M9 8h1M7 13.5v-2.5h2v2.5"/>',
    times:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9"/>',
    convites:'<rect x="2" y="3.5" width="12" height="9" rx="1.2"/><path d="M2.5 4.5l5.5 4 5.5-4"/>',
    regras:'<path d="M4 2.5h6L12.5 5v8.5H4z" stroke-linejoin="round"/><path d="M6 7h4.4M6 9.3h4.4M6 11.5h2.6"/>',
    assinatura:'<rect x="2" y="4" width="12" height="8.5" rx="1.4"/><path d="M2 7h12M4.5 10h2.5"/>',
    busca:'<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>',
    ok:'<path d="M3.5 8.5l3 3 6-6.5" stroke-linejoin="round"/>',
    warn:'<path d="M8 2.5l6 11H2z" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.05"/>',
    ir:'<path d="M6 3.5L10.5 8 6 12.5" stroke-linejoin="round"/>',
    flag:'<path d="M4 14V2.5M4 3h8l-1.6 2.7L12 8.4H4"/>',
  };
  return '<svg class="ajic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">'+(P[k]||'')+'</svg>';
}
// título da aba = título da página; as abas novas (Primeiros passos, Detalhes do erro) entram no motor de abas
(function ajRegisterTabs(){
  try{
    if(typeof VIEW_META!=='undefined'){
      if(VIEW_META.cfg) VIEW_META.cfg.title='Ajustes';
      VIEW_META.primeiros={ title:'Primeiros passos', icon:'<path d="M4 14V2.5M4 3h8l-1.6 2.7L12 8.4H4" stroke-linejoin="round"/>' };
      VIEW_META.errtab={ title:'Detalhes do erro', icon:'<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2v3.4M8 10.6v.05" stroke-linecap="round"/>' };
    }
    if(typeof VIEW_OVERLAY!=='undefined'){ VIEW_OVERLAY.primeiros='ppOverlay'; VIEW_OVERLAY.errtab='errTabOverlay'; }
    const mk=(id,body)=>{ if($id(id)) return; const o=document.createElement('div'); o.className='overlay ajpage'; o.id=id; o.style.display='none'; o.innerHTML='<div class="modal"><div class="mbody" id="'+body+'"></div></div>'; document.body.appendChild(o); };
    mk('ppOverlay','ppBody'); mk('errTabOverlay','errTabBody');
    const cfg=$id('cfgOverlay'); if(cfg) cfg.classList.add('ajpage','ajcfg');
  }catch(e){ console.error('ajustes: registrar abas', e); }
})();
// abas antigas → Ajustes. Um embrulho só no openTab (as chamadas por identificador também passam por aqui).
(function ajWrapOpenTab(){
  if(typeof openTab!=='function' || openTab.__aj) return;
  const orig=openTab;
  const w=function(kind, opts){ const r=ajRoute(kind, opts); if(r){ if(r.section) AJ.sec=r.section; return orig.call(this, 'cfg', opts); } return orig.apply(this, arguments); };
  w.__aj=true; w.__orig=orig;
  try{ openTab=w; }catch(_){ } window.openTab=w;
})();
function ajustesOpen(section){
  if(section) AJ.sec=ajSecId(section);
  AJ.q=''; AJ.secTried=false;
  if(window.openTab) window.openTab('cfg'); else ajustesRender();
  // aberto pelo teclado (menu do avatar): o foco entra na seção marcada em vez de ficar no body
  requestAnimationFrame(()=>{ const ae=document.activeElement; if(ae && ae!==document.body && ae.isConnected) return; const f=document.querySelector('#ajNav .ajni.on'); if(f) f.focus(); });
}
window.ajustesOpen=ajustesOpen;
window.openCloud=()=>{ const srv=typeof cloudCfgOpen!=='undefined'&&cloudCfgOpen; try{ cloudCfgOpen=false; }catch(_){ } ajustesOpen(srv?'sistema':'perfil'); };
function ajActiveIsCfg(){ try{ const t=typeof tabById==='function'&&tabById(activeTab); return !t || t.kind==='cfg' || typeof TABS==='undefined'; }catch(_){ return true; } }
// chamado por openCfg (15): pinta a página inteira. Chamado fora da aba (link direto) → abre a aba.
function ajustesRender(){
  if(window.openTab && !ajActiveIsCfg()){ window.openTab('cfg'); return; }
  const body=$id('cfgBody'); if(!body) return;
  const orgName=(typeof cloudData!=='undefined'&&cloudData&&cloudData.org&&cloudData.org.name)||'';
  const sc=ajScope(AJ.sec, orgName);
  const head=(typeof pageHead==='function')?pageHead(Object.assign({ title:'Ajustes', id:'ajHead',
      sum:'<span class="dim">· a busca acha tudo, inclusive o que é de um projeto</span>',
      sub:'Como o Starfork funciona neste computador, na sua conta e na sua organização. O que vale só para um projeto fica em Projeto › Regras.',
      right:`<label class="ajsearch" title="Buscar nos ajustes">${ajIcon('busca')}<input id="ajQ" type="search" placeholder="Buscar nos ajustes" aria-label="Buscar nos ajustes" value="${escA(AJ.q)}" autocomplete="off" spellcheck="false"></label>` }, sc))
    :`<header class="pghead" id="ajHead"><div class="pgh-t"><h1 class="pgh-title">Ajustes</h1><span class="pgh-sp"></span><label class="ajsearch">${ajIcon('busca')}<input id="ajQ" type="search" placeholder="Buscar nos ajustes" aria-label="Buscar nos ajustes" value="${escA(AJ.q)}"></label></div></header>`;
  body.innerHTML=head+`<div class="ajbody"><nav class="ajnav" id="ajNav" aria-label="seções dos ajustes"></nav><div class="ajcontent" id="ajContent" tabindex="-1"></div></div>`;
  ajNavPaint(); ajSectionPaint();
  const q=$id('ajQ'); if(q){ q.oninput=()=>{ AJ.q=q.value; ajNavPaint(); }; q.onkeydown=e=>{ if(e.key==='Enter'){ const r=ajSearch(AJ.q); if(r.sections[0]){ e.preventDefault(); ajGo(r.sections[0]); } } else if(e.key==='Escape' && q.value){ e.stopPropagation(); q.value=''; AJ.q=''; ajNavPaint(); } }; }
  const ov=$id('cfgOverlay'); if(ov && !ov.classList.contains('astab')) ov.style.display='flex';
  ajEnvBadge();
}
window.ajustesRender=ajustesRender;
function ajBadge(id){
  if(id==='verificacao' && typeof envChecks!=='undefined' && envChecks && typeof envSummary==='function'){ const n=envSummary(envChecks).reqBad; return n?`<span class="ajb">${n}</span>`:''; }
  if(id==='versao' && typeof updInfo!=='undefined' && updInfo) return '<span class="ajb n">nova</span>';
  if(id==='motores' && typeof suaIaList!=='undefined' && Array.isArray(suaIaList) && suaIaList.length && !suaIaList.some(s=>s.ready)) return '<span class="ajb">1</span>';
  return '';
}
function ajNavPaint(){
  const nav=$id('ajNav'); if(!nav) return;
  const r=ajSearch(AJ.q), show=new Set(r.sections);
  const foco=nav.contains(document.activeElement)?(document.activeElement.dataset||{}).ajsec:null; // o nav é refeito: o foco volta pra seção
  { const c=$id('ajContent'); if(c) c.style.visibility=r.sections.length?'':'hidden'; } // busca sem resultado: a seção de antes não fica parecendo resultado
  nav.innerHTML=AJ_GROUPS.map(([g,gl])=>{ const items=AJ_SECTIONS.filter(s=>s.grp===g && show.has(s.id)); if(!items.length) return '';
      return `<div class="ajg">${esc(gl)}</div>`+items.map(s=>`<button type="button" class="ajni${s.id===AJ.sec?' on':''}" data-ajsec="${s.id}"${s.id===AJ.sec?' aria-current="page"':''}>${ajIcon(s.id)}<span>${esc(s.label)}</span>${ajBadge(s.id)}</button>`).join(''); }).join('')
    +(!r.sections.length?`<div class="ajnone">Nada em Ajustes com “${esc(AJ.q)}”.</div>`:'')
    +(r.elsewhere.length?`<div class="ajres"><b>Também em outro lugar</b>${r.elsewhere.map((e,i)=>`<button type="button" class="ajlink" data-ajelse="${i}">${esc(e.label)} <span class="dim">→ ${esc(e.where)}</span></button>`).join('')}</div>`:'')
    +(!AJ.q?`<div class="ajres quiet"><b>Também em Projeto</b><button type="button" class="ajlink" data-ajelse-go="projeto-regras">Regras do projeto</button><button type="button" class="ajlink" data-ajelse-go="projeto-disco">Espaço em disco</button></div>`:'');
  nav.querySelectorAll('[data-ajsec]').forEach(b=>b.onclick=()=>ajGo(b.dataset.ajsec));
  nav.querySelectorAll('[data-ajelse]').forEach(b=>b.onclick=()=>ajGoElsewhere(r.elsewhere[+b.dataset.ajelse].go));
  nav.querySelectorAll('[data-ajelse-go]').forEach(b=>b.onclick=()=>ajGoElsewhere(b.dataset.ajelseGo));
  if(foco){ const f=nav.querySelector(`[data-ajsec="${AJ.sec}"]`)||nav.querySelector(`[data-ajsec="${foco}"]`); if(f) f.focus(); }
}
// volta à seção anterior (closeCloud e afins) — sem fechar a aba
function ajustesBack(){ if(AJ.prev && AJ.prev!==AJ.sec) ajGo(AJ.prev); }
window.ajustesBack=ajustesBack;
function ajGo(id){ const nx=ajSecId(id); if(nx!==AJ.sec) AJ.prev=AJ.sec; AJ.sec=nx; ajNavPaint(); ajSectionPaint(); ajHeadScope(); const c=$id('ajContent'); if(c){ c.scrollTop=0; } }
function ajHeadScope(){
  const h=$id('ajHead'); if(!h || typeof pageHead!=='function') return;
  const orgName=(typeof cloudData!=='undefined'&&cloudData&&cloudData.org&&cloudData.org.name)||'';
  const tmp=document.createElement('div'); tmp.innerHTML=pageHead(Object.assign({ title:'Ajustes' }, ajScope(AJ.sec, orgName)));
  const ns=tmp.querySelector('.pgh-scope'), os=h.querySelector('.pgh-scope'); if(ns && os) os.replaceWith(ns);
}
// destinos fora de Ajustes (funções dos donos da casca/projeto, chamadas com guarda)
function ajGoElsewhere(go){
  const proj=(sec)=>{ if(window.openTab) window.openTab('projeto', { sub:sec }); }; // página Projeto (G1): Regras · Disco · Agentes
  if(go==='issues'){ if(window.openTab) window.openTab('issues'); return; }
  if(go==='projeto-disco') return proj('disco');
  if(go==='projeto-regras') return proj('regras');
  if(go==='projeto-agentes') return proj('agentes');
  if(go==='time'){ if(window.openTab) window.openTab('time', { sub:'visao' }); }
}
// "salvo ✓" inline no cabeçalho da seção (some sozinho)
function ajSaved(msg){
  const el=$id('ajSaved'); if(!el) return; el.textContent=msg||'salvo ✓'; el.classList.add('show');
  clearTimeout(ajSaved._t); ajSaved._t=setTimeout(()=>{ const e=$id('ajSaved'); if(e) e.classList.remove('show'); }, 2200);
}
function ajSecHead(id, lead, extra){ const s=ajSec(id); return `<div class="ajsh"><h2>${esc(s.label)}</h2><span class="ajsaved" id="ajSaved" role="status" aria-live="polite"></span>${extra||''}</div>${lead?`<p class="ajlead">${lead}</p>`:''}`; }
function ajRow(label, help, ctrl, errId){ return `<div class="ajrow"><div class="ajl"><b>${label}</b>${help?`<small>${help}</small>`:''}</div><div class="ajc">${ctrl}</div>${errId?`<div class="ajfe" id="${errId}" role="alert" hidden></div>`:''}</div>`; }
function ajSw(id, on, label){ return `<label class="ajsw"><input type="checkbox" role="switch" id="${id}"${on?' checked':''}><span class="ajsw-t" aria-hidden="true"></span>${label?`<span class="ajsw-l">${label}</span>`:''}</label>`; }
async function ajSetting(key, value){ await invoke('write_setting',{ key, value:String(value) }); }
function ajSettingsRead(){ return invoke('read_settings').then(s=>{ try{ return JSON.parse(s||'{}')||{}; }catch(_){ return {}; } }).catch(()=>({})); }
function ajSectionPaint(){
  const host=$id('ajContent'); if(!host) return;
  host.classList.toggle('wide', AJ.sec==='motores'||AJ.sec==='times');
  const f=AJ_RENDER[AJ.sec]||AJ_RENDER.motores;
  const fail=e=>{ console.error('ajustes: '+sec, e); if(AJ.sec!==sec) return; host.innerHTML=errorHtml(e, null, 'Não consegui mostrar esta seção'); ldWireErr(host, e, 'Não consegui mostrar esta seção', ajSectionPaint); };
  const sec=AJ.sec;
  try{ const p=f(host); if(p && typeof p.catch==='function') p.catch(fail); }catch(e){ fail(e); }
  if(typeof mvViewIn==='function'){ try{ mvViewIn(host); }catch(_){ } }
}

// ============================================================ IA e modelos
function ajDefaultPill(){
  const d=(typeof aiDefaults==='function')?aiDefaults():{ eng:'claude', model:'' };
  const lbl=(typeof aiRunLabel==='function')?aiRunLabel(d.eng, d.model):d.eng;
  const ready=!(typeof suaIaOf==='function') || !Array.isArray(suaIaList) || !suaIaList.length || !!(suaIaOf(d.eng)||{}).ready;
  return `<button type="button" class="ajpill" id="ajDefPill" title="IA padrão das demandas novas"><i class="${ready?'on':''}"></i>${esc(lbl)}<span aria-hidden="true">▾</span></button>`;
}
// IAs que rodam no TERMINAL integrado (`starfork ia gemini|opencode`, src/terminal.ts): o estado vem do mesmo resolvedor
// de binário do terminal (comando term_ai_bins); o comando de instalar só aparece quando falta (≡ AI_INSTALL do terminal)
const AJ_TERM_ENGINES=[
  { id:'gemini', mb:'GM', name:'Gemini CLI', who:'Google · roda no terminal da tarefa', cmd:'npm i -g @google/gemini-cli', access:'login do Google na 1ª vez que abrir no terminal' },
  { id:'opencode', mb:'OC', name:'OpenCode', who:'terminal aberto a vários provedores', cmd:'npm i -g opencode-ai', access:'usa as chaves desta página e a config do OpenCode' },
];
let ajTermBins=null;
function ajTermCardHtml(e, st){
  const known=!!st, ok=known&&st.installed;
  return `<article class="ajeng" data-ajterm="${e.id}"><header><span class="ajmb">${e.mb}</span><div class="ajnm"><b>${esc(e.name)}</b><small>${esc(e.who)}</small></div><span class="ajst ${!known?'':ok?'ok':'off'}">${!known?'verificando…':ok?'pronto':'falta instalar'}</span></header>
      <dl>${ok?`<div><dt>Instalado</dt><dd class="mono dim">${esc(st.bin||'')}</dd></div>`:known?`<div><dt>Instalar no Terminal</dt><dd><code class="ajcmd">${esc(e.cmd)}</code><button type="button" class="btn sm" data-envfix="${escA(e.cmd)}">copiar</button></dd></div>`:''}<div><dt>Acesso</dt><dd>${esc(e.access)}</dd></div></dl>
      <footer><span class="dim">no terminal da tarefa: <code class="mono">starfork ia ${e.id}</code></span>${known&&!ok?`<span class="sp"></span><button type="button" class="btn sm" data-ajtermre>verificar de novo</button>`:''}</footer></article>`;
}
function ajSecretsRows(){
  const rows=(typeof secretsCache!=='undefined'&&secretsCache)||[];
  const engKeys=new Set(['OPENAI_API_KEY','DEEPSEEK_API_KEY','ALT_AI_KEY','ALT_AI_BASE_URL','ALT_AI_MODEL','ALT_AI_LABEL','ALT_AI_MODELS','ALT_AI_FALLBACK','ALT_AI_ALWAYS']);
  return rows.filter(r=>!engKeys.has(r.name));
}
function ajTermLoad(){
  ajTermBins=undefined; // lendo
  Promise.resolve().then(()=>invoke('term_ai_bins')).then(r=>{ ajTermBins=Array.isArray(r)?r:[]; }).catch(()=>{ ajTermBins=[]; })
    .then(()=>{ AJ_TERM_ENGINES.forEach(e=>{ const el=document.querySelector('[data-ajterm="'+e.id+'"]'); if(!el) return; const t=document.createElement('div'); t.innerHTML=ajTermCardHtml(e, (ajTermBins||[]).find(x=>x.id===e.id)||{ id:e.id, installed:false }); el.replaceWith(t.firstElementChild); });
      const host=$id('ajContent'); if(host){ host.querySelectorAll('[data-ajterm] [data-envfix]').forEach(b=>b.onclick=()=>{ if(typeof envCopy==='function') envCopy(b); }); host.querySelectorAll('[data-ajtermre]').forEach(b=>b.onclick=()=>{ ajTermBins=null; ajTermLoad(); }); } });
}
function ajRenderMotores(host){
  const logged=typeof SB!=='undefined' && !!SB.sess();
  const binOf=id=>Array.isArray(ajTermBins)?(ajTermBins.find(x=>x.id===id)||{ id, installed:false }):null;
  const extra=AJ_TERM_ENGINES.map(e=>ajTermCardHtml(e, binOf(e.id))).join('');
  const sec=ajSecretsRows();
  const other=`<article class="ajeng" id="ajOtherKeys"><header><span class="ajmb">OK</span><div class="ajnm"><b>Outras chaves da conta</b><small>chaves extras que seguem a sua conta (ex.: a do LLM da sua empresa)</small></div></header>
      <div class="ajkeys">${!logged?'<p class="dim">Entre na sua conta pra guardar chaves — elas ficam no cofre da conta e valem em qualquer computador.</p>':(sec.length?sec.map(r=>`<div class="ajkey"><span class="mono">${esc(r.name)}</span><span class="dim mono">••••${esc(String(r.value).slice(-4))}</span><span class="sp"></span><button type="button" class="btn sm" data-ajkedit="${escA(r.name)}">trocar</button><button type="button" class="btn sm" data-ajkdel="${escA(r.name)}">remover</button></div>`).join(''):'<p class="dim">nenhuma chave extra ainda</p>')}</div>
      ${logged?'<footer><button type="button" class="btn sm" id="ajKeyAdd">adicionar chave</button><span class="dim">nome em MAIÚSCULAS_COM_TRAÇO</span></footer>':''}</article>`;
  host.innerHTML=ajSecHead('motores', 'Qual IA roda as demandas novas. Este é o <b>único lugar das chaves</b>: cada chave fica salva na sua conta e vale em qualquer computador. O que é instalado (Claude Code, Codex…) é deste computador.')
    +`<div class="ajdefl"><b>Padrão das demandas novas</b><span id="ajDefHost">${ajDefaultPill()}</span><span class="dim">vale na Nova demanda, no Formulário, no terminal, na Conversa, na Fábrica, em Agentes e no Aprendizado</span></div>`
    +`<div id="suaIaCfg" class="ajia"></div><div class="ajeng-grid">${extra}${other}</div>`
    ;
  if(typeof suaIaMount==='function') suaIaMount($id('suaIaCfg'), { ctx:'ajustes', fresh:true }); // o gateway (IA da sua empresa) se configura dentro do cartão dele
  ajPickWire($id('ajDefHost'), true);
  host.querySelectorAll('[data-ajtermre]').forEach(b=>b.onclick=()=>{ ajTermBins=null; ajTermLoad(); });
  if(ajTermBins===null) ajTermLoad();
  host.querySelectorAll('[data-envfix]').forEach(b=>b.onclick=()=>{ if(typeof envCopy==='function') envCopy(b); });
  host.querySelectorAll('[data-ajkedit]').forEach(b=>b.onclick=async()=>{ const v=await sheetAsk({ anchor:b, title:'Trocar '+b.dataset.ajkedit, text:'A chave atual continua valendo até você salvar a nova.', field:{ type:'password', placeholder:'cole a chave nova' }, ok:'salvar nova chave' }); if(!v) return; try{ await secretSet(b.dataset.ajkedit, v); ajSaved(); ajSectionPaint(); }catch(e){ showErr(e,'Não consegui salvar a chave'); } });
  host.querySelectorAll('[data-ajkdel]').forEach(b=>b.onclick=async()=>{ if(!await sheetAsk({ anchor:b, title:'Remover '+b.dataset.ajkdel+'?', text:'Sai da sua conta e deste computador.', ok:'remover', danger:true })) return; try{ await secretDel(b.dataset.ajkdel); ajSaved('removida ✓'); ajSectionPaint(); }catch(e){ showErr(e,'Não consegui remover a chave'); } });
  bindClick('ajKeyAdd', async()=>{ const b=$id('ajKeyAdd');
    const n=await sheetAsk({ anchor:b, title:'Adicionar chave', text:'O nome é como os motores procuram a chave (ex.: LGCX_API_KEY).', field:{ placeholder:'NOME_DA_CHAVE' }, ok:'continuar' }); if(!n) return;
    const name=String(n).trim().toUpperCase().replace(/[^A-Z0-9_]/g,'_');
    if(!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)){ toast('Nome inválido — use MAIÚSCULAS_COM_TRAÇO (ex.: MINHA_API_KEY).','warn'); return; }
    const v=await sheetAsk({ anchor:b, title:'Valor de '+name, field:{ type:'password', placeholder:'cole a chave' }, ok:'salvar' }); if(!v) return;
    try{ await secretSet(name, v); ajSaved(); ajSectionPaint(); }catch(e){ showErr(e,'Não consegui salvar a chave'); } });
  if(logged && !AJ.secTried && typeof secretsCache!=='undefined' && secretsCache===null && typeof secretsSync==='function'){ AJ.secTried=true; secretsSync().then(()=>{ if(AJ.sec==='motores' && secretsCache!==null) ajSectionPaint(); }).catch(()=>{}); }
}
// a pílula: com o seletor único do G2 (iaPick) quando ele existe; sem ele, um menu simples dos motores prontos
function ajPickWire(host, isDefault){
  if(!host) return;
  if(typeof iaPick==='function'){ try{ host.innerHTML='';
      const d=aiDefaults();
      iaPick(host, { value:{ engine:d.eng, model:d.model }, scope:isDefault?'padrao':'demanda', title:isDefault?'IA padrão das demandas novas':'exemplo do seletor único',
        onChange:(v, o)=>{ if(!isDefault || !v || !v.engine) return; if(!(o&&o.asDefault)) aiSaveDefaults(v.engine, v.model||''); if(typeof aiApplyDefaults==='function') aiApplyDefaults(); if(typeof suaIaRefresh==='function') suaIaRefresh(); ajSaved(); } });
      return; }catch(e){ console.warn('iaPick', e); } }
  const b=host.querySelector('.ajpill'); if(!b) return;
  b.onclick=async()=>{
    const list=(Array.isArray(suaIaList)?suaIaList:[]).slice().sort((a,c)=>(c.ready?1:0)-(a.ready?1:0));
    const opts=list.map(s=>({ value:s.id, label:(typeof suaIaName==='function'?suaIaName(s):s.id), hint:s.ready?'pronta':(typeof suaIaStateText==='function'?suaIaStateText(s):''), disabled:!s.ready }));
    if(!opts.length){ ajGo('motores'); return; }
    const v=await sheetAsk({ anchor:b, title:'IA das demandas novas', text:'As prontas vêm primeiro. O que falta se resolve nos cartões abaixo.', choices:opts, ok:'usar como padrão' });
    if(!v) return;
    try{ if(await suaIaUseDefault(v)){ ajSaved(); const h=$id('ajDefHost'); if(h){ h.innerHTML=ajDefaultPill(); ajPickWire(h, true); } } }catch(e){ showErr(e,'Não consegui salvar a IA padrão'); }
  };
}

// ============================================================ Este computador
function ajRenderCusto(host){
  const slots=(typeof slotMax!=='undefined')?slotMax:4;
  host.innerHTML=ajSecHead('custo', 'Quanto cada tarefa pode gastar e quantas rodam juntas. Os valores são em US$, porque é assim que as IAs cobram. O “≈ R$” aparece ao lado, só pra referência.')
    +`<div class="ajrows">`
    +ajRow('Teto por tarefa', 'Fica sempre ligado. A 80% do teto a tarefa pausa e o Starfork pergunta se você libera mais (com o motivo, que vai pro PR).'+(typeof orgPolMaxUsd==='function'&&orgPolMaxUsd()!=null?' A sua organização permite até '+esc(fmtCost(orgPolMaxUsd(),{usdOnly:true}))+'.':''),
      `<span class="dim" id="cfgCapBrl"></span><span class="ajmoney"><i>US$</i><input class="in" id="cfgCap" type="number" min="0.5" step="0.5" value="${escA(String(costCapDefault()))}" aria-describedby="cfgCapErr"></span>`, 'cfgCapErr')
    +ajRow('Aviso de custo', 'Só manda uma notificação quando a tarefa passa desse valor. 0 desliga.', `<span class="ajmoney"><i>US$</i><input class="in" id="cfgCost" type="number" min="0" step="5" value="${escA(lsGet('costWarn')||'25')}"></span>`, 'cfgCostErr')
    +ajRow('Cotação do dólar', 'Usada só para mostrar o “≈ R$” ao lado dos totais.', `<span class="ajmoney"><i>R$</i><input class="in" id="cfgBrl" type="number" min="0.5" step="0.05" value="${escA(String(usdBrlRate()))}"></span><span class="dim">por US$ 1</span>`, 'cfgBrlErr')
    +ajRow('Tarefas ao mesmo tempo', 'De 1 a 12. Acima disso, as novas esperam na fila (aparecem em “Na fila” na Central).', `<span class="ajstep"><button type="button" id="cfgSlotsM" aria-label="menos uma">−</button><input class="in" id="cfgSlots" type="number" min="1" max="12" value="${escA(String(slots))}" aria-label="tarefas ao mesmo tempo"><button type="button" id="cfgSlotsP" aria-label="mais uma">+</button></span>`, 'cfgSlotsErr')
    +ajRow('Retomar depois do limite da IA', 'Quando a IA bate o limite de uso, tenta de novo sozinha. 0 desliga.', `<span class="dim">a cada</span><input class="in ajnum" id="cfgLimitRetry" type="number" min="0" max="240" step="5" value="60"><span class="dim">min</span>`, 'cfgLimitRetryErr')
    +`</div>`;
  ajSettingsRead().then(o=>{ const el=$id('cfgLimitRetry'); if(el && o.limitRetryMin!=null && o.limitRetryMin!=='') el.value=String(o.limitRetryMin); });
  const cap=$id('cfgCap'), brl=$id('cfgBrl'), out=$id('cfgCapBrl');
  const upd=()=>{ const v=Math.max(0, parseFloat(cap.value)||0), r=parseFloat(brl.value)||usdBrlRate(); out.textContent=v>0?'≈ R$ '+fmtNumBR(v*r,true):''; };
  cap.addEventListener('input', upd); brl.addEventListener('input', upd); upd();
  const vals=()=>({ cap:cap.value, cost:$id('cfgCost').value, brl:brl.value, slots:$id('cfgSlots').value, retry:$id('cfgLimitRetry').value });
  const N=x=>Number(String(x).replace(',','.'));
  const save=async(field)=>{
    ['cfgCap','cfgCost','cfgBrl','cfgSlots','cfgLimitRetry'].forEach(f=>{ const e=$id(f+'Err'); if(e){ e.hidden=true; e.textContent=''; } const i=$id(f); if(i) i.removeAttribute('aria-invalid'); });
    const bad=cfgValidate(vals());
    if(bad){ const e=$id(bad.field+'Err'); if(e){ e.textContent=bad.msg; e.hidden=false; } const i=$id(bad.field); if(i) i.setAttribute('aria-invalid','true'); return; }
    const v=vals();
    try{
      if(field==='cfgCap'){ lsSet('costCap', String(N(v.cap))); await ajSetting('costCap', N(v.cap)); }
      else if(field==='cfgCost') lsSet('costWarn', String(N(v.cost)));
      else if(field==='cfgBrl') lsSet('usdBrl', String(N(v.brl)));
      else if(field==='cfgSlots'){ if(typeof setSlotMax==='function') setSlotMax(N(v.slots)); }
      else if(field==='cfgLimitRetry') await ajSetting('limitRetryMin', N(v.retry));
      if(typeof lastSig!=='undefined') lastSig='';
      ajSaved();
    }catch(e){ const el=$id(field+'Err'); if(el){ el.textContent=humanErr(e,'Não salvou').msg; el.hidden=false; } }
  };
  ['cfgCap','cfgCost','cfgBrl','cfgSlots','cfgLimitRetry'].forEach(f=>{ const i=$id(f); if(i) i.addEventListener('change', ()=>save(f)); });
  const step=d=>{ const i=$id('cfgSlots'); i.value=String(Math.max(1, Math.min(12, (parseInt(i.value,10)||1)+d))); save('cfgSlots'); };
  bindClick('cfgSlotsM', ()=>step(-1)); bindClick('cfgSlotsP', ()=>step(1));
}
// encerrar terminal parado (term.rs › idle_ms_of: minutos, 0 = nunca; padrão 15)
const AJ_TERM_IDLE=[['5','depois de 5 min'],['15','depois de 15 min (padrão)'],['30','depois de 30 min'],['60','depois de 1 hora'],['0','nunca']];
function ajTermIdleOf(v){ const s=String(v==null?'':v).replace(/"/g,'').trim(); return AJ_TERM_IDLE.some(x=>x[0]===s)?s:'15'; }
function ajRenderModo(host){
  host.innerHTML=ajSecHead('modo', 'Vale para as tarefas novas. As que já estão rodando continuam do jeito que começaram.')
    +`<div class="ajrc" role="radiogroup" aria-label="como as tarefas novas rodam" id="ajModeRc">
      <button type="button" class="ajrcard" role="radio" data-ajmode="terminal" aria-checked="false" disabled><span class="rd"></span><b>Terminal <span class="ajtag">padrão</span></b><span>O Claude Code oficial num terminal dentro da tarefa. Você conversa direto com a IA.</span></button>
      <button type="button" class="ajrcard" role="radio" data-ajmode="auto" aria-checked="false" disabled><span class="rd"></span><b>Automático</b><span>O agente roda em segundo plano e conversa pelo chat da tarefa.</span></button></div>
    <p class="ajhint">Motores sem terminal (DeepSeek, gateway) rodam no automático. Construir sozinho, etapas e épicos que iniciam sozinhos sempre usam o automático. Pra rodar sem ninguém olhando, o caminho mais seguro é uma chave de API.</p>
    <div class="ajrows">`
    +ajRow('Navegador dos agentes', 'Quando o agente abre um site pra testar ou tirar print. Por padrão roda em segundo plano, sem janela; ligue pra acompanhar ou fazer login.', ajSw('cfgBrowserVisible', false, 'mostrar a janela'))
    +ajRow('Previsão de tempo e custo antes de rodar', 'Custa uma chamada curta de IA por demanda (aparece em Uso › Previsão). Desligado: nenhuma chamada extra.', ajSw('cfgEstimate', true, 'prever'))
    +ajRow('Terminal vivo ao abrir a tarefa', 'Abrir uma tarefa parada retoma a sessão no terminal, pronta pra digitar. Não gasta nada até você mandar algo.', ajSw('cfgTermAuto', true, 'retomar sozinho'))
    +ajRow('Encerrar terminal parado', 'Terminal de tarefa que você não está vendo, sem nada rodando, fecha depois desse tempo — volta sozinho quando você abrir a tarefa.', `<select class="in" id="cfgTermIdle" aria-label="encerrar terminal parado depois de">${AJ_TERM_IDLE.map(([v,l])=>'<option value="'+v+'">'+l+'</option>').join('')}</select>`)
    +`</div>`;
  let loaded, stored;
  const paint=v=>host.querySelectorAll('[data-ajmode]').forEach(b=>{ const on=b.dataset.ajmode===v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  ajSettingsRead().then(o=>{ loaded=cfgTaskModeOf(o); stored=o.taskMode||''; paint(loaded); host.querySelectorAll('[data-ajmode]').forEach(b=>{ b.disabled=false; }); // só depois de ler (antes gravaria uma escolha que ninguém fez)
    const bv=$id('cfgBrowserVisible'); if(bv) bv.checked=(o.browserVisible===true||o.browserVisible==='1'||o.browserVisible==='true');
    const es=$id('cfgEstimate'); if(es) es.checked=!(o.estimateEnabled===false||o.estimateEnabled==='0'||o.estimateEnabled==='false');
    const ta=$id('cfgTermAuto'); if(ta) ta.checked=!(o.termAutoResume===false||o.termAutoResume==='0'||o.termAutoResume==='false');
    const ti=$id('cfgTermIdle'); if(ti) ti.value=ajTermIdleOf(o.termIdleMin); });
  host.querySelectorAll('[data-ajmode]').forEach(b=>b.onclick=async()=>{
    const v=b.dataset.ajmode; paint(v);
    if(!cfgTaskModeShouldSave(v, loaded, stored)) return;
    try{ await ajSetting('taskMode', v==='auto'?'auto':'terminal'); await ajSetting('taskModeSet','2'); loaded=v; stored=v; ajSaved(); }catch(e){ showErr(e,'Não salvou o modo das tarefas'); paint(loaded); }
  });
  { const bv=$id('cfgBrowserVisible'); if(bv) bv.onchange=async()=>{ try{ await ajSetting('browserVisible', bv.checked?'1':'0'); ajSaved(); }catch(e){ showErr(e,'Não salvou'); } }; }
  { const ta=$id('cfgTermAuto'); if(ta) ta.onchange=async()=>{ try{ await ajSetting('termAutoResume', ta.checked?'1':'0'); if(typeof TERM_CFG!=='undefined'){ TERM_CFG.auto=ta.checked; TERM_CFG.at=Date.now(); } ajSaved(); }catch(e){ showErr(e,'Não salvou'); } }; }
  { const ti=$id('cfgTermIdle'); if(ti) ti.onchange=async()=>{ try{ await ajSetting('termIdleMin', ti.value); ajSaved(); }catch(e){ showErr(e,'Não salvou'); } }; }
  { const es=$id('cfgEstimate'); if(es) es.onchange=async()=>{ try{ await ajSetting('estimateEnabled', es.checked?'1':'0'); if(typeof estSetEnabled==='function') estSetEnabled(es.checked); ajSaved(); }catch(e){ showErr(e,'Não salvou'); } }; }
}
function ajRenderAparencia(host){
  host.innerHTML=ajSecHead('aparencia', 'Claro (papel e tinta azul) ou escuro (verde do logo). Sistema segue o macOS. Vale na hora, inclusive nos terminais.')+'<div id="temaHost" class="ajtema"></div>';
  if(typeof temaCfgMount==='function') temaCfgMount($id('temaHost'));
}
function ajRenderAprendizado(host){
  const opts=[['sugerir','Sugerir','Você revisa antes de entrar na memória (Projeto › Memória › Pra revisar).'],['auto','Automático','Entra sozinho. Dá pra desfazer na Memória.'],['desligado','Desligado','Nenhuma revisão no fim das tarefas — nenhuma chamada extra de IA.']];
  host.innerHTML=ajSecHead('aprendizado', 'No fim de cada tarefa, uma revisão relê o que aconteceu (suas correções, retrabalho) e propõe aprendizados pra memória do projeto.')
    +`<div class="ajrlist" role="radiogroup" aria-label="modo do aprendizado">${opts.map(([v,t,d])=>`<button type="button" class="ajrcard" role="radio" data-ajlearn="${v}" aria-checked="false"><span class="rd"></span><b>${t}</b><span>${d}</span></button>`).join('')}</div>
    <div class="ajrows">${ajRow('IA da revisão', 'Roda uma vez por tarefa, quando ela chega pra revisar.', `<select class="in" id="cfgRetroModel" aria-label="modelo da revisão">${RETRO_MODELS.map(([v,l])=>'<option value="'+escA(v)+'">'+esc(l)+'</option>').join('')}</select>`)}</div>`;
  const paint=v=>host.querySelectorAll('[data-ajlearn]').forEach(b=>{ const on=b.dataset.ajlearn===v; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on)); });
  ajSettingsRead().then(o=>{ paint(['sugerir','auto','desligado'].includes(o.learnMode)?o.learnMode:'sugerir'); const rm=$id('cfgRetroModel'); if(rm) retroModelSelect(rm, o.retroModel); });
  host.querySelectorAll('[data-ajlearn]').forEach(b=>b.onclick=async()=>{ paint(b.dataset.ajlearn); try{ await ajSetting('learnMode', b.dataset.ajlearn); ajSaved(); }catch(e){ showErr(e,'Não salvou'); } });
  { const rm=$id('cfgRetroModel'); if(rm) rm.onchange=async()=>{ try{ await ajSetting('retroModel', rm.value); ajSaved(); }catch(e){ showErr(e,'Não salvou'); } }; }
}
function ajRenderGithub(host){
  const gh=(typeof envChecks!=='undefined'&&envChecks||[]).find(c=>/github cli|\bgh\b/i.test(String(c.name||'')));
  host.innerHTML=ajSecHead('github', 'A conta ativa abre os PRs e envia o código. Troque quando mudar de empresa ou de conta.')
    +`<div id="ghHost" class="ajgh"></div>${gh?`<p class="ajhint">${gh.ok?'GitHub CLI instalado ✓':'GitHub CLI faltando'} · checado em <button type="button" class="ajlink inline" data-ajgo="verificacao">Verificação</button></p>`:''}`;
  if(typeof ghMount==='function') ghMount();
  host.querySelectorAll('[data-ajgo]').forEach(b=>b.onclick=()=>ajGo(b.dataset.ajgo));
}
function ajRenderVerificacao(host){
  host.innerHTML=`<div id="ajEnvBody"></div>`;
  if(typeof renderEnv==='function') renderEnv($id('ajEnvBody'));
  if(typeof runEnvCheck==='function' && (typeof envChecks==='undefined' || !envChecks)) runEnvCheck().then(()=>{ if(AJ.sec==='verificacao') renderEnv($id('ajEnvBody')); ajNavPaint(); }).catch(()=>{});
}
function ajRenderNotif(host){
  host.innerHTML=ajSecHead('notificacoes', 'Avisos do sistema. Clicar num aviso abre a tarefa.')
    +`<div id="notifHost" class="ajnotif"></div><h3 class="ajh3">O que avisa</h3><div class="ajlist">
      <div class="ajli"><b>Pronta pra revisar</b></div><div class="ajli"><b>Plano pra aprovar · Precisa de você</b></div><div class="ajli"><b>Tarefa falhou</b><small>com o motivo e o que fazer</small></div>
      <div class="ajli"><b>PR aberto · Integrada na base · Nova tarefa iniciada</b></div><div class="ajli"><b>Custo alto</b><small>passou do aviso de custo (<button type="button" class="ajlink inline" data-ajgo="custo">Custo e limites</button>)</small></div></div>`;
  if(typeof notifCfgMount==='function') notifCfgMount();
  host.querySelectorAll('[data-ajgo]').forEach(b=>b.onclick=()=>ajGo(b.dataset.ajgo));
}
function ajRenderVersao(host){
  const dev=typeof canSeeDevTools==='function' && canSeeDevTools();
  host.innerHTML=ajSecHead('versao', 'O app procura versão nova sozinho a cada 2 minutos (e quando você volta pra janela).')
    +`<div id="updHost" class="ajupd"></div>`
    +(dev?`<div class="ajrows">${ajRow('Publicar uma versão <span class="ajtag">só dev e admin</span>', 'Publica o build deste computador para o time. Os colegas veem “atualizar”.', '<button type="button" class="btn sm" id="ajPub">publicar…</button>')}</div>`:'');
  if(typeof updRenderCfg==='function') updRenderCfg();
  bindClick('ajPub', ()=>{ const b=$id('pubRelBtn'); if(b) b.click(); });
}
async function ajRenderDisco(host){
  host.innerHTML=ajSecHead('disco', 'Quanto a pasta de trabalho do Starfork ocupa em cada projeto. Aprendizados e estado nunca são apagados. A limpeza de cada projeto fica em Projeto › Espaço em disco.')
    +`<div class="ajlist" id="ajDiskList">${skeletonHtml('lista',{ n:2, compact:true, inline:true, label:'medindo' })}</div><p class="ajhint" id="ajDiskTot"></p>`;
  const list=(typeof window.projectsList==='function'?window.projectsList():[])||[];
  const cur=(typeof state!=='undefined'&&state.repo)||'';
  let u=null, err='';
  if(cur){ try{ u=await invoke('workspace_usage'); }catch(e){ err=humanErr(e,'Não consegui medir').msg; } }
  if(AJ.sec!=='disco') return;
  const el=$id('ajDiskList'); if(!el) return;
  const repos=[...new Set([cur, ...list.map(p=>p.path||p.repo||p).filter(x=>typeof x==='string')].filter(Boolean))];
  if(!repos.length){ el.innerHTML='<div class="ajli"><b>Nenhum projeto aberto ainda</b><small>abra um projeto pra ver o espaço usado</small></div>'; return; }
  const free=u?((u.worktrees&&u.worktrees.staleBytes)||0)+(u.temp||0):0;
  el.innerHTML=repos.map(r=>{ const here=r===cur;
    return `<div class="ajli"><span class="ajav">${esc(pathBase(r).slice(0,1).toUpperCase())}</span><div class="l"><b>${esc(pathBase(r))}</b><small>${here?(u?esc(fmtBytes(u.total))+' · dá pra liberar '+esc(fmtBytes(free))+' sem perder nada':esc(err||'medindo…')):'abra o projeto pra medir'}</small></div><button type="button" class="btn sm" data-ajdisk="${escA(r)}">abrir no projeto</button></div>`; }).join('');
  const t=$id('ajDiskTot'); if(t && u) t.innerHTML=`Neste projeto: <b>${esc(fmtBytes(u.total))}</b>, dos quais <b>${esc(fmtBytes(free))}</b> dá pra liberar agora (cópias de trabalho de tarefas finalizadas e temporários).`;
  el.querySelectorAll('[data-ajdisk]').forEach(b=>b.onclick=async()=>{ const r=b.dataset.ajdisk; if(r!==cur && typeof window.switchProject==='function'){ try{ await window.switchProject(r); }catch(_){ } } ajGoElsewhere('projeto-disco'); });
}
function ajRenderSistema(host){
  const unconf=typeof SB!=='undefined' && !SB.configured(); // sem servidor configurado, qualquer pessoa precisa do formulário
  const dev=unconf||(typeof canSeeDevTools==='function'&&canSeeDevTools())||!!lsGet('sb:url');
  const isLocal=typeof SB!=='undefined' && /127\.0\.0\.1|localhost/.test(SB.url());
  host.innerHTML=ajSecHead('sistema','')
    +`<div class="ajrows">`
    +ajRow('Primeiros passos', 'Abre de novo a aba com o checklist do começo.', '<button type="button" class="btn sm" id="ajPP">abrir</button>')
    +ajRow('Atalhos do teclado', 'Também abre com ?.', '<button type="button" class="btn sm" id="ajKbd">abrir</button><kbd>?</kbd>')
    +(dev?ajRow('Servidor da conta <span class="ajtag">avançado · só dev e admin</span>', 'Pra apontar o app para outro servidor de contas. Trocar derruba a sessão neste computador.', '<button type="button" class="btn sm" id="ajSrvShow" aria-expanded="false">mostrar</button>'):'')
    +`</div>`
    +(dev?`<div class="ajsrv" id="ajSrv"${unconf?'':' hidden'}><p class="ajhint">Servidor atual: <b>${isLocal?'servidor local (dev)':(lsGet('sb:url')?esc(SB.url()):'nuvem do Starfork (padrão)')}</b></p>
      <label class="ajlbl" for="sbUrl">Endereço do servidor</label><input class="in" id="sbUrl" placeholder="https://xxxx.supabase.co" value="${escA(lsGet('sb:url')||'')}">
      <label class="ajlbl" for="sbKey">Chave pública do servidor</label><input class="in mono" id="sbKey" value="${escA(lsGet('sb:key')||'')}">
      <div class="ajacts"><button type="button" class="btn sm" id="sbCfgLocal">usar servidor local (dev)</button><button type="button" class="btn sm" id="sbCfgCloud">usar a nuvem (padrão)</button><span class="sp"></span><button type="button" class="btn primary sm" id="sbSaveCfg">salvar e entrar de novo</button></div></div>`:'');
  bindClick('ajPP', ()=>primeirosPassosOpen());
  bindClick('ajKbd', ()=>{ if(typeof openShortcuts==='function') openShortcuts(); });
  bindClick('ajSrvShow', ()=>{ const s=$id('ajSrv'), b=$id('ajSrvShow'); if(!s) return; s.hidden=!s.hidden; b.textContent=s.hidden?'mostrar':'esconder'; b.setAttribute('aria-expanded', String(!s.hidden)); });
  const relog=(url,key)=>{ sbLogout(); lsSet('sb:url',url); lsSet('sb:key',key); ajSectionPaint(); }; // sai pelo caminho único (limpa as chaves locais) e só depois troca o servidor
  bindClick('sbSaveCfg', ()=>relog($id('sbUrl').value.trim(), $id('sbKey').value.trim()));
  bindClick('sbCfgLocal', ()=>relog(SB_LOCAL.url, SB_LOCAL.key));
  bindClick('sbCfgCloud', ()=>relog('', ''));
}

// ============================================================ Conta e time
// estados de página padrão quando falta conta / organização / permissão
function ajStateHtml(kind, o){
  o=o||{};
  const S={
    semserv:['warn','Falta configurar o servidor da conta','Sem servidor de contas este computador não entra na conta. Configure em Sistema › Servidor da conta.','configurar o servidor','ajGoSrv'],
    semconta:['perfil','Entre na sua conta','Organização, times, convites, chaves e assinatura seguem a sua conta. Os ajustes deste computador continuam valendo sem conta.','entrar ou criar conta','ajSignIn'],
    semorg:['org','Você ainda não está numa organização','Crie uma organização com o primeiro time, ou entre num time com o convite que recebeu.','criar organização','ajGoTimes'],
    semperm:['warn','Só quem administra vê isto','Peça pra um admin da organização'+(o.who?' ('+o.who+')':'')+' fazer isso, ou te dar a permissão.','',''],
  }[kind];
  return `<div class="ajempty"><span class="eic">${ajIcon(S[0])}</span><h3>${esc(S[1])}</h3><p>${esc(S[2])}</p>${S[3]?`<div class="acts"><button type="button" class="btn primary sm" id="${S[4]}">${esc(S[3])}</button></div>`:''}</div>`;
}
function ajStateWire(){
  bindClick('ajSignIn', ()=>{ if(typeof auShow==='function') auShow(lsGet('sb:email')?'login':'signup', { backTo:()=>ajustesOpen(AJ.sec) }); });
  bindClick('ajGoTimes', ()=>ajGo('times'));
  bindClick('ajGoSrv', ()=>ajGo('sistema'));
}
// garante cloudData (carrega uma vez); falha vira erro padrão com "tentar de novo"
async function ajCloudReady(host, id, lead){
  if(typeof SB!=='undefined' && !SB.configured()){ host.innerHTML=ajSecHead(id, lead)+ajStateHtml('semserv'); ajStateWire(); return null; }
  if(typeof SB==='undefined' || !SB.sess()){ host.innerHTML=ajSecHead(id, lead)+ajStateHtml('semconta'); ajStateWire(); return null; }
  if(!cloudData){
    host.innerHTML=ajSecHead(id, lead)+skeletonHtml('lista',{ n:4, label:'buscando a conta' });
    try{ await tabBusy('cfg', cloudLoad(), { label:'buscando a conta e o time' }); }
    catch(e){ if(AJ.sec!==id) return null; cloudData=null; host.innerHTML=ajSecHead(id, lead)+errorHtml(e, null, 'Não consegui carregar a conta'); ldWireErr(host, e, 'Não consegui carregar a conta', ajSectionPaint); return null; }
    if(AJ.sec!==id) return null;
    ajHeadScope(); // o nome da organização só chega agora: o selo do cabeçalho se atualiza
    try{ cloudBtnSync(); }catch(_){ } // e o avatar + o item Time da lateral também (org criada, convite aceito, time trocado)
  }
  return cloudData;
}
function ajCloudMsg(){ if(typeof cloudMsg==='undefined'||!cloudMsg) return ''; const ok=cloudMsg.startsWith('✓'); const m=cloudMsg; cloudMsg=''; return `<div class="ajband ${ok?'ok':'err'}" role="${ok?'status':'alert'}">${esc(m)}</div>`; }
function ajMe(){ return (typeof cloudUserId==='function')?cloudUserId():''; }
function ajPName(d, uid){ const p=(d.profileByUser||{})[uid]||{}; return p.name||p.email||String(uid).slice(0,8); }
function ajInitials(n){ return String(n||'?').split(/[\s@.]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'?'; }
async function ajRenderPerfil(host){
  if(typeof SB!=='undefined' && !SB.configured()){ host.innerHTML=ajSecHead('perfil','')+ajStateHtml('semserv'); ajStateWire(); return; }
  if(typeof SB==='undefined' || !SB.sess()){ host.innerHTML=ajSecHead('perfil','')+ajStateHtml('semconta'); ajStateWire(); return; }
  const s=SB.sess(), meta=(s.user&&s.user.user_metadata)||{};
  const prof=cloudData&&cloudData.profileByUser&&cloudData.profileByUser[ajMe()];
  const name=(prof&&prof.name)||meta.name||meta.full_name||'';
  host.innerHTML=ajSecHead('perfil','')+ajCloudMsg()+`<div class="ajrows">`
    +ajRow('Nome', 'Como o time te vê.', `<input class="in" id="ajName" value="${escA(name)}" placeholder="seu nome" aria-label="nome">`, 'ajNameErr')
    +ajRow('E-mail', 'Pra entrar e receber convites.', `<span class="mono">${esc((s.user&&s.user.email)||'')}</span>`)
    +ajRow('Senha', 'Define uma senha nova pra sua conta.', '<button type="button" class="btn sm" id="ajPass">trocar senha</button>')
    +ajRow('Sair da conta', 'Neste computador. As tarefas que estão rodando continuam.', '<button type="button" class="btn sm" id="ajLogout">sair</button>')
    +`</div>`;
  { const i=$id('ajName'); if(i) i.onchange=async()=>{ const v=i.value.trim(); const e=$id('ajNameErr'); if(e) e.hidden=true;
      try{ await sbFetch('/rest/v1/profiles?user_id=eq.'+ajMe(), { method:'PATCH', body:JSON.stringify({ name:v||null }) }); if(prof) prof.name=v; try{ cloudBtnSync(); }catch(_){ } ajSaved(); }
      catch(err){ if(e){ e.textContent=cloudErrMsg(err,'Não salvou o nome'); e.hidden=false; } } }; }
  bindClick('ajPass', ()=>auShow('newpass', { backTo:()=>ajustesOpen('perfil') }));
  bindClick('ajLogout', async()=>{ const b=$id('ajLogout'); if(!await sheetAsk({ anchor:b, title:'Sair da conta neste computador?', text:'As tarefas que estão rodando continuam. Pra ver o time de novo, entre outra vez.', ok:'sair', danger:true })) return; sbLogout(); ajSectionPaint(); });
}
async function ajRenderOrg(host){
  const d=await ajCloudReady(host, 'org', ''); if(!d) return;
  if(!d.org){ host.innerHTML=ajSecHead('org','')+ajStateHtml('semorg'); ajStateWire(); return; }
  const owner=d.meRole==='owner', seatsUsed=(d.orgMembers||[]).length;
  const bl=ajBillingLine(typeof myBilling!=='undefined'?myBilling:null, ajMe());
  const planName=d.org.plan==='enterprise'?'Enterprise':(bl.active?bl.name:ajPlanPt(d.org.plan));
  host.innerHTML=ajSecHead('org','')+ajCloudMsg()
    +(!d.org.license_key?`<div class="ajband warn">${ajIcon('warn')}<span>Organização <b>sem licença</b> — modo avaliação. ${owner?'Defina a chave abaixo.':'Peça ao dono pra ativar a licença.'}</span></div>`:'')
    +(seatsUsed>=d.org.seats?`<div class="ajband warn">${ajIcon('warn')}<span>Todos os <b>${d.org.seats} assentos</b> em uso — convites novos são recusados até liberar assento ou ampliar o plano.</span></div>`:'')
    +`<div class="ajorg"><div class="ajorg-h"><b>${esc(d.org.name)}</b><span class="dim">seu papel: ${esc(ajRolePt(d.meRole))}</span></div>
      <dl class="ajdl"><div><dt>Plano</dt><dd><b>${esc(planName)}</b>${d.org.plan==='enterprise'?' <span class="dim">pago pela organização</span>':''}</dd></div><div><dt>Assentos</dt><dd>${seatsUsed} de ${esc(String(d.org.seats||'—'))}</dd></div></dl></div>
    <div class="ajrows">`
    +(owner?ajRow('Licença', 'Só o dono vê e troca.', `<span class="mono dim">${esc(d.org.license_key?String(d.org.license_key).replace(/^(.{0,9}).*(.{3})$/,'$1••••$2'):'sem chave — plano de avaliação')}</span><button type="button" class="btn sm" id="ajLic">trocar chave</button>`):'')
    +ajRow('Visão da organização', 'Tarefas, andamento e custo por time agora moram no Time.', '<button type="button" class="btn sm" id="ajOrgView">abrir Time › Visão geral</button>')
    +ajRow('Agentes e equipes da organização', 'Compartilhar e aplicar num projeto agora fica em Projeto › Agentes › Equipes.', '<button type="button" class="btn sm" id="ajOrgCat">abrir</button>')
    +`</div>`;
  bindClick('ajOrgView', ()=>ajGoElsewhere('time'));
  bindClick('ajOrgCat', ()=>ajGoElsewhere('projeto-agentes'));
  bindClick('ajLic', async()=>{ const b=$id('ajLic'); const k=await sheetAsk({ anchor:b, title:'Trocar a chave de licença', field:{ placeholder:d.org.license_key?'cole a chave nova (a atual continua até salvar)':'cole a chave de licença', value:'' }, ok:'salvar' }); if(!k) return;
    try{ await sbFetch('/rest/v1/orgs?id=eq.'+d.org.id, { method:'PATCH', body:JSON.stringify({ license_key:String(k).trim()||null }) }); cloudData=null; cloudMsg='✓ licença atualizada'; }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui salvar a licença'); } ajSectionPaint(); });
}
async function ajRenderTimes(host){
  const lead='Cada time só vê o que ele faz. Quem já tem conta entra com “adicionar ao time”; quem não tem, por <button type="button" class="ajlink inline" data-ajgo="convites">Convites</button>.';
  const d=await ajCloudReady(host, 'times', lead); if(!d) return;
  if(!d.org){ // sem organização: criar org + 1º time ou aceitar convite por código
    host.innerHTML=ajSecHead('times','')+ajCloudMsg()+`<div class="ajempty left"><span class="eic">${ajIcon('org')}</span><h3>Você ainda não está numa organização</h3><p>Crie a organização com o primeiro time — você vira o dono e o lead. Ou entre num time com o código do convite (convite pro seu e-mail entra sozinho).</p></div>
      <div class="ajcols"><div class="ajcard"><h3 class="ajh3">Criar organização</h3><label class="ajlbl" for="sbOrgName">Nome da organização</label><input class="in" id="sbOrgName" placeholder="ex.: Minha empresa" aria-describedby="sbOrgErr"><label class="ajlbl" for="sbTeamName">Nome do primeiro time</label><input class="in" id="sbTeamName" placeholder="ex.: Produto" aria-describedby="sbOrgErr"><div class="ajfe" id="sbOrgErr" role="alert" hidden></div><div class="ajacts"><span class="sp"></span><button type="button" class="btn primary sm" id="sbCreateOrg">criar</button></div></div>
      <div class="ajcard"><h3 class="ajh3">Entrar num time</h3><label class="ajlbl" for="sbInvTok">Código do convite</label><input class="in mono" id="sbInvTok" placeholder="cole o código que o lead te mandou"><div class="ajfe" id="sbInvTokErr" role="alert" hidden></div><div class="ajacts"><span class="sp"></span><button type="button" class="btn sm" id="sbAccept">aceitar convite</button></div></div></div>`;
    bindClick('sbCreateOrg', async()=>{ const b=$id('sbCreateOrg'); if(b.disabled) return;
      const on=$id('sbOrgName').value.trim(), tn=$id('sbTeamName').value.trim(), er=$id('sbOrgErr'), miss=ajOrgFormErr(on, tn);
      if(miss){ er.textContent=miss.msg; er.hidden=false; $id(miss.field).focus(); return; } // nada de "Minha organização"/"Time 1" criados calados
      er.hidden=true; b.disabled=true; b.textContent='criando…';
      try{ const j=await sbRpc('create_org_with_team',{ p_org_name:on, p_team_name:tn }); lsSet('sb:team', j.team_id); cloudData=null; cloudMsg='✓ organização criada'; }
      catch(e){ cloudMsg=ajOrgCreateErr(e); } ajSectionPaint(); });
    bindClick('sbAccept', ()=>ajAcceptInvite($id('sbAccept'), $id('sbInvTok').value.trim(), $id('sbInvTokErr'), $id('sbInvTok')));
    return;
  }
  const me=ajMe(), teamId=cloudTeamId(), isAdmin=d.meRole==='owner'||d.meRole==='admin';
  const myLead=d.teams.filter(t=>(d.teamMembers[t.id]||[]).some(m=>m.user_id===me&&m.role==='lead'));
  const canManage=t=>isAdmin||myLead.some(x=>x.id===t.id);
  const teamHtml=d.teams.map(t=>{
    const mems=d.teamMembers[t.id]||[]; const leads=mems.filter(m=>m.role==='lead').map(m=>ajPName(d,m.user_id));
    const fora=(d.orgMembers||[]).filter(om=>!mems.some(m=>m.user_id===om.user_id));
    return `<article class="ajtm"><header><div class="l"><b>${esc(t.name)}</b><small>${mems.length} ${mems.length===1?'pessoa':'pessoas'} · ${leads.length?'lead: '+esc(leads.join(', ')):'<span class="warn">sem lead</span>'}</small></div>
        ${t.id===teamId?'<span class="ajtag on">seu time atual</span>':`<button type="button" class="btn sm" data-ajt="use" data-team="${escA(t.id)}">usar este time</button>`}
        ${canManage(t)?`<button type="button" class="btn sm icon quiet" data-ajt="menu" data-team="${escA(t.id)}" aria-label="mais ações do time ${escA(t.name)}" title="mais ações">⋯</button>`:''}</header>
      ${mems.map(m=>`<div class="ajmem"><span class="ajav">${esc(ajInitials(ajPName(d,m.user_id)))}</span><span>${esc(ajPName(d,m.user_id))}${m.user_id===me?' <small>· você</small>':''}</span><span class="dim">${m.role==='lead'?'lead':'membro'}</span>${canManage(t)?`<button type="button" class="btn sm icon quiet" data-ajt="mmenu" data-team="${escA(t.id)}" data-uid="${escA(m.user_id)}" aria-label="ações de ${escA(ajPName(d,m.user_id))}">⋯</button>`:'<span></span>'}</div>`).join('')||'<div class="ajmem empty dim">time vazio — adicione alguém abaixo</div>'}
      ${canManage(t)&&fora.length?`<div class="ajadd"><select class="in" id="ajAdd-${escA(t.id)}" aria-label="pessoa pra adicionar ao time ${escA(t.name)}">${fora.map(om=>`<option value="${escA(om.user_id)}">${esc(ajPName(d,om.user_id))}</option>`).join('')}</select><button type="button" class="btn sm" data-ajt="add" data-team="${escA(t.id)}">adicionar ao time</button></div>`:''}</article>`; }).join('');
  const q=ajNorm(AJ.memQ);
  const mems=(d.orgMembers||[]).filter(om=>!q || ajNorm(ajPName(d,om.user_id)).includes(q));
  const teamsOf=uid=>d.teams.filter(t=>(d.teamMembers[t.id]||[]).some(m=>m.user_id===uid)).map(t=>t.name).join(', ');
  host.innerHTML=ajSecHead('times', lead, (isAdmin?'<button type="button" class="btn sm" id="ajTeamAdd">novo time</button>':''))+ajCloudMsg()+`<p class="ajhint">${esc(ajOtherOrgMsg(d.org.name))}</p>`
    +(teamHtml||`<div class="ajempty"><span class="eic">${ajIcon('times')}</span><h3>Nenhum time ainda</h3><p>Todo convite e toda tarefa compartilhada entram num time.</p></div>`)
    +(isAdmin?`<div class="ajsh2"><h3 class="ajh3">Pessoas da organização (${(d.orgMembers||[]).length})</h3><label class="ajsearch sm">${ajIcon('busca')}<input id="ajMemQ" type="search" placeholder="buscar pessoa" aria-label="buscar pessoa" value="${escA(AJ.memQ)}"></label></div>
      <table class="ajtbl"><thead><tr><th>Pessoa</th><th>Papel</th><th>Times</th><th></th></tr></thead><tbody>${mems.map(om=>`<tr><td>${esc(ajPName(d,om.user_id))}${om.user_id===me?' <small class="dim">· você</small>':''}</td><td>${esc(ajRolePt(om.role))}</td><td class="dim">${esc(teamsOf(om.user_id)||'—')}</td><td class="num">${om.role!=='owner'&&om.user_id!==me?`<button type="button" class="btn sm" data-ajorgrm="${escA(om.user_id)}">tirar da organização</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="dim">ninguém com esse nome</td></tr>'}</tbody></table>`:'');
  host.querySelectorAll('[data-ajgo]').forEach(b=>b.onclick=()=>ajGo(b.dataset.ajgo));
  { const i=$id('ajMemQ'); if(i) i.oninput=()=>{ AJ.memQ=i.value; const pos=i.selectionStart; ajSectionPaint(); const j=$id('ajMemQ'); if(j){ j.focus(); try{ j.setSelectionRange(pos,pos); }catch(_){ } } }; }
  const after=()=>{ cloudData=null; ajSectionPaint(); try{ cloudBtnSync(); }catch(_){ } };
  bindClick('ajTeamAdd', async()=>{ const b=$id('ajTeamAdd'); const n=await sheetAsk({ anchor:b, title:'Novo time', text:'Você vira o lead e ele passa a ser o seu time atual.', field:{ placeholder:'nome do time' }, ok:'criar time' }); if(!n) return;
    try{ const rows=await sbPost('teams',{ org_id:d.org.id, name:n }); await sbPost('team_members',{ team_id:rows[0].id, user_id:me, role:'lead' }); lsSet('sb:team', rows[0].id); cloudMsg='✓ time criado'; }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui criar o time'); } after(); });
  host.querySelectorAll('[data-ajt]').forEach(b=>b.onclick=async()=>{
    const act=b.dataset.ajt, tid=b.dataset.team, uid=b.dataset.uid, t=d.teams.find(x=>x.id===tid)||{};
    try{
      if(act==='use'){ lsSet('sb:team', tid); after(); return; }
      if(act==='add'){ const sel=$id('ajAdd-'+tid); if(!sel||!sel.value) return; await sbPost('team_members',{ team_id:tid, user_id:sel.value, role:'member' }); cloudMsg='✓ adicionado ao time'; after(); return; }
      if(act==='menu'){
        const v=await sheetAsk({ anchor:b, title:t.name, choices:[{ value:'rename', label:'renomear' }].concat(isAdmin?[{ value:'del', label:'excluir o time', hint:'os membros perdem o vínculo', danger:true }]:[]), ok:'continuar' }); if(!v) return;
        if(v==='rename'){ const n=await sheetAsk({ anchor:b, title:'Renomear time', field:{ value:t.name||'' }, ok:'salvar' }); if(!n||n.trim()===t.name) return; await sbFetch('/rest/v1/teams?id=eq.'+tid,{ method:'PATCH', body:JSON.stringify({ name:n.trim() }) }); cloudMsg='✓ time renomeado'; }
        if(v==='del'){ const n=(d.teamMembers[tid]||[]).length; if(!await sheetAsk({ anchor:b, title:'Excluir o time “'+t.name+'”?', text:(n?n+' pessoa(s) perdem o vínculo. ':'')+'As tarefas do time continuam no histórico.', ok:'excluir', danger:true })) return; await sbFetch('/rest/v1/teams?id=eq.'+tid,{ method:'DELETE' }); if(teamId===tid) lsSet('sb:team',''); cloudMsg='✓ time excluído'; }
        after(); return; }
      if(act==='mmenu'){
        const cur=(d.teamMembers[tid]||[]).find(m=>m.user_id===uid)||{}; const nm=ajPName(d,uid);
        const v=await sheetAsk({ anchor:b, title:nm, choices:[{ value:'lead', label:cur.role==='lead'?'tornar membro':'tornar lead' },{ value:'rm', label:'tirar deste time', danger:true }], ok:'continuar' }); if(!v) return;
        if(v==='lead'){ await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid,{ method:'PATCH', body:JSON.stringify({ role:cur.role==='lead'?'member':'lead' }) }); cloudMsg='✓ papel atualizado'; }
        if(v==='rm'){ if(!await sheetAsk({ anchor:b, title:'Tirar '+nm+' deste time?', ok:'tirar do time', danger:true })) return; await sbFetch('/rest/v1/team_members?team_id=eq.'+tid+'&user_id=eq.'+uid,{ method:'DELETE' }); cloudMsg='✓ removido do time'; }
        after(); return; }
    }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui alterar o time'); after(); }
  });
  host.querySelectorAll('[data-ajorgrm]').forEach(b=>b.onclick=async()=>{ const uid=b.dataset.ajorgrm, nm=ajPName(d,uid);
    if(!await sheetAsk({ anchor:b, title:'Tirar '+nm+' da organização?', text:'A pessoa sai de todos os times e libera o assento. As tarefas dela continuam no histórico.', ok:'tirar da organização', danger:true })) return;
    try{ for(const t of d.teams){ await sbFetch('/rest/v1/team_members?team_id=eq.'+t.id+'&user_id=eq.'+uid,{ method:'DELETE' }).catch(()=>{}); } await sbFetch('/rest/v1/org_members?org_id=eq.'+d.org.id+'&user_id=eq.'+uid,{ method:'DELETE' }); cloudMsg='✓ '+nm+' saiu da organização'; }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui tirar da organização'); } after(); });
}
let ajInvLast=null;
async function ajRenderConvites(host){
  const d=await ajCloudReady(host, 'convites', ''); if(!d) return;
  if(!d.org){ host.innerHTML=ajSecHead('convites','')+ajStateHtml('semorg'); ajStateWire(); return; }
  const me=ajMe(), isAdmin=d.meRole==='owner'||d.meRole==='admin';
  const myLead=d.teams.filter(t=>(d.teamMembers[t.id]||[]).some(m=>m.user_id===me&&m.role==='lead'));
  const invTeams=isAdmin?d.teams:myLead;
  const st=ajInviteState(isAdmin||myLead.length>0, invTeams);
  const seatsUsed=(d.orgMembers||[]).length, seatsFree=Math.max(0,(d.org.seats||0)-seatsUsed);
  const lead=`Para quem ainda não tem conta. O convite só funciona com o e-mail convidado. <b>${seatsFree} ${seatsFree===1?'assento livre':'assentos livres'}</b>.`;
  if(st==='none'){ host.innerHTML=ajSecHead('convites','')+ajStateHtml('semperm'); return; }
  if(st==='noteams'){
    host.innerHTML=ajSecHead('convites', lead)+`<div class="ajempty"><span class="eic">${ajIcon('times')}</span><h3>Crie um time antes de convidar</h3><p>Todo convite entra num time, e ${esc(d.org.name)} ainda não tem nenhum. Leva 10 segundos: dê um nome e você vira o lead.</p><div class="acts"><button type="button" class="btn primary sm" id="ajFirstTeam">criar o primeiro time</button><button type="button" class="btn sm" data-ajgo="times">quem já tem conta? ver Times e pessoas</button></div></div>`;
    bindClick('ajFirstTeam', async()=>{ const b=$id('ajFirstTeam'); const n=await sheetAsk({ anchor:b, title:'Primeiro time', field:{ placeholder:'nome do time' }, ok:'criar time' }); if(!n) return;
      try{ const rows=await sbPost('teams',{ org_id:d.org.id, name:n }); await sbPost('team_members',{ team_id:rows[0].id, user_id:me, role:'lead' }); lsSet('sb:team', rows[0].id); cloudMsg='✓ time criado — agora dá pra convidar'; }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui criar o time'); } cloudData=null; ajSectionPaint(); });
    host.querySelectorAll('[data-ajgo]').forEach(b=>b.onclick=()=>ajGo(b.dataset.ajgo)); return;
  }
  const teamId=cloudTeamId();
  const expTxt=iv=>{ if(!iv.expires_at) return 'sem validade'; const ms=new Date(iv.expires_at)-Date.now(); if(!(ms>0)) return 'vencido'; const n=Math.max(1,Math.round(ms/86400e3)); return 'expira em '+n+(n===1?' dia':' dias'); };
  host.innerHTML=ajSecHead('convites', lead)+ajCloudMsg()
    +`<div class="ajinv"><input class="in" id="sbInvEmail" type="email" aria-label="e-mail do convidado" placeholder="email@empresa.com"><select class="in" id="sbInvTeam" aria-label="time do convite">${invTeams.map(t=>`<option value="${escA(t.id)}"${t.id===teamId?' selected':''}>${esc(t.name)}</option>`).join('')}</select><select class="in" id="sbInvRole" aria-label="papel do convidado"><option value="member">membro</option><option value="lead">lead</option></select><button type="button" class="btn primary sm" id="sbInvite">gerar convite</button></div>
    <div id="sbInvOut"></div>`
    +((d.invites||[]).length?`<h3 class="ajh3">Pendentes (${d.invites.length})</h3><div class="ajlist">${d.invites.map(iv=>`<div class="ajli"><span class="ajav">@</span><div class="l"><b>${esc(iv.email)}</b><small>${esc((d.teams.find(x=>x.id===iv.team_id)||{}).name||'?')} · ${iv.role==='lead'?'lead':'membro'} · ${expTxt(iv)}</small></div><span class="r"><button type="button" class="btn sm" data-ajiv="copy" data-iv="${escA(iv.id)}">copiar mensagem</button><button type="button" class="btn sm" data-ajiv="rev" data-iv="${escA(iv.id)}">revogar</button></span></div>`).join('')}</div>`:'');
  const out=$id('sbInvOut');
  const invErr=m=>{ out.innerHTML=`<div class="ajband warn" role="alert">${esc(m)}</div>`; const i=$id('sbInvEmail'); if(i) i.focus(); };
  if(ajInvLast){ const { mail, msg }=ajInvLast; ajInvLast=null; out.innerHTML=`<div class="ajband ok">Convite gerado pra <b>${esc(mail)}</b>. Mande a mensagem pronta:</div><pre class="ajmsg">${esc(msg)}</pre><button type="button" class="btn sm" id="sbInvCopy">copiar mensagem</button>`; bindClick('sbInvCopy', function(){ cloudCopy(msg, this); }); }
  { const i=$id('sbInvEmail'); i.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); $id('sbInvite').click(); } }; }
  bindClick('sbInvite', async()=>{ const b=$id('sbInvite'); if(b.disabled) return;
    const mail=$id('sbInvEmail').value.trim().toLowerCase();
    if(!mail) return invErr('Digite o e-mail da pessoa que você quer convidar.');
    if(typeof authValidEmail==='function' && !authValidEmail(mail)) return invErr('Esse e-mail não parece válido — confira se está completo (ex.: ana@empresa.com).');
    if(cloudInvitePending(d.invites, mail, Date.now())) return invErr('Já existe um convite pendente pra '+mail+' — use “copiar mensagem” na lista abaixo.');
    if(seatsUsed>=d.org.seats) return invErr('Todos os '+d.org.seats+' assentos estão em uso — libere um assento ou amplie o plano antes de convidar.');
    b.disabled=true;
    try{ const tid=$id('sbInvTeam').value; const rows=await sbPost('invites',{ org_id:d.org.id, team_id:tid, email:mail, role:$id('sbInvRole').value, created_by:me });
      // o servidor pode gravar e NÃO devolver a linha (RLS do SELECT): relê a lista e acha o convite pelo e-mail
      let iv=ajInvRow(rows, mail, tid);
      if(!iv){ cloudData=null; const d2=await ajCloudReady(host, 'convites', '').catch(()=>null); iv=ajInvRow(d2&&d2.invites, mail, tid); }
      if(!iv){ cloudMsg='✓ convite gravado pra '+mail+' — a mensagem pronta está na lista de pendentes (copiar mensagem). Se não aparecer, atualize a seção.'; ajSectionPaint(); return; }
      if(cloudData && cloudData.invites && !cloudData.invites.includes(iv)) cloudData.invites.push(iv); else if(!cloudData) (d.invites||(d.invites=[])).push(iv);
      ajInvLast={ mail, msg:cloudInviteMsg((d.teams.find(x=>x.id===tid)||{}).name||'', d.org.name, mail, iv.token) }; ajSectionPaint(); }
    catch(e){ invErr(cloudErrMsg(e,'Não consegui gerar o convite')); b.disabled=false; } });
  host.querySelectorAll('[data-ajiv]').forEach(b=>b.onclick=async()=>{ const iv=(d.invites||[]).find(x=>x.id===b.dataset.iv); if(!iv) return;
    if(b.dataset.ajiv==='copy'){ cloudCopy(cloudInviteMsg((d.teams.find(x=>x.id===iv.team_id)||{}).name||'', d.org.name, iv.email, iv.token), b); return; }
    if(!await sheetAsk({ anchor:b, title:'Revogar o convite?', text:'O convite de '+iv.email+' para de funcionar na hora.', ok:'revogar', danger:true })) return;
    try{ await sbFetch('/rest/v1/invites?id=eq.'+iv.id,{ method:'DELETE' }); cloudMsg='✓ convite revogado'; }catch(e){ cloudMsg=cloudErrMsg(e,'Não consegui revogar o convite'); } cloudData=null; ajSectionPaint(); });
}
async function ajRenderRegras(host){
  const d=await ajCloudReady(host, 'regras', ''); if(!d) return;
  if(!d.org){ host.innerHTML=ajSecHead('regras','')+ajStateHtml('semorg'); ajStateWire(); return; }
  if(typeof orgRulesRender==='function') return orgRulesRender(host, d);
}
async function ajRenderAssinatura(host){
  const d=await ajCloudReady(host, 'assinatura', ''); if(!d) return;
  const b=typeof myBilling!=='undefined'?myBilling:null;
  // cobrança só é "desligada" se a tabela de planos foi LIDA; falha de leitura não vira "Uso livre"
  const off=(typeof billingKnown!=='undefined' && !billingKnown) ? 'unknown' : (typeof billingOn!=='undefined' && !billingOn);
  const L=ajBillingLine(b, ajMe(), null, off);
  const canPortal=!!(b && !b.org && b.user_id===ajMe() && b.stripe_customer_id);
  host.innerHTML=ajSecHead('assinatura','')
    +`<div class="ajplan"><div class="l"><b>${esc(L.name)}</b> ${L.unknown?'':L.free?'<span class="ajst ok">livre</span>':L.active?'<span class="ajst ok">ativo</span>':'<span class="ajst warn">inativo</span>'}<p>${esc(L.sub)}${L.org&&d.org?' · '+esc(d.org.name):''}</p></div>
      <div class="r">${canPortal?'<button type="button" class="btn sm" id="sbBillPortal">gerenciar no portal de pagamento</button>':''}${L.org?'<button type="button" class="btn sm" id="ajSupport">falar com o suporte</button>':''}${L.unknown?'<button type="button" class="btn sm" id="ajBillRetry">tentar de novo</button>':''}${!L.active&&!L.free&&!L.unknown?'<button type="button" class="btn primary sm" id="sbBillGo">ver planos</button>':''}</div></div>`;
  bindClick('sbBillPortal', ()=>payPortal($id('sbBillPortal')));
  bindClick('ajBillRetry', async()=>{ try{ await billingSync(); }catch(_){ } ajSectionPaint(); });
  bindClick('sbBillGo', ()=>{ if(typeof auShow==='function') auShow('plans', { backTo:()=>ajustesOpen('assinatura') }); });
  bindClick('ajSupport', ()=>{ if(typeof openExternal==='function') openExternal('mailto:suporte@starfork.com.br?subject=Assinatura%20Starfork'); });
}
const AJ_RENDER={ motores:ajRenderMotores, custo:ajRenderCusto, modo:ajRenderModo, aparencia:ajRenderAparencia, aprendizado:ajRenderAprendizado, github:ajRenderGithub,
  verificacao:ajRenderVerificacao, notificacoes:ajRenderNotif, versao:ajRenderVersao, disco:ajRenderDisco, sistema:ajRenderSistema,
  perfil:ajRenderPerfil, org:ajRenderOrg, times:ajRenderTimes, convites:ajRenderConvites, regras:ajRenderRegras, assinatura:ajRenderAssinatura };
// a conta mudou (renderCloud antigo, login, sair): redesenha só se Ajustes estiver numa seção da conta
function ajustesRefreshConta(){ if(ajSec(AJ.sec).grp==='conta' && $id('ajContent')) ajSectionPaint(); }
window.ajustesRefreshConta=ajustesRefreshConta;

// ============================================================ Verificação: faixa na Central + selo (não abre mais sozinha)
function ajEnvBadge(){ const n=$id('ajNav'); if(n && document.activeElement!==$id('ajQ')) ajNavPaint(); }
function ajEnvBand(){
  const pane=$id('flowPane'); if(!pane) return;
  let el=$id('ajEnvBand');
  const S=(typeof envChecks!=='undefined'&&envChecks&&typeof envSummary==='function')?envSummary(envChecks):null;
  if(!S || !S.reqBad || lsGet('envBandHide')===String(envCheckedAt)){ if(el) el.remove(); return; }
  if(!el){ el=document.createElement('div'); el.id='ajEnvBand'; el.className='ajband warn ajenvband'; el.setAttribute('role','status'); pane.prepend(el); }
  el.innerHTML=`${ajIcon('warn')}<span><b>${S.reqBad} ${S.reqBad===1?'pendência':'pendências'} neste computador</b> — as tarefas podem falhar até resolver.</span><span class="r"><button type="button" class="btn sm primary" id="ajEnvGo">resolver</button><button type="button" class="btn sm quiet" id="ajEnvHide" aria-label="esconder até a próxima verificação">depois</button></span>`;
  bindClick('ajEnvGo', ()=>ajustesOpen('verificacao'));
  bindClick('ajEnvHide', ()=>{ lsSet('envBandHide', String(envCheckedAt)); ajEnvBand(); });
}
window.ajEnvBand=ajEnvBand;

// ============================================================ Primeiros passos (aba)
const PP={ open:'', ia:false };
function ppCtx(){
  const S=(typeof envChecks!=='undefined'&&envChecks&&typeof envSummary==='function')?envSummary(ppPcList(envChecks)):null;
  const d=typeof aiDefaults==='function'?aiDefaults():{ eng:'claude' };
  const ia=Array.isArray(typeof suaIaList!=='undefined'?suaIaList:null) && typeof suaIaOf==='function' && !!(suaIaOf(d.eng)||{}).ready;
  const inOrg=typeof cloudData!=='undefined' && !!(cloudData&&cloudData.org);
  const invited=inOrg && (((cloudData.invites||[]).length>0) || (cloudData.orgMembers||[]).length>1);
  return { envOk:S?S.reqBad===0:null, iaReady:ia, hasRepo:!!(typeof state!=='undefined'&&state.repo), tasks:(typeof state!=='undefined'&&state.tasks||[]).length, invited, inOrg };
}
const PP_TOUR=[
  ['newTaskBtn','Tudo começa em Nova demanda','descreva o que precisa em 1 ou 2 frases'],
  ['rail','Demandas ao vivo na lateral','contorno = aguardando você · amarelo = pronta pra revisar'],
  ['planMeter','Quanto já gastou','o medidor abre a página Uso'],
  [null,'Busca em tudo','⌘K em qualquer lugar'],
];
function primeirosPassosOpen(){
  lsSet('onboarded','1');
  PP.open=PP.open||(ppSteps(ppCtx()).next||'pc');
  ppRender();
  if(window.openTab) window.openTab('primeiros'); else { const o=$id('ppOverlay'); if(o) o.style.display='flex'; }
}
window.primeirosPassosOpen=primeirosPassosOpen;
function ppRender(){
  const body=$id('ppBody'); if(!body) return;
  const c=ppCtx(), P=ppSteps(c);
  const nextStep=P.steps.find(s=>s.id===P.next);
  const head=(typeof pageHead==='function')?pageHead({ title:'Primeiros passos', scope:'computador',
      sum:`<b>${P.done} de ${P.total}</b> feitos <span class="pp-prog" aria-hidden="true"><i style="width:${Math.round(P.done/P.total*100)}%"></i></span>`,
      sub:'O mínimo pra primeira demanda rodar. Faça na ordem que quiser: cada passo se marca sozinho quando fica pronto.',
      primary:nextStep?{ label:'Continuar: '+nextStep.t.charAt(0).toLowerCase()+nextStep.t.slice(1), id:'ppNext' }:null, more:{ id:'ppMore', title:'Mais ações' } })
    :`<header class="pghead"><h1 class="pgh-title">Primeiros passos</h1></header>`;
  const stepHtml=(s,i)=>{ const open=PP.open===s.id;
    return `<article class="ppst${s.done?' done':''}${open?' open':''}" data-ppst="${s.id}"><button type="button" class="pph" aria-expanded="${open}" data-pptog="${s.id}"><span class="ppn">${s.done?ajIcon('ok'):i+1}</span><span class="l"><b>${esc(s.t)}${s.opt?' <span class="ajtag">opcional</span>':''}</b><small>${esc(ppStepSub(s,c))}</small></span><span class="ppchev" aria-hidden="true">▾</span></button>${open?`<div class="ppb" id="ppB-${s.id}"></div>`:''}</article>`; };
  body.innerHTML=head+`<div class="ppgrid"><div class="ppsteps">${P.steps.map(stepHtml).join('')}</div>
    <aside class="ppside"><section class="ajcard"><h3 class="ajh3">O que é o Starfork</h3><p>Agentes de IA trabalham nas suas demandas, cada uma numa cópia isolada do projeto.</p><p>Cada requisito precisa de uma prova real (print, vídeo, teste) antes de entregar.</p><p>O time vê o andamento e o custo na nuvem. A conversa com a IA fica neste computador.</p></section>
      <section class="ajcard"><h3 class="ajh3">Conhecer o app</h3>${PP_TOUR.map(([id,t,d],i)=>`<div class="pptour"><div class="l"><b>${esc(t)}</b><small>${esc(d)}</small></div>${id?`<button type="button" class="btn sm" data-ppshow="${i}">mostrar</button>`:'<kbd>⌘K</kbd>'}</div>`).join('')}</section></aside></div>`;
  body.querySelectorAll('[data-pptog]').forEach(b=>b.onclick=()=>{ PP.open=PP.open===b.dataset.pptog?'':b.dataset.pptog; ppRender(); });
  body.querySelectorAll('[data-ppshow]').forEach(b=>b.onclick=()=>ppShow(PP_TOUR[+b.dataset.ppshow]));
  bindClick('ppNext', ()=>{ PP.open=P.next; ppRender(); const el=document.querySelector('[data-ppst="'+P.next+'"]'); if(el&&el.scrollIntoView) el.scrollIntoView(scrollOpts('nearest')); });
  bindClick('ppMore', async()=>{ const b=$id('ppMore'); const v=await sheetAsk({ anchor:b, title:'Primeiros passos', choices:[{ value:'hide', label:'dispensar', hint:'some do caminho; volta em Ajustes › Sistema' }], ok:'ok' }); if(v==='hide'){ lsSet('pp:dismissed','1'); if(typeof closeTabOfKind==='function') closeTabOfKind('primeiros'); } });
  if(PP.open) ppStepBody(PP.open, c);
}
function ppStepSub(s, c){
  if(s.id==='pc'){ if(c.envOk===null) return 'verificando o computador…'; const S=envSummary(ppPcList(envChecks)); return s.done?(S.optBad?S.okN+' de '+S.tot+' ok · '+S.optBad+(S.optBad===1?' opcional faltando':' opcionais faltando'):'tudo certo'):S.reqBad+(S.reqBad===1?' pendência — veja abaixo':' pendências — veja abaixo'); }
  if(s.id==='ia' && s.done && typeof aiRunLabel==='function'){ const d=aiDefaults(); return 'vai usar: '+aiRunLabel(d.eng, d.model); }
  if(s.id==='proj' && s.done) return 'projeto aberto: '+pathBase(state.repo);
  return s.d;
}
function ppStepBody(id, c){
  const h=$id('ppB-'+id); if(!h) return;
  if(id==='pc'){
    if(c.envOk===null){ h.innerHTML='<p class="dim">verificando…</p>'; runEnvCheck().then(()=>ppRender()).catch(()=>{}); return; }
    const bad=ppPcItems(envChecks, typeof envKind==='function'?envKind:null);
    h.innerHTML=(bad.length?bad.map(x=>`<div class="ppline"><b>${esc(x.name)}</b>${ENV_KIND_TAG[x.kind]?` <span class="ajtag">${ENV_KIND_TAG[x.kind]}</span>`:''} <span class="dim">${esc(envWhat(x.c)||'')}</span>${envFixLines(x.c.fix).filter(f=>f.cmd).slice(0,1).map(f=>`<div class="ajcmdrow"><code class="ajcmd">${esc(f.text)}</code><button type="button" class="btn sm" data-envfix="${escA(f.text)}">copiar</button></div>`).join('')}</div>`).join(''):'<p>Tudo que é obrigatório está instalado.</p>')
      +'<div class="ajacts"><button type="button" class="btn sm" id="ppEnv">ver Verificação</button><button type="button" class="btn sm" id="ppEnvRe">verificar de novo</button></div>';
    h.querySelectorAll('[data-envfix]').forEach(b=>b.onclick=()=>envCopy(b));
    bindClick('ppEnv', ()=>ajustesOpen('verificacao')); bindClick('ppEnvRe', ()=>{ envChecks=null; runEnvCheck().then(()=>ppRender()); ppRender(); });
  } else if(id==='ia'){
    h.innerHTML='<div id="ppSuaIa"></div><p class="ajhint">Nunca usou o Terminal? Clique em <b>copiar</b>, abra o Terminal do computador (no Windows, o PowerShell), cole o comando e aperte Enter — ou peça ajuda a quem cuida dos computadores na empresa. Se a sua empresa tem uma IA própria, <b>IA da sua empresa</b> não precisa instalar nada.</p><p class="ajhint">Dá pra trocar depois em Ajustes › Motores e chaves.</p>';
    if(typeof suaIaMount==='function') // a escolha (ou a ÚNICA IA pronta quando o padrão não está) vira o padrão na hora — o passo se marca sozinho
    suaIaMount($id('ppSuaIa'), { ctx:'onboarding', fresh:true, onPick:(pid)=>{ if(pid && typeof suaIaObApply==='function' && suaIaObApply()) setTimeout(ppRender, 50); } });
  } else if(id==='proj'){
    h.innerHTML=`<p>${c.hasRepo?'Projeto aberto: <b>'+esc(pathBase(state.repo))+'</b>.':'Abra uma pasta que já existe (com git) ou comece um projeto novo na Fábrica.'}</p><div class="ajacts"><button type="button" class="btn sm" id="ppOpenDir">${c.hasRepo?'abrir outra pasta':'abrir uma pasta'}</button><button type="button" class="btn sm" id="ppFab">criar na Fábrica</button></div>`;
    bindClick('ppOpenDir', async()=>{ try{ if(window.pickFolder) await window.pickFolder(); }catch(_){ } ppRender(); });
    bindClick('ppFab', ()=>{ if(typeof fabOpen==='function') fabOpen(); });
  } else if(id==='dem'){
    h.innerHTML='<p>Descreva o que precisa em 1 ou 2 frases. O planejador monta os requisitos com você antes de rodar.</p><div class="ajacts"><button type="button" class="btn primary sm" id="ppNova">nova demanda</button></div>';
    bindClick('ppNova', ()=>{ if(window.openTab) window.openTab('nova'); });
  } else if(id==='conv'){
    h.innerHTML=`<p>${c.inOrg?'Convide quem ainda não tem conta; quem já tem entra com “adicionar ao time”.':'Pra convidar, você precisa estar numa organização.'}</p><div class="ajacts"><button type="button" class="btn sm" id="ppInv">${c.inOrg?'convidar':'ver Times e pessoas'}</button></div>`;
    bindClick('ppInv', ()=>ajustesOpen(c.inOrg?'convites':'times'));
  }
}
// "mostrar": destaca o lugar REAL (contorno + balão curto), some no clique ou em 4 s
function ppShow(item){
  const [id,t]=item; const el=id&&$id(id); if(!el || el.offsetParent===null){ toast('Esse lugar não está na tela agora (abra um projeto ou mostre a lateral).','info'); return; }
  document.querySelectorAll('.pphi').forEach(x=>x.classList.remove('pphi')); document.querySelectorAll('.pptip').forEach(x=>x.remove());
  el.classList.add('pphi'); const r=el.getBoundingClientRect();
  const tip=document.createElement('div'); tip.className='pptip'; tip.setAttribute('role','status'); tip.textContent=t;
  tip.style.top=Math.min(window.innerHeight-60, r.bottom+8)+'px'; tip.style.left=Math.max(8, Math.min(window.innerWidth-260, r.left))+'px';
  document.body.appendChild(tip);
  const off=()=>{ el.classList.remove('pphi'); tip.remove(); document.removeEventListener('click', off, true); };
  setTimeout(()=>document.addEventListener('click', off, true), 50); setTimeout(off, 4000);
}
// 1º uso: abre a aba UMA vez (com sessão e sem a tela de entrada por cima) — substitui o tour modal e as coach marks
function ppMaybeStart(){
  if(lsGet('onboarded') || lsGet('pp:dismissed')) return;
  if(typeof SB==='undefined' || !SB.sess()) return;
  if(typeof auOpen==='function' && auOpen()) return;
  primeirosPassosOpen();
}
window.obMaybeStart=ppMaybeStart;
// boot: só abre se a pessoa ainda está na Central — antes trocava a aba que ela tinha acabado de abrir (ex.: Ajustes › GitHub)
setTimeout(()=>{ if(ppAutoOk(typeof activeTab!=='undefined'?activeTab:'')) ppMaybeStart(); }, 3800);

// ============================================================ aba "Detalhes do erro"
function errTabOpen(h){
  h=h||{}; const body=$id('errTabBody'); if(!body) return;
  const head=(typeof pageHead==='function')?pageHead({ title:'Detalhes do erro', sub:h.msg||'' }):`<h1>Detalhes do erro</h1>`;
  body.innerHTML=head+`<div class="errtab"><pre class="ajraw" id="errTabRaw">${esc(h.raw||'(sem detalhe)')}</pre><div class="ajacts">${h.action&&h.action.label?'<button type="button" class="btn primary sm" id="errTabFix"></button>':''}<button type="button" class="btn sm" id="errTabCopy">copiar</button></div></div>`;
  if(h.action&&h.action.label){ const b=$id('errTabFix'); b.textContent=h.action.label; b.onclick=()=>{ if(typeof h.action.fn==='function') h.action.fn(); }; }
  bindClick('errTabCopy', function(){ const b=this; try{ navigator.clipboard.writeText(h.raw||'').then(()=>{ b.textContent='copiado ✓'; },()=>{ b.textContent='selecione e copie'; }); }catch(_){ b.textContent='selecione e copie'; } });
  if(window.openTab) window.openTab('errtab'); else { const o=$id('errTabOverlay'); if(o) o.style.display='flex'; }
}
window.errTabOpen=errTabOpen;
