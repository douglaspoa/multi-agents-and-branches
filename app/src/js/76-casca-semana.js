// Starfork — 76-casca-semana: a CASCA "Semana" (mock aprovado pelo dono em 14/10 — mesa-semana-app.md §1–§2, §6–§7).
// A lateral ganha 3 grupos com nome:
//   topo      — seletor do projeto atual + Nova demanda ⌘N
//   TRABALHO  — Meu trabalho · Semana do time · Entregas · Issues (do painel conectado) e "Abertas" (a lista de demandas)
//   PADRÕES DO TIME (recolhível) — Projetos · Agentes · Skills · Memória, cada um com subtítulo
//   CONTA (fixa embaixo) — Pessoas · Ajustes ⌘, · Onde fica cada coisa (?)
// Só o miolo rola: o rodapé fica sempre visível a 1000×700. Fábrica e Ideia saíram da lateral (portas novas:
// Projetos › Adicionar repo › "Começar um app do zero" e Nova demanda › "Ainda é uma ideia").
// Páginas novas (abas, nunca modal): Meu trabalho ('meu'), Semana do time ('semana'), Entregas ('entregas') e Onde fica
// cada coisa ('mapa', com o guia passo a passo). É redesenho da PORTA: as regras continuam nas fontes únicas —
// situação = tsSt/tsBucket/taskSt/flowBucket (STATUS_META), travada = entTravada/entTravaTx (70), entregue + carimbo =
// epDelivered/diaItensDe/diaStampsLoad (46/72), pessoa = personName/personAv (08), responsável = tsClaimOnly/cloudAssign/
// tmCanAssignNow (42/43), dados do time = teamFetch/teamTasks/teamActivity (42). Sem polling novo: pinta no render()
// que já existe, só a aba visível, com guarda de HTML (não reescreve o DOM quando nada mudou).
// Dentro de uma tarefa a lateral vira as etapas: quem desenha é 77-tarefa-etapas.js (sideTaskMode); a lateral de etapas é
// outra frente).

// ---------- ícones (traço de linha 16px, o mesmo do IC) ----------
const SEM_IC={
  home:'<path d="M2.6 7.4 8 2.9l5.4 4.5V13a.6.6 0 0 1-.6.6H9.6V10H6.4v3.6H3.2a.6.6 0 0 1-.6-.6z" stroke-linejoin="round"/>',
  cal:'<rect x="2.5" y="3.4" width="11" height="10.1" rx="1.4"/><path d="M2.5 6.6h11M5.4 2v2.6M10.6 2v2.6" stroke-linecap="round"/>',
  box:'<path d="M2.6 5 8 2.4 13.4 5v6L8 13.6 2.6 11z" stroke-linejoin="round"/><path d="M2.6 5 8 7.6 13.4 5M8 7.6v6" stroke-linejoin="round"/>',
  issue:'<circle cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  folder:'<path d="M2 4.4c0-.4.3-.7.7-.7h3l1.3 1.5h6.3c.4 0 .7.3.7.7v6.4c0 .4-.3.7-.7.7H2.7c-.4 0-.7-.3-.7-.7z" stroke-linejoin="round"/>',
  bot:'<rect x="3" y="5" width="10" height="7.6" rx="2"/><path d="M8 2.6V5M6 8.4h.05M10 8.4h.05" stroke-linecap="round"/>',
  wand:'<path d="M3 13 10.4 5.6M9.2 4.4l2.4 2.4" stroke-linecap="round"/><path d="M12.4 1.9v1.8M13.3 2.8h-1.8M4.6 2.6v1.4M5.3 3.3H3.9M13.4 8.6v1.4M14.1 9.3h-1.4" stroke-linecap="round"/>',
  book:'<path d="M4 2.6h7.6c.4 0 .8.3.8.8v10H4.8a1.2 1.2 0 0 1-1.2-1.2V3.4c0-.5.3-.8.4-.8z" stroke-linejoin="round"/><path d="M3.6 12.2c0-.7.5-1.2 1.2-1.2h7.6M6.4 5.4h3.6" stroke-linecap="round"/>',
  people:'<circle cx="6" cy="6" r="2.3"/><path d="M2.4 12.6c0-2 1.7-3.1 3.6-3.1s3.6 1.1 3.6 3.1"/><path d="M10.6 4.1a2.15 2.15 0 0 1 0 4.05M11.2 9.6c1.6.15 2.7 1.15 2.7 2.9" stroke-linecap="round"/>',
  gear:'<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8M4 4l1.3 1.3M10.7 10.7L12 12M12 4l-1.3 1.3M5.3 10.7L4 12" stroke-linecap="round"/>',
  search:'<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6" stroke-linecap="round"/>',
  plus:'<path d="M8 3.4v9.2M3.4 8h9.2" stroke-linecap="round"/>',
  proto:'<rect x="2" y="2.8" width="12" height="10.4" rx="1.4"/><path d="M2 6h12M5.6 6v7.2"/>',
  term:'<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M4.6 6.4 6.6 8l-2 1.6M8 10h3" stroke-linecap="round" stroke-linejoin="round"/>',
  code:'<path d="M5.6 4.6 2.4 8l3.2 3.4M10.4 4.6 13.6 8l-3.2 3.4" stroke-linecap="round" stroke-linejoin="round"/>',
  shield:'<path d="M8 1.9l4.7 1.8v3.6c0 3.1-2.1 5.5-4.7 6.8-2.6-1.3-4.7-3.7-4.7-6.8V3.7z" stroke-linejoin="round"/>',
  eye:'<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2"/>',
  alert:'<path d="M8 2.3 14 13H2z" stroke-linejoin="round"/><path d="M8 6.4v3M8 11.2v.05" stroke-linecap="round"/>',
  chev:'<path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  check:'<path d="M3.4 8.4 6.5 11.4 12.6 4.8" stroke-linecap="round" stroke-linejoin="round"/>',
  undo:'<path d="M5.6 3.6 2.6 6.6l3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.8 6.6h6.4a3.6 3.6 0 0 1 0 7.2H7" stroke-linecap="round"/>',
  play:'<path d="M5 3.4v9.2L12.4 8z" stroke-linejoin="round"/>',
  copy:'<rect x="5.2" y="5.2" width="8" height="8.4" rx="1.4"/><path d="M10.6 5.2V3.6c0-.6-.4-1-1-1H3.8c-.6 0-1 .4-1 1v6.2c0 .6.4 1 1 1h1.4" stroke-linejoin="round"/>',
  spark:'<path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8 6.7 6.7z" stroke-linejoin="round"/>',
  arrowR:'<path d="M3 8h9.4M8.8 4.4 12.4 8l-3.6 3.6" stroke-linecap="round" stroke-linejoin="round"/>',
};
function semIc(k, cls){ return `<svg class="semi${cls?' '+cls:''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" aria-hidden="true">${SEM_IC[k]||''}</svg>`; }

// @semana-puro-inicio (testado em app/tests/casca-semana.test.mjs)
const SEM_DIAS_PT=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const SEM_DIAS_LONGO=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
const SEM_MESES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function semDia0(ms){ const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function semKeyDia(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
// dias úteis da semana de `now` (seg–sex); sábado/domingo entram só quando são HOJE (dá pra trabalhar no fim de semana)
// → [{ ms, key, lbl:'Qua', num:'14', kind:'past'|'today'|'fut' }]
function semDiasDaSemana(now){
  const t0=semDia0(now||Date.now()), w=new Date(t0).getDay();
  const seg=t0-((w+6)%7)*86400000, out=[];
  for(let i=0;i<7;i++){
    const d=new Date(seg); d.setDate(d.getDate()+i); const ms=d.getTime(), wd=d.getDay();
    if((wd===0||wd===6) && ms!==t0) continue;
    out.push({ ms, key:semKeyDia(ms), lbl:SEM_DIAS_PT[wd], num:String(d.getDate()), kind:ms<t0?'past':ms===t0?'today':'fut' });
  }
  return out;
}
// "12 a 16 de outubro" (mesmo mês) · "29 de setembro a 3 de outubro"
function semIntervaloTx(dias){
  if(!dias||!dias.length) return '';
  const a=new Date(dias[0].ms), b=new Date(dias[dias.length-1].ms);
  return a.getMonth()===b.getMonth()?`${a.getDate()} a ${b.getDate()} de ${SEM_MESES[b.getMonth()]}`:`${a.getDate()} de ${SEM_MESES[a.getMonth()]} a ${b.getDate()} de ${SEM_MESES[b.getMonth()]}`;
}
// "Quarta, 14 de outubro"
function semHojeTx(now){ const d=new Date(now||Date.now()); const s=SEM_DIAS_LONGO[d.getDay()]; return s.charAt(0).toUpperCase()+s.slice(1)+', '+d.getDate()+' de '+SEM_MESES[d.getMonth()]; }
// colunas da grade: pessoa + dias; HOJE é largo e os outros dias ficam recolhidos (58px) — o dia aberto também fica largo.
// Sem rolagem lateral: tudo em minmax(0, …)
function semColunas(dias, aberto){ return ['minmax(110px,150px)', ...dias.map(d=>(d.kind==='today'||d.key===aberto)?'minmax(0,1fr)':'58px')].join(' '); }
// opções do menu Passar/Atribuir de UM bloco, numeradas 1…n sem buraco (a mesa pediu); 0 = devolver.
// o = { me, cur (responsável atual ou ''), pessoas:[uid…] (time, na ordem da grade), podeOutros (líder/admin), local (só desta máquina) }
// → [{ k:'1', uid, eu:bool, off:bool, why }] + { k:'0', devolver:true } quando tem responsável
function semMenuOpcoes(o){
  o=o||{}; const out=[]; let n=0;
  if(o.local) return out; // demanda só desta máquina: não tem cartão no time pra passar
  const lista=[o.me, ...(o.pessoas||[]).filter(u=>u&&u!==o.me)].filter(Boolean);
  for(const uid of lista){
    if(uid===o.cur) continue;
    const eu=uid===o.me;
    const off=eu ? (!!o.cur && !o.podeOutros) : !o.podeOutros;
    out.push({ k:String(++n), uid, eu, off, why:off?(eu?'está com outra pessoa — peça pra devolver, ou ao líder do time':'só o líder do time ou um admin passa pra outra pessoa'):'' });
    if(n>=9) break;
  }
  if(o.cur) out.push({ k:'0', devolver:true, off:!(o.cur===o.me || o.podeOutros), why:(o.cur===o.me||o.podeOutros)?'':'só quem está com ela ou o líder devolve' });
  return out;
}
// motivo de devolver: pelo menos 3 palavras (o mock pede; "não sei" não explica nada pra quem pega depois)
function semMotivoOk(s){ return String(s||'').trim().split(/\s+/).filter(w=>w.length>1).length>=3; }
// relatório "pronto pra colar" (texto puro pt-BR, sem markdown): linhas = [{ quem, titulo, pr, provas }]
function semRelatorioTx(o){
  const L=o.itens||[], pes=new Set(L.map(x=>x.quem)).size;
  const head=`${o.periodo} · ${o.projeto||'todos os projetos'} · ${L.length} ${L.length===1?'entrega':'entregas'}, ${pes} ${pes===1?'pessoa':'pessoas'}.`;
  const lin=L.map(x=>`• ${x.quem}: ${x.titulo}${x.pr?' (PR #'+x.pr+(x.provas?', '+x.provas+' com prova':'')+')':''}`);
  const par=(o.parados||[]).length?['Parado: '+o.parados.join(' · ')+'.']:[];
  return [head, ...lin, ...par].join('\n');
}
// épicos ENTREGUES nos dias da grade (spec.delivery gravado pelo "Entregar o épico" de 81-epico-aba): um bloco de épico
// no dia da entrega, com quem aprovou. eps = teamEpics; dias = semDiasDaSemana → [{ id, nome, key, at, by, tarefas, prs }]
function semEpicosEntregues(eps, dias){
  const keys=new Set((dias||[]).map(d=>d.key));
  return (eps||[]).filter(e=>e&&e.spec&&e.spec.delivery&&e.spec.delivery.at).map(e=>{ const d=e.spec.delivery, at=Date.parse(d.at);
    return { id:e.id, nome:String(e.name||'Épico'), key:Number.isFinite(at)?semKeyDia(at):'', at, by:d.by||'', tarefas:+d.tasks||0, prs:+d.prs||0 }; })
    .filter(x=>x.key && keys.has(x.key)).sort((a,b)=>b.at-a.at);
}
// aviso "padrão do time desligado" (sf:padrao-desligado): vale 7 dias; o mais novo ganha. → o aviso ou null
const SEM_PADRAO_MS=7*86400000;
function semPadraoVale(av, now){ if(!av||!av.padrao) return null; const at=+av.at||0; return at && (now||Date.now())-at<SEM_PADRAO_MS ? av : null; }
// o mesmo aviso vindo do TIME (team_events, 0033): linhas de qualquer membro → o mais novo válido, com uid (o nome
// sai de personName na hora de pintar; nunca o id). "abrir" só aceita destinos conhecidos (o corpo vem de outra pessoa).
const SEM_PADRAO_ABRIR=['skills','agentes'];
const semPadraoTx=(v, n)=>String(v==null?'':v).replace(/\s+/g,' ').trim().slice(0, n);
function semPadraoCorpo(d){ d=d||{}; const o={ padrao:semPadraoTx(d.padrao, 160), onde:semPadraoTx(d.onde, 80) };
  if(SEM_PADRAO_ABRIR.includes(d.abrir)) o.abrir=d.abrir; return o; }
function semPadraoDoTime(rows, now){
  const L=(rows||[]).filter(r=>r && r.kind==='padrao-desligado' && r.body && r.user_id).map(r=>{ const c=semPadraoCorpo(r.body);
    return Object.assign(c, { uid:r.user_id, at:Date.parse(r.created_at)||0 }); }).filter(a=>semPadraoVale(a, now));
  return L.sort((a,b)=>b.at-a.at)[0]||null;
}
// local (esta máquina) × time: o mais novo ganha
function semPadraoMaisNovo(a, b, now){ const x=semPadraoVale(a, now), y=semPadraoVale(b, now); return !x?y:!y?x:(y.at>x.at?y:x); }
// o mapa "Onde fica cada coisa": grupos da lateral → [ícone, nome, o que tem, destino]
const MAPA_GRUPOS=[
  ['Trabalho','O dia a dia: pedir, acompanhar, entregar',[
    ['home','Meu trabalho','o que precisa de mim, minha semana e o que mandei pro time','meu'],
    ['cal','Semana do time','quem está com o quê por dia, sem dono, travados; distribuir','semana'],
    ['box','Entregas','o que foi entregue, por dia, com prova; relatório','entregas'],
    ['issue','Issues','pedidos que chegam do painel do time (Jira, Linear, GitHub…); rodar ou mandar pra alguém','issues'],
    ['proto','Protótipos','rascunhar a tela antes do código: desenhar, colar prints, comentar e pedir pra IA corrigir','prototipos'],
    ['plus','Nova demanda (⌘N)','pedir algo e escolher quem faz; ideias também começam aqui','nova']]],
  ['Dentro de uma tarefa','A tarefa abre numa aba; o terminal da IA é o centro',[
    ['term','Conversa','o terminal da IA; tudo que você pergunta ou pede cai aqui',''],
    ['code','Código','o diff com o porquê de cada trecho',''],
    ['shield','Revisão','requisito, prova e o trecho que prova',''],
    ['eye','Prévia','o app rodando no navegador, iPhone ou Android',''],
    ['box','Entrega','comprovante pra mandar a quem pediu','']]],
  ['Padrões do time','Como a IA trabalha aqui (o líder ajusta, todos usam)',[
    ['folder','Projetos','cada repo: regras, provas no PR, issues, como o app sobe; adicionar repo','projetos'],
    ['bot','Agentes','quem planeja, constrói e revisa: papel, modelo, versões','agentes'],
    ['wand','Skills','habilidades extras: catálogo, onde estão ligadas, como usar','skills'],
    ['book','Memória','o que a IA sabe do projeto: notas com autor, buscar e corrigir','memoria']]],
  ['Conta','Você e o time',[
    ['people','Pessoas','convidar, papéis e convites pendentes','pessoas'],
    ['gear','Ajustes (⌘,)','IA e chaves, terminal, notificações, custo, regras da organização','ajustes'],
    ['search','Atalhos','todas as teclas do app','atalhos']]],
];
// "Como faço…?": cada guia é uma lista de passos [texto, seletor do próximo clique (ou ''), destino a abrir antes ('')]
const GUIAS={
  passar:{ t:'Passar uma tarefa travada pra outra pessoa', steps:[
    ['Abra a Semana do time na lateral', '#semanaBtn', ''],
    ['Clique em "Passar ▾" no bloco da tarefa', '.semtb .sem-mn', 'semana'],
    ['Escolha a pessoa (ou aperte o número dela)', '.sempop .sempop-o:not([disabled])', ''],
    ['Pronto: a tarefa aparece na linha da pessoa, e ela é avisada', '', '']] },
  mandar:{ t:'Mandar uma demanda nova pra alguém do time', steps:[
    ['Clique em Nova demanda (⌘N)', '#newTaskBtn', ''],
    ['Escreva o pedido como pediria a um colega', '#plInput', ''],
    ['Monte o plano; no fim, escolha "Mandar pro time" e quem faz', '', ''],
    ['Pronto: a demanda aparece na Semana do time, na linha da pessoa', '', '']] },
  skill:{ t:'Usar uma skill num projeto', steps:[
    ['Abra Skills, em Padrões do time', '#skillsNavBtn', ''],
    ['Ligue a skill no projeto (o interruptor ao lado do nome)', '#skOverlay [role=switch], #skOverlay input[type=checkbox]', ''],
    ['Abra uma tarefa: no terminal, digite /nome-da-skill', '', ''],
    ['Pronto: a skill entra nas tarefas desse projeto', '', '']] },
  memoria:{ t:'Ver e corrigir uma memória', steps:[
    ['Abra Memória, em Padrões do time', '#memoriaBtn', ''],
    ['Busque pelo assunto', '#memQ', ''],
    ['Abra a nota e corrija o texto; salve', '', ''],
    ['Pronto: as próximas tarefas usam a versão nova', '', '']] },
  issues:{ t:'Conectar o painel de issues do time', steps:[
    ['Abra Issues na lateral', '#issuesBtn', ''],
    ['Siga a Conexão: a IA lê a documentação do painel (Jira, Linear, GitHub…) e monta o conector', '', ''],
    ['Pronto: as issues novas aparecem em Issues, com "mandar para"', '', '']] },
  app:{ t:'Começar um app do zero', steps:[
    ['Abra Projetos, em Padrões do time', '#projetosBtn', ''],
    ['Clique em "Adicionar repo"', '#projNewBtn', 'projetos'],
    ['Escolha "Começar um app do zero"', '[data-addrepo="zero"]', ''],
    ['Pronto: a IA pesquisa e a mesa decide o MVP antes do 1º commit', '', '']] },
};
// o passo i do guia (limitado ao fim) e o texto da faixa "passo N de M"
function guiaPasso(g, i){ const n=(g&&g.steps||[]).length; const k=Math.max(0, Math.min(n-1, i|0)); return { i:k, n, fim:k===n-1, texto:n?g.steps[k][0]:'', sel:n?g.steps[k][1]:'', abre:n?g.steps[k][2]:'' }; }
function guiaFaixaTx(g, i){ const p=guiaPasso(g, i); return `${g.t} · passo ${p.i+1} de ${p.n}: ${p.texto}`; }
// @semana-puro-fim

// ===================== registro das páginas na barra de abas =====================
if(typeof VIEW_META!=='undefined'){
  VIEW_META.meu={ title:'Meu trabalho', icon:SEM_IC.home };
  VIEW_META.semana={ title:'Semana do time', icon:SEM_IC.cal };
  VIEW_META.entregas={ title:'Entregas', icon:SEM_IC.box };
  VIEW_META.mapa={ title:'Onde fica cada coisa', icon:SEM_IC.search };
  VIEW_OVERLAY.meu='meuOverlay'; VIEW_OVERLAY.semana='semanaOverlay'; VIEW_OVERLAY.entregas='entregasOverlay'; VIEW_OVERLAY.mapa='mapaOverlay';
}
if(typeof viewOpen==='function' && !viewOpen.__sem){ const vo=viewOpen; viewOpen=function(kind, tab){
    if(kind==='meu') return semPageOpen('meu');
    if(kind==='semana') return semPageOpen('semana');
    if(kind==='entregas') return semPageOpen('entregas');
    if(kind==='mapa') return semPageOpen('mapa');
    return vo.apply(this, arguments); }; viewOpen.__sem=true; }

// ===================== dados: uma lista só (cartões do time + demandas só desta máquina) =====================
function semMe(){ return (typeof cloudUserId==='function'&&cloudUserId())||''; }
function semTemTime(){ try{ return !!(SB.sess() && cloudTeamId()); }catch(_){ return false; } }
function semCards(){ return (typeof teamTasks!=='undefined'&&teamTasks)||[]; }
function semPessoas(){ // o time ativo, na ordem da grade: você primeiro, depois por nome
  const me=semMe(); const ids=new Set();
  ((typeof tmTeamMembers==='function')?tmTeamMembers():[]).forEach(m=>{ if(m&&m.user_id) ids.add(m.user_id); });
  semCards().forEach(t=>{ if(t.assignee) ids.add(t.assignee); });
  ids.delete(me);
  return [me, ...[...ids].sort((a,b)=>personName(a,{ noYou:true }).localeCompare(personName(b,{ noYou:true }),'pt-BR'))].filter(Boolean);
}
function semDelivered(t){ return typeof epDelivered==='function'?epDelivered(t):['merged','done'].includes(t.status); }
// o código curto da demanda (issue LOJA-12) — sem issue, nada (nunca um id interno)
function semCode(x){ try{ const c=chainOfNow(x); return (c&&c.issue&&c.issue.code)||''; }catch(_){ return ''; } }
function semPrNum(x){ try{ const c=chainOfNow(x); return (c&&c.pr&&c.pr.num)||''; }catch(_){ return ''; } }
// TRAVADA (vermelho) = parou e alguém precisa destravar; ESPERANDO (âmbar) = a pessoa precisa decidir (plano, pergunta)
const SEM_TRAV_ST=new Set(['error','conflict','blocked']), SEM_ESP_ST=new Set(['plan-review','asking','needs-you']);
// item da tela: { id, card, local, titulo, who, st, bucket, done, trav, esp, motivo, mod, code }
function semItemCard(t){
  const local=(typeof tsLocalOf==='function')?tsLocalOf(t):null;
  const st=(typeof tsSt==='function')?tsSt(t):t.status, bucket=(typeof tsBucket==='function')?tsBucket(t):'andamento';
  const done=semDelivered(t), flag=(typeof tsNorm==='function')?tsNorm(t).flag:t.flag;
  const trav=!done && (SEM_TRAV_ST.has(st) || flag==='blocked' || (typeof entTravada==='function' && typeof ENT_FN!=='undefined' && entTravada(t, ENT_FN) && !SEM_ESP_ST.has(st)));
  const esp=!done && !trav && bucket==='aguardando';
  let motivo=''; if(trav||esp){ try{ motivo=typeof entTravaTx==='function'?entTravaTx(t):''; }catch(_){ } if(!motivo) motivo=stLabel(st); }
  return { id:'c:'+t.id, card:t, local, titulo:t.title||'tarefa', who:t.assignee||'', by:t.created_by||'', st, bucket, done, trav, esp, motivo,
    mod:(typeof entModTs==='function'?entModTs(t):modTs(t.updated_at)), code:semCode(t) };
}
function semItemLocal(t){
  const st=taskSt(t), bucket=flowBucket(t), done=taskIsDone(t);
  const trav=!done && (SEM_TRAV_ST.has(st) || t.flag==='blocked'), esp=!done && !trav && bucket==='aguardando';
  return { id:'l:'+t.id, card:null, local:t, titulo:t.title||'tarefa', who:semMe()||'eu', by:semMe()||'eu', st, bucket, done, trav, esp,
    motivo:(trav||esp)?stLabel(st):'', mod:modTs(t.finishedAt, t.updatedAt, t.createdAt), code:semCode(t) };
}
// tudo que a Semana/Meu trabalho enxergam: cartões do time (cancelados fora) + demandas desta máquina que NÃO estão no time
// memória pela IDENTIDADE das fontes (o snapshot e o teamFetch trocam o array quando algo muda): o render() roda a cada
// atualização e a lateral conta "Precisa de mim" — sem recalcular quando nada mudou
let semItensMemo={ k:null, v:[] };
function semItens(){
  const k=[(typeof state!=='undefined'&&state.tasks)||null, semCards(), (typeof state!=='undefined'&&state.pending)||null, (typeof teamActivity!=='undefined'&&teamActivity)||null, (typeof diaSt!=='undefined'&&diaSt.rows)||null, semMe(), Math.floor(Date.now()/60000)];
  if(semItensMemo.k && k.every((x,i)=>x===semItensMemo.k[i])) return semItensMemo.v;
  const v=semItensCalc(); semItensMemo={ k, v }; return v;
}
function semItensCalc(){
  const cards=semCards().filter(t=>t.status!=='cancelled');
  const noTime=new Set(cards.map(t=>t.local_id).filter(Boolean));
  const loc=((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>t.status!=='draft' && !noTime.has(t.id) && t.status!=='cancelled');
  return [...cards.map(semItemCard), ...loc.map(semItemLocal)];
}
// quando foi ENTREGUE (carimbo real — 72: nunca updated_at); demanda desta máquina: o finishedAt
function semEntregueEm(x){
  if(!x.done) return 0;
  if(x.card){ try{ const r=diaItensDe([x.card]); return (r[0]&&r[0].ts)||0; }catch(_){ return 0; } }
  return modMs(x.local&&x.local.finishedAt)||0;
}
function semAbrir(x){
  if(!x) return;
  if(x.local && (state.tasks||[]).some(t=>t.id===x.local.id)){ if(typeof openWorkspace==='function') openWorkspace(x.local.id); return; }
  if(x.card && typeof openCloudTaskPage==='function') openCloudTaskPage(x.card);
}
function semFind(id){ return semItens().find(x=>x.id===id)||null; }
// busca do time quando uma página que depende dele abre (cache de 10 s no teamFetch) — depois repinta
let semFetchAt=0;
function semBuscaTime(force){
  if(!semTemTime() || typeof teamFetch!=='function') return;
  if(!force && Date.now()-semFetchAt<30000) return;
  semFetchAt=Date.now();
  teamFetch(!!force).then(()=>{ semEntregasCarimbos(); semRepintar(); }).catch(()=>{});
}
// carimbos de entrega da semana (e do período da aba Entregas) em lote — o mesmo lote do 72
function semEntregasCarimbos(){
  if(typeof diaStampsLoad!=='function' || !semTemTime()) return;
  const r=semEntPeriodo();
  const ids=semCards().filter(semDelivered).map(t=>t.id);
  if(!ids.length) return;
  Promise.resolve(diaStampsLoad(ids, r)).then(()=>semRepintar()).catch(()=>{});
}

// ===================== popover ancorado (menu Passar/Atribuir, motivo de devolver, seletor de projeto) =====================
let semPopEl=null;
function semPopClose(refocus){ const p=semPopEl; semPopEl=null; if(!p) return; const a=p.__anchor; p.remove(); if(a){ try{ a.setAttribute('aria-expanded','false'); if(refocus && a.isConnected) a.focus(); }catch(_){ } } }
function semPop(anchor, html, wire, o){
  o=o||{}; semPopClose();
  const p=document.createElement('div'); p.className='sempop'+(o.cls?' '+o.cls:''); p.setAttribute('role', o.role||'menu'); if(o.label) p.setAttribute('aria-label', o.label);
  p.innerHTML=html; p.__anchor=anchor; document.body.appendChild(p); semPopEl=p;
  const r=anchor.getBoundingClientRect(), w=p.offsetWidth, h=p.offsetHeight;
  let x=o.up?r.left:Math.min(r.right-w, innerWidth-w-10); x=Math.max(10, Math.min(x, innerWidth-w-10));
  let y=o.up?r.top-h-6:r.bottom+6; if(y+h>innerHeight-8) y=r.top-h-6; y=Math.max(8, y);
  p.style.left=x+'px'; p.style.top=y+'px';
  try{ anchor.setAttribute('aria-expanded','true'); }catch(_){ }
  if(wire) wire(p);
  const f=p.querySelector('textarea,input,.sempop-o:not([disabled])'); if(f) f.focus();
  p.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); semPopClose(true); return; }
    if(/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
    const it=[...p.querySelectorAll('.sempop-o:not([disabled])')], i=it.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); if(it.length) it[(i+(e.key==='ArrowDown'?1:-1)+it.length)%it.length].focus(); return; }
    const hit=p.querySelector(`.sempop-o[data-k="${CSS.escape(e.key)}"]:not([disabled])`);
    if(hit && !e.metaKey && !e.ctrlKey && !e.altKey){ e.preventDefault(); e.stopPropagation(); hit.click(); }
  });
  return p;
}
document.addEventListener('pointerdown', e=>{ if(semPopEl && !semPopEl.contains(e.target) && !(semPopEl.__anchor&&semPopEl.__anchor.contains(e.target))) semPopClose(); }, true);
window.addEventListener('resize', ()=>semPopClose());

// ===================== responsável: assumir, passar, devolver (com motivo) =====================
function semPodeOutros(x){ return !!(x&&x.card && typeof tmCanAssignNow==='function' && tmCanAssignNow(x.card.team_id)); }
function semCargaHtml(uid){ // barrinhas da carga de HOJE (uma por demanda aberta, na cor da situação) + "N abertas"
  const ab=semItens().filter(x=>x.who===uid && !x.done && x.bucket!=='fila');
  return `<span class="semlbars" aria-hidden="true">${ab.slice(0,6).map(x=>`<i style="background:${x.trav?'var(--st-err)':stColor(x.st)}"></i>`).join('')}</span><span class="sempop-ld">${ab.length} ${ab.length===1?'aberta':'abertas'}</span>`;
}
function semMenu(anchor, x){
  if(!x) return;
  const me=semMe(), cur=x.card?(x.card.assignee||''):'';
  const ops=semMenuOpcoes({ me, cur, pessoas:semPessoas(), podeOutros:semPodeOutros(x), local:!x.card });
  const tit=(x.code?x.code+' · ':'')+String(x.titulo).slice(0,40);
  const html=`<div class="sempop-h">${esc(cur?'Passar':'Atribuir')} ${esc(tit)}</div>`
    +(!x.card?`<p class="sempop-p">Esta demanda é só deste computador — mande pro time (na Nova demanda) pra poder passar pra alguém.</p>`:'')
    +ops.map(o=>o.devolver
      ?`<button type="button" role="menuitem" class="sempop-o" data-k="0" data-semop="dev"${o.off?` disabled title="${escA(o.why)}"`:''}><span class="k">0</span><span class="tsav semnone" aria-hidden="true">?</span><span class="sempop-n">Devolver pro time (sem dono)</span></button>`
      :`<button type="button" role="menuitem" class="sempop-o" data-k="${o.k}" data-semop="${escA(o.uid)}"${o.off?` disabled title="${escA(o.why)}"`:''}><span class="k">${o.k}</span>${personAv(o.uid,{ decor:true })}<span class="sempop-n">${o.eu?'Eu assumo':esc(personName(o.uid,{ noYou:true }))}</span>${semCargaHtml(o.uid)}</button>`).join('')
    +`<button type="button" role="menuitem" class="sempop-o" data-semop="abrir"><span class="k"></span>${semIc('arrowR')}<span class="sempop-n">Abrir a tarefa</span></button>`;
  semPop(anchor, html, p=>p.querySelectorAll('[data-semop]').forEach(b=>b.onclick=()=>{
    const v=b.dataset.semop; if(v==='abrir'){ semPopClose(); semAbrir(x); return; }
    if(v==='dev'){ semDevolver(anchor, x); return; }
    semPopClose(); semPassar(x, v, 'menu'); }), { label:(cur?'Passar ':'Atribuir ')+tit });
}
// passa o cartão pra `uid` (você = assumir). Tirar de um colega pede confirmação (a mesma regra do tsReassign)
async function semPassar(x, uid, how){
  if(!x || !x.card || !uid) return;
  const ct=x.card, me=semMe();
  if((ct.assignee||'')===uid) return;
  try{
    if(uid===me && !ct.assignee && typeof tsClaimOnly==='function'){ await tsClaimOnly(ct, null); semRepintar(); return; }
    if(!semPodeOutros(x) && !(uid===me && !ct.assignee)) throw new Error('só o líder do time ou um admin passa pra outra pessoa');
    if(typeof personEnsure==='function') await personEnsure([ct.assignee, uid]);
    if(ct.assignee && ct.assignee!==me && !await askYes(personName(ct.assignee,{ noYou:true })+' é avisado e o cartão passa pra '+personName(uid,{ noYou:true })+'. Se já começou na máquina dele, combine antes.', 'Tirar “'+String(ct.title||'').slice(0,50)+'” de '+personName(ct.assignee,{ noYou:true })+'?')) return;
    await cloudAssign(ct.id, uid); ct.assignee=uid;
    if(typeof trkCardAssign==='function') trkCardAssign(ct, uid);
    semDepoisDeMudar();
    toast((uid===me?'Você assumiu':'Passada para '+personName(uid,{ noYou:true }))+' — “'+String(ct.title||'').slice(0,50)+'”'+(how==='arrastada'?' (arrastada)':'')+'. '+(uid===me?'Nada roda até você iniciar.':'A pessoa recebe o aviso.'),'ok');
  }catch(e){ showErr(e, 'Não deu pra passar a tarefa'); }
}
function semDepoisDeMudar(){ semItensMemo={ k:null, v:[] }; try{ teamTasks=null; teamPaintSig=''; lastSig=''; }catch(_){ } semFetchAt=0; semBuscaTime(true); if(typeof refresh==='function') refresh().catch(()=>{}); semRepintar();
  try{ window.dispatchEvent(new CustomEvent('sf:responsavel-mudou')); }catch(_){ } } // a aba do épico (81) relê quem faz
// devolver PEDE MOTIVO (mesa): o motivo vai pro histórico do cartão e quem pegar depois lê
function semDevolver(anchor, x){
  if(!x || !x.card) return;
  const html=`<div class="sempop-h">Devolver ${esc(x.code||'')} ao time</div><div class="sempop-f"><label class="sr-only" for="semDevWhy">Motivo</label><textarea id="semDevWhy" rows="3" placeholder="Por que está devolvendo? (pelo menos 3 palavras)"></textarea><div class="sempop-fa"><span class="dim" id="semDevHint">quem pegar depois lê o motivo</span><button type="button" class="btn sm primary" id="semDevOk" disabled>Devolver com motivo</button></div></div>`;
  semPop(anchor, html, p=>{
    const ta=p.querySelector('#semDevWhy'), ok=p.querySelector('#semDevOk');
    ta.oninput=()=>{ ok.disabled=!semMotivoOk(ta.value); };
    ta.onkeydown=e=>{ if(e.key==='Enter' && (e.metaKey||e.ctrlKey) && !ok.disabled){ e.preventDefault(); ok.click(); } };
    ok.onclick=async()=>{ const why=ta.value.trim(); if(!semMotivoOk(why)) return; ok.disabled=true; ok.textContent='devolvendo…';
      try{ await cloudAssign(x.card.id, null); x.card.assignee=null;
        sbPost('task_activity',{ task_id:x.card.id, user_id:semMe(), kind:'comment', body:'Devolveu: '+why.slice(0,300) }).catch(()=>{});
        semPopClose(); semDepoisDeMudar(); toast('Devolvida ao time — “'+String(x.titulo).slice(0,50)+'” fica em Sem dono, com o motivo.','ok'); }
      catch(e){ showErr(e, 'Não deu pra devolver'); ok.disabled=false; ok.textContent='Devolver com motivo'; } };
  }, { role:'dialog', label:'Devolver ao time' });
}
// o motivo de quem devolveu por último (comentário "Devolveu: …" ou o corpo do 'released')
function semDevolvidaPor(card){
  const a=((typeof teamActivity!=='undefined'&&teamActivity)||[]).filter(r=>r.task_id===card.id && (r.kind==='released' || (r.kind==='comment' && /^Devolveu:/i.test(String(r.body||''))))).sort((p,q)=>modMs(q.at)-modMs(p.at))[0];
  if(!a) return null;
  return { by:a.user_id, why:String(a.body||'').replace(/^Devolveu:\s*/i,'').trim(), at:modMs(a.at) };
}

// ===================== páginas =====================
const SEM_PAGES={ meu:['meuOverlay','meuPage'], semana:['semanaOverlay','semanaPage'], entregas:['entregasOverlay','entregasPage'], mapa:['mapaOverlay','mapaPage'] };
function semPageOpen(k){
  const pg=$id(SEM_PAGES[k][1]); if(!pg) return;
  pg.__html=''; semPaint(k);
  if(typeof ovShow==='function') ovShow(SEM_PAGES[k][0]);
  if(k!=='mapa'){ semBuscaTime(); if(k==='entregas') semEntregasCarimbos(); }
}
function semAtiva(){ const t=(typeof tabById==='function')?tabById(activeTab):null; return t&&SEM_PAGES[t.kind]?t.kind:''; }
function semRepintar(){ const k=semAtiva(); if(k) semPaint(k); semSideSync(); }
function semPaint(k){
  const pg=$id(SEM_PAGES[k][1]); if(!pg) return;
  let html='';
  try{ html=k==='meu'?meuHtml():k==='semana'?semanaHtml():k==='entregas'?entHtml2():mapaHtml(); }
  catch(e){ console.error('semana '+k, e); html=`<div class="pgbody">${emptyHtml({ icon:'alert', title:'Não consegui montar esta tela', help:String(e&&e.message||e) })}</div>`; }
  if(pg.__html===html) return; // nada mudou: mantém o DOM (foco, rolagem e handlers)
  const sc=pg.scrollTop; pg.__html=html; pg.innerHTML=html; pg.scrollTop=sc;
  semWire(pg, k);
  semGuiaRealce();
}

// ---------- Meu trabalho ----------
// "Precisa de mim" em frases, cada uma com UMA ação. Fontes: perguntas do agente (state.pending), plano pra aprovar,
// IA terminou (pronta pra revisar), travadas desta máquina, cartões que mandaram pra mim, travadas de quem eu mandei,
// devolvidas sem dono e PRs do time esperando revisão. Mais recente primeiro.
function meuEventos(){
  const me=semMe(), out=[], its=semItens();
  const tt=s=>`<span class="tt">${esc(mdTitle(String(s||'')))}</span>`;
  const quando=ms=>ms?(agoShort(ms)==='agora'?'agora':'há '+agoShort(ms).replace('min',' min').replace(/(\d)h$/,'$1 h').replace(/(\d)d$/,'$1 dias')):'';
  const meta=(x, ms, extra)=>[x.code, quando(ms), extra].filter(Boolean).join(' · ');
  for(const p of ((typeof state!=='undefined'&&state.pending)||[])){
    const t=(state.tasks||[]).find(y=>y.id===p.taskId); if(!t) continue; const x=semItemLocal(t);
    out.push({ ms:modTs(p.ts, t.updatedAt)||Date.now(), av:'ia', s:`<b>A IA</b> perguntou em ${tt(t.title)}: “${esc(String(p.prompt||'').replace(/\s+/g,' ').slice(0,140))}”`, m:meta(x, modTs(p.ts)),
      a:[{ l:'Responder', pri:true, act:()=>{ if(typeof openAsk==='function') openAsk(p.id); else semAbrir(x); } }] });
  }
  for(const x of its){
    if(x.done) continue;
    const mine=x.who===me || (!x.card);
    if(mine && x.st==='plan-review') out.push({ ms:x.mod, av:'ia', s:`O plano de ${tt(x.titulo)} espera sua aprovação.`, m:meta(x, x.mod), a:[{ l:'Ver o plano', pri:true, act:()=>semAbrir(x) }] });
    // 80-aprovar: terminou com as provas (ou o revisor pediu mudança) → Aprovar direto na frase e "Ver provas" abre o painel aqui
    else if(mine && x.local && typeof apMeuEvento==='function' && typeof apAprovavel==='function' && apAprovavel(x.local)) out.push(apMeuEvento(x, meta(x, x.mod)));
    else if(mine && x.bucket==='prontas' && x.local){ const r=(x.local.requirements||[]).length; const ok=(typeof reqProvadas==='function')?reqProvadas(x.local):null;
      out.push({ ms:x.mod, av:'ia', s:`<b>A IA</b> terminou ${tt(x.titulo)}${r?(ok!=null?` com ${ok} de ${r} requisitos provados`:` (${r} requisitos)`):''}.`, m:meta(x, x.mod), a:[{ l:'Revisar', pri:true, act:()=>semAbrir(x) }] }); }
    else if(mine && x.bucket==='praberto' && x.local){ const pr=semPrNum(x.local);
      out.push({ ms:x.mod, av:'ia', s:`<b>A IA</b> terminou ${tt(x.titulo)}${pr?` e abriu o PR #${esc(pr)}`:''} — falta você revisar.`, m:meta(x, x.mod), a:[{ l:'Revisar', pri:true, act:()=>semAbrir(x) }] }); }
    else if(mine && x.trav && x.local) out.push({ ms:x.mod, av:'ia', s:`${tt(x.titulo)} parou: ${esc(x.motivo)}.`, m:meta(x, x.mod),
      a:(typeof conflitoDe==='function' && conflitoDe(x.local))?[{ l:'Resolver conflito', pri:true, act:()=>resolverConflito(x.local.id) }, { l:'ver o que houve', act:()=>semAbrir(x) }]:[{ l:'Abrir', act:()=>semAbrir(x) }] });
    if(!x.card) continue;
    const c=x.card;
    if(c.assignee===me && c.created_by && c.created_by!==me && x.bucket==='fila')
      out.push({ ms:x.mod, av:c.created_by, s:`<b>${esc(personName(c.created_by,{ noYou:true }))}</b> te mandou ${tt(x.titulo)}. Nada roda até você iniciar.`, m:meta(x, x.mod), a:[{ l:'Abrir', pri:true, act:()=>semAbrir(x) }] });
    if(c.created_by===me && c.assignee && c.assignee!==me && x.trav)
      out.push({ ms:x.mod, av:c.assignee, s:`<b>${esc(personName(c.assignee,{ noYou:true }))}</b> travou em ${tt(x.titulo)}: ${esc(x.motivo)}. Você criou essa demanda.`, m:meta(x, x.mod), a:(typeof entConflito==='function' && entConflito(c) && typeof conflitoPedirA==='function')?[{ l:'Pedir a '+personShort(c.assignee,{ noYou:true })+' pra resolver', pri:true, act:()=>conflitoPedirA(c) }, { l:'ver o que houve', act:()=>semAbrir(x) }]:[{ l:'Ajudar', act:()=>semAbrir(x) }] });
    if(!c.assignee && x.bucket==='fila'){ const dv=semDevolvidaPor(c);
      if(dv && dv.by!==me) out.push({ ms:dv.at, av:dv.by, s:`<b>${esc(personName(dv.by,{ noYou:true }))}</b> devolveu ${tt(x.titulo)}${dv.why?`: “${esc(dv.why.slice(0,120))}”`:''}.`, m:meta(x, dv.at, 'está sem dono'),
        a:[{ l:'Assumir', act:()=>semPassar(x, me) }, { l:'Passar', menu:true, x }] }); }
    if(c.pr_url && c.assignee && c.assignee!==me && x.bucket==='praberto' && c.created_by===me)
      out.push({ ms:x.mod, av:c.assignee, s:`<b>${esc(personName(c.assignee,{ noYou:true }))}</b> abriu o PR de ${tt(x.titulo)} — falta revisar.`, m:meta(x, x.mod, x.card&&semPrNum(c)?'PR #'+semPrNum(c):''), a:[{ l:'Revisar', pri:true, act:()=>semAbrir(x) }] });
  }
  return out.sort((a,b)=>(b.ms||0)-(a.ms||0));
}
let meuEvAtual=[];
function meuHtml(){
  const me=semMe(), its=semItens(), ev=meuEventos(); meuEvAtual=ev;
  const proj=(typeof state!=='undefined'&&state.repo)?pathBase(state.repo):'';
  const apSel=typeof apMeuSel==='function'?apMeuSel():'';
  const evH=ev.length?ev.map((e,i)=>`<div class="mev${e.tid&&e.tid===apSel?' sel':''}"${e.tid?` data-aptid="${escA(e.tid)}"`:''}><span class="mev-av">${e.av==='ia'?`<span class="tsav semia" aria-hidden="true">${semIc('spark')}</span>`:personAv(e.av,{ decor:true })}</span><div class="mev-tx"><div class="mev-s">${e.s}</div>${e.m?`<div class="mev-m">${esc(e.m)}</div>`:''}</div><div class="mev-a">${e.a.map((a,j)=>a.menu?`<button type="button" class="btn sm quiet" data-meva="${i}:${j}" aria-haspopup="menu">${esc(a.l)} ${semIc('chev')}</button>`:`<button type="button" class="btn sm${a.pri?' primary':''}" data-meva="${i}:${j}">${esc(a.l)}</button>`).join('')}</div></div>${e.tid&&typeof apMeuExpHtml==='function'?apMeuExpHtml(e.tid):''}`).join('')
    :`<div class="mev-vazio">${semIc('check')} Nada esperando por você agora.</div>`;
  // Minha semana: hoje (o que está comigo e não está em "Precisa de mim"), entregue ontem, e a minha fila
  const t0=semDia0(Date.now()), ontem=t0-86400000;
  const mine=its.filter(x=>x.who===me || (!x.card));
  const hoje=mine.filter(x=>!x.done && x.bucket!=='fila' && x.bucket!=='aguardando' && !(x.local && x.bucket==='prontas'));
  const ont=mine.filter(x=>{ const e=semEntregueEm(x); return e>=ontem && e<t0; });
  const fila=mine.filter(x=>!x.done && x.bucket==='fila');
  const linha=x=>`<div class="mws-it" role="button" tabindex="0" data-semopen="${escA(x.id)}"><span class="mws-code">${esc(x.code||'')}</span><span class="mws-t">${esc(mdTitle(x.titulo))}</span>${semChip(x)}${x.card&&!x.done&&x.card.assignee===me?`<button type="button" class="btn sm quiet" data-semdev="${escA(x.id)}" title="devolver pro time (pede o motivo)">${semIc('undo')}Devolver</button>`:''}</div>`;
  const dia=(l, s, L)=>`<div class="mws-day"><div class="mws-d">${esc(l)}<span>${esc(s)}</span></div><div>${L.length?L.map(linha).join(''):'<div class="mws-nada">Nada.</div>'}</div></div>`;
  const dOnt=new Date(ontem);
  const sent=semCards().filter(c=>c.created_by===me && c.assignee && c.assignee!==me && !semDelivered(c) && c.status!=='cancelled').map(semItemCard).sort((a,b)=>b.mod-a.mod);
  const sentH=sent.length?sent.map(x=>`<div class="mmd" role="button" tabindex="0" data-semopen="${escA(x.id)}">${personAv(x.who,{ decor:true })}<span class="mmd-t">${esc(mdTitle(x.titulo))}</span><span></span><span class="mmd-s" style="color:${x.trav?'var(--st-err)':stColor(x.st)}">${esc(personName(x.who,{ noYou:true }))} · ${esc(x.trav?'travada':stLabel(x.st))}</span></div>`).join('')
    :`<div class="mws-nada">${semTemTime()?'Nada que você mandou está aberto.':'Entre num time pra mandar demandas pra outras pessoas.'}</div>`;
  return `<div class="sempg">${semHead('Meu trabalho', semHojeTx()+(proj?' · '+proj:''))}
    <div class="semsec-h"><h2>Precisa de mim</h2><span class="n">${ev.length} · sai daqui quando você age${ev.some(e=>e.tid)?' · J/K troca, Espaço mostra as provas, A aprova, P pede alteração':''}</span></div>
    <section class="mevs" aria-label="Precisa de mim">${evH}</section>
    <div class="mw2"><section class="mws" aria-label="Minha semana"><div class="semsec-h"><h2>Minha semana</h2></div>
      ${dia('Hoje', SEM_DIAS_LONGO[new Date(t0).getDay()]+', '+new Date(t0).getDate(), hoje)}${dia('Ontem', SEM_DIAS_LONGO[dOnt.getDay()]+', '+dOnt.getDate(), ont)}${dia('Na fila', 'próximas', fila)}</section>
    <aside class="mmds" aria-label="Mandei pro time"><div class="semsec-h"><h2>Mandei pro time</h2><span class="n">${sent.length}</span></div>${sentH}</aside></div></div>`;
}
function semChip(x){
  const lab=x.done?'entregue':x.trav?'travada':stShort(x.st), cor=x.done?'var(--st-done)':x.trav?'var(--st-err)':stColor(x.st);
  return `<span class="semchip${x.done?' done':''}" style="--c:${cor}"><i aria-hidden="true"></i>${esc(lab)}</span>`;
}
function semHead(title, sub, right){ return `<header class="semhead"><div><h1>${esc(title)}</h1>${sub?`<p class="semsub">${esc(sub)}</p>`:''}</div><span class="grow"></span>${right||''}</header>`; }

// ---------- Semana do time ----------
let semModo=lsGet('sem:modo')==='dist'?'dist':'grade', semAberto='', semSelQ='';
// aviso de padrão do time desligado: quem desliga (Skills › "Onde está ligada", "sempre…" → "só quando pedir", agente
// tirado do catálogo ou de uma equipe — padAvisoDesligado em 75-padroes) dispara
// window.dispatchEvent(new CustomEvent('sf:padrao-desligado', { detail:{ quem, padrao, onde, at, abrir? } }))
// Fica guardado por 7 dias NESTA máquina (sem:padraoOff) e, com time ativo, vai pro time (team_events, 0033 — teamEventPost
// em 42): a faixa de TODOS os membros mostra o mais novo de qualquer um. Nuvem sem a 0033 = só o aviso local, sem erro.
let semPadraoOff=null, semPadraoAgora=null;
try{ semPadraoOff=semPadraoVale(JSON.parse(lsGet('sem:padraoOff')||'null')); }catch(_){ semPadraoOff=null; }
window.addEventListener('sf:padrao-desligado', e=>{ const d=(e&&e.detail)||null; semPadraoOff=d?Object.assign({ at:Date.now() }, d):null;
  try{ lsSet('sem:padraoOff', JSON.stringify(semPadraoOff)); }catch(_){ } semRepintar();
  if(d && typeof teamEventPost==='function') teamEventPost('padrao-desligado', semPadraoCorpo(d)).then(ok=>{ if(ok) semRepintar(); }).catch(()=>{}); });
// o aviso que a faixa mostra agora: o local ou o do time ativo (com o nome da pessoa)
function semPadraoAtual(){
  const tid=(typeof cloudTeamId==='function')?cloudTeamId():'';
  const rows=tid?((typeof teamEvents!=='undefined'&&teamEvents)||[]).filter(r=>r&&r.team_id===tid):[];
  const t=semPadraoDoTime(rows, Date.now());
  const doTime=t?Object.assign({}, t, { quem:personCap(personName(t.uid, { noYou:false })) }):null;
  return semPadraoMaisNovo(semPadraoOff, doTime, Date.now());
}
window.addEventListener('sf:epico-entregue', ()=>semRepintar());
function semParados(its){ return its.filter(x=>x.trav && !x.done); }
function semanaHtml(){
  const its=semItens(), dias=semDiasDaSemana(Date.now()), hoje=dias.find(d=>d.kind==='today')||dias[0];
  const pessoas=semPessoas(), me=semMe();
  const timeN=(typeof tsTeamName==='function'&&cloudTeamId())?tsTeamName(cloudTeamId()):'';
  const proj=(typeof state!=='undefined'&&state.repo)?pathBase(state.repo):'';
  const sw=`<div class="semsw" role="group" aria-label="Modo da Semana"><button type="button" aria-pressed="${semModo==='grade'}" data-semmodo="grade">Semana</button><button type="button" aria-pressed="${semModo==='dist'}" data-semmodo="dist">Distribuir</button></div>`;
  const par=semParados(its);
  if(semPadraoOff && !semPadraoVale(semPadraoOff)) semPadraoOff=null; // passou de 7 dias
  const pad=semPadraoAgora=semPadraoAtual();
  const strips=`<div class="semstrips${pad?'':' one'}"><div class="semstrip red" role="status">${semIc('alert')}<span><b>Parado agora:</b> ${par.length?par.map(x=>`<button type="button" class="lnk" data-semopen="${escA(x.id)}">${esc(personName(x.who,{ noYou:false }))} em ${esc(x.code||mdTitle(x.titulo).slice(0,32))}</button>`).join(' · '):'ninguém'}</span></div>`
    +(pad?`<div class="semstrip amb" role="status">${semIc('shield')}<span><b>${esc(pad.quem||'Alguém')} desligou ${esc(pad.padrao||'um padrão')}</b> (padrão do time)${pad.onde?' em '+esc(pad.onde):''}</span><span class="grow"></span><button type="button" class="btn sm quiet" data-sempad="1">Ver</button></div>`:'')+`</div>`;
  const semTime=!semTemTime()?`<div class="semnote">${semIc('people')}<span>Você está vendo só as suas demandas. <b>Entre num time</b> pra ver a semana de todo mundo, passar e assumir.</span><button type="button" class="btn sm" data-semtime="1">Entrar num time</button></div>`:'';
  const head=semHead('Semana do time', [timeN, proj, semIntervaloTx(dias)].filter(Boolean).join(' · '), sw);
  if(semModo==='dist') return `<div class="sempg wide">${head}${strips}${semTime}${semDistHtml(its, pessoas)}</div>`;
  const semDono=its.filter(x=>x.card && !x.card.assignee && !x.done);
  // em qual coluna cada item cai: entregue → dia do carimbo; aberto → hoje; fila de alguém → o próximo dia
  const prox=dias.find(d=>d.kind==='fut');
  const col=x=>{ if(x.done){ const e=semEntregueEm(x); const k=e?semKeyDia(e):''; return dias.some(d=>d.key===k)?k:''; }
    if(x.bucket==='fila' && x.who) return prox?prox.key:hoje.key; return hoje.key; };
  const aberto=dias.some(d=>d.key===semAberto && d.kind!=='today')?semAberto:'';
  const cols=semColunas(dias, aberto);
  const hd=`<div class="hd c0">Pessoa</div>`+dias.map(d=>d.kind==='today'?`<div class="hd today"><b>${d.lbl} ${d.num}</b> · hoje</div>`
    :`<div class="hd"><button type="button" data-semdia="${d.key}" title="${d.key===aberto?'Recolher':'Abrir '+d.lbl+' '+d.num}" aria-expanded="${d.key===aberto}"><b>${d.lbl}</b>${d.key===aberto?' '+d.num+' ‹':''}</button></div>`).join('');
  const cell=(L, d)=>{
    if(d.kind==='today' || d.key===aberto) return L.map(x=>semBloco(x)).join('');
    if(!L.length) return '';
    return d.kind==='past'||L.every(x=>x.done)?`<button type="button" class="semnum" data-semdia="${d.key}" title="${escA(L.map(x=>x.titulo).join(' · '))}">${semIc('check')}${L.length}</button>`
      :`<button type="button" class="semnum q" data-semdia="${d.key}" title="${escA('Na fila: '+L.map(x=>x.titulo).join(' · '))}">+${L.length}</button>`;
  };
  let rows='';
  if(semTemTime()){
    rows+=`<div class="c0 pc rowsd" data-semdrop="">${`<span class="tsav semnone" aria-hidden="true">?</span>`}<span><span class="n">Sem dono</span><br><span class="l">${semDono.length} esperando</span></span></div>`
      +dias.map(d=>`<div class="rowsd${d.kind==='today'?' today':''}" data-semdrop="">${d.kind==='today'?semDono.map(x=>semBloco(x)).join(''):''}</div>`).join('');
  }
  // épicos entregues nesta semana: uma linha própria, o bloco no dia da entrega com quem aprovou
  const eps=semEpicosEntregues((typeof teamEpics!=='undefined'&&teamEpics)||[], dias);
  if(eps.length){
    rows+=`<div class="c0 pc rowep">${semIc('box','semepi')}<span class="pcx"><span class="n">Épicos</span><br><span class="l">${eps.length} ${eps.length===1?'entregue':'entregues'}</span></span></div>`
      +dias.map(d=>{ const L=eps.filter(x=>x.key===d.key);
        const inner=!L.length?'':(d.kind==='today'||d.key===aberto)?L.map(semBlocoEpico).join('')
          :`<button type="button" class="semnum ep" data-semdia="${d.key}" title="${escA('Épico entregue: '+L.map(x=>x.nome).join(' · '))}">${semIc('box')}${L.length}</button>`;
        return `<div class="rowep${d.kind==='today'?' today':''}">${inner}</div>`; }).join('');
  }
  for(const uid of (pessoas.length?pessoas:[me||'eu'])){
    const L=its.filter(x=>x.who===uid && (x.card?!!x.card.assignee:true));
    const ab=L.filter(x=>!x.done), tv=ab.some(x=>x.trav);
    rows+=`<div class="c0 pc" data-semdrop="${escA(uid)}">${uid==='eu'?`<span class="tsav semnone" aria-hidden="true">EU</span>`:personAv(uid,{ decor:true, on:typeof tsOnline==='function'&&tsOnline(uid) })}<span class="pcx"><span class="n">${esc(uid===me||uid==='eu'?'Você':personName(uid,{ noYou:true }))}</span><br><span class="l">${ab.length} ${ab.length===1?'aberta':'abertas'}${tv?' · <span class="semred">travada</span>':''}</span></span></div>`
      +dias.map(d=>`<div class="${d.kind==='today'?'today':''}" data-semdrop="${escA(uid)}">${cell(L.filter(x=>col(x)===d.key), d)}</div>`).join('');
  }
  return `<div class="sempg wide">${head}${strips}${semTime}<div class="semgrid" role="grid" aria-label="Semana do time" style="grid-template-columns:${cols}">${hd}${rows}</div>
    <p class="semdica">Arraste um bloco pra linha de outra pessoa, ou use Passar ▾ (teclas 1–${Math.min(9, Math.max(1, pessoas.length))}). Clique num dia recolhido pra ver os títulos.</p></div>`;
}
function semBloco(x){
  const sd=x.card && !x.card.assignee && !x.done;
  let r='';
  if(x.done) r='entregue'+(semPrNum(x.card||x.local)?' · PR #'+semPrNum(x.card||x.local):'');
  else if(x.trav||x.esp) r=x.motivo;
  else if(sd){ const dv=semDevolvidaPor(x.card); r=dv&&dv.why?'devolvida por '+personName(dv.by,{ noYou:true })+': '+dv.why:'pedida por '+personName(x.by)+(x.mod?' · há '+agoShort(x.mod):''); }
  else if(x.bucket==='prontas'||x.bucket==='praberto') r=stLabel(x.st);
  else if(x.bucket==='fila') r='na fila';
  const cls=x.done?' done':x.trav?' trav':(sd||x.esp)?' esp':'';
  const dot=x.done?'var(--st-done)':x.trav?'var(--st-err)':sd?'var(--warn)':stColor(x.st);
  const mn=x.done?'':`<button type="button" class="sem-mn" data-semmenu="${escA(x.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escA((sd?'Atribuir ':'Passar ')+(x.code||x.titulo))}">${sd?'Atribuir':'Passar'} ${semIc('chev')}</button>`;
  return `<div class="semtb${cls}" role="button" tabindex="0" ${x.card&&!x.done?'draggable="true" ':''}data-semdrag="${escA(x.id)}" data-semopen="${escA(x.id)}" title="${escA(x.titulo)}"><span class="dot" style="background:${dot}"></span><span class="t">${x.code?`<span class="semcode">${esc(x.code)}</span> `:''}${esc(mdTitle(x.titulo))}</span>${mn}${r?`<span class="r">${esc(r)}</span>`:''}</div>`;
}
// o bloco do épico entregue (distinto das tarefas: faixa roxa, "ÉPICO ENTREGUE", quem aprovou) — abre a aba do épico
function semBlocoEpico(x){
  const apr=x.by?personName(x.by,{ noYou:true }):'';
  const hh=new Date(x.at).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' });
  const r=[apr?'aprovado por '+apr:'entregue', hh, x.tarefas?x.tarefas+' '+(x.tarefas===1?'tarefa':'tarefas'):''].filter(Boolean).join(' · ');
  return `<button type="button" class="semtb semep" data-semep="${escA(x.id)}" title="${escA('Épico entregue: '+x.nome+(apr?' · aprovado por '+apr:''))}"><span class="dot" aria-hidden="true"></span><span class="t"><span class="semcode">ÉPICO</span> ${esc(x.nome)}</span><span class="r">${esc(r)}</span></button>`;
}
function semDistHtml(its, pessoas){
  const semDono=its.filter(x=>x.card && !x.card.assignee && !x.done).sort((a,b)=>b.mod-a.mod);
  const q=semDono.map(x=>{ const dv=semDevolvidaPor(x.card);
    return `<div class="semq${semSelQ===x.id?' sel':''}" role="option" aria-selected="${semSelQ===x.id}" tabindex="0" draggable="true" data-semdrag="${escA(x.id)}" data-semsel="${escA(x.id)}"><span class="semcode">${esc([x.code, x.card.epic_id&&typeof teamEpics!=='undefined'?((teamEpics||[]).find(e=>e.id===x.card.epic_id)||{}).name:''].filter(Boolean).join(' · '))}</span><span class="t">${esc(mdTitle(x.titulo))}</span><span class="m">${esc(dv&&dv.why?'devolvida por '+personName(dv.by,{ noYou:true })+': '+dv.why:'pedida por '+personName(x.by)+' · há '+agoShort(x.mod))}</span><span class="acts"><button type="button" class="btn sm" data-semassumir="${escA(x.id)}">Assumir</button><button type="button" class="btn sm quiet" data-semmenu="${escA(x.id)}" aria-haspopup="menu">Atribuir</button></span></div>`; }).join('')||'<div class="mws-nada">Tudo tem dono.</div>';
  const colsN=Math.max(1, pessoas.length);
  const cols=pessoas.map((uid,i)=>{ const L=its.filter(x=>x.who===uid && !x.done && (x.card?!!x.card.assignee:true)).sort((a,b)=>b.mod-a.mod);
    return `<section class="sempcol" data-semdrop="${escA(uid)}" aria-label="${escA(personName(uid,{ noYou:true }))}"><div class="ph">${personAv(uid,{ decor:true })}<span class="n">${esc(uid===semMe()?'Você':personName(uid,{ noYou:true }))}</span><span class="l">${L.length} ${L.length===1?'aberta':'abertas'}${i<9?' · tecla '+(i+1):''}</span></div>${L.map(x=>`<button type="button" class="sempc${x.trav?' trav':''}" data-semopen="${escA(x.id)}" ${x.card?'draggable="true" ':''}data-semdrag="${escA(x.id)}"><span class="c">${esc(x.code||'')}</span><span class="t">${esc(mdTitle(x.titulo))}</span>${semChip(x)}${x.trav&&x.motivo?`<span class="rs">${esc(x.motivo)}</span>`:''}</button>`).join('')}</section>`; }).join('');
  return `<div class="semdist"><section class="semqueue" data-semdrop="" aria-label="Sem dono" role="listbox"><h2><span class="tsav semnone" aria-hidden="true">?</span>Sem dono<span class="sbcnt q">${semDono.length}</span></h2>${q}</section>
    <div class="semcols" style="grid-template-columns:repeat(${colsN},minmax(0,1fr))">${cols}</div></div>
    <p class="semdica">Selecione um cartão de Sem dono e aperte o número da pessoa (1–${Math.min(9, colsN)}), ou arraste. A abre o menu.</p>`;
}

// ---------- Entregas ----------
let semEntPer=lsGet('sem:entper')||'semana', semRelOn=false;
function semEntPeriodo(){
  const t0=semDia0(Date.now()), w=new Date(t0).getDay(), seg=t0-((w+6)%7)*86400000;
  if(semEntPer==='passada') return { from:seg-7*86400000, to:seg };
  if(semEntPer==='mes') return { from:t0-29*86400000, to:t0+86400000 };
  return { from:seg, to:t0+86400000 };
}
function semEntPerTx(){ return ({ semana:'Esta semana', passada:'Semana passada', mes:'Últimos 30 dias' })[semEntPer]||'Esta semana'; }
function semEntregues(){
  const r=semEntPeriodo();
  return semItens().filter(x=>x.done).map(x=>({ x, ts:semEntregueEm(x) })).filter(o=>o.ts>=r.from && o.ts<r.to).sort((a,b)=>b.ts-a.ts);
}
function semReqTx(x){ try{ const r=typeof entReqs==='function'?entReqs(x.card||x.local):null; if(r && r.tot) return { ok:r.ok, tot:r.tot }; }catch(_){ } const L=(x.local&&x.local.requirements)||[]; return L.length?{ ok:null, tot:L.length }:null; }
function entHtml2(){
  const E=semEntregues(), r=semEntPeriodo();
  const ppl=new Set(E.map(o=>o.x.who)).size;
  const proj=(typeof state!=='undefined'&&state.repo)?pathBase(state.repo):'';
  const sw=`<div class="semsw" role="group" aria-label="Período">${[['semana','Esta semana'],['passada','Semana passada'],['mes','30 dias']].map(([k,l])=>`<button type="button" aria-pressed="${semEntPer===k}" data-sement="${k}">${l}</button>`).join('')}</div><button type="button" class="btn" data-semrel="1" aria-expanded="${semRelOn}">${semIc('copy')}Relatório</button>`;
  const par=semParados(semItens());
  const strip=par.length?`<div class="semstrip red" role="status">${semIc('alert')}<span><b>Parado agora:</b> ${par.map(x=>`<button type="button" class="lnk" data-semopen="${escA(x.id)}">${esc(personName(x.who,{ noYou:false }))} em ${esc(x.code||mdTitle(x.titulo).slice(0,32))}</button>: ${esc(x.motivo)}`).join(' · ')}</span></div>`:'';
  const quem=x=>personName(x.who,{ noYou:true });
  const relTx=semRelatorioTx({ periodo:semEntPerTx(), projeto:proj, itens:E.map(o=>{ const q=semReqTx(o.x); return { quem:quem(o.x), titulo:mdTitle(o.x.titulo), pr:semPrNum(o.x.card||o.x.local), provas:q&&q.ok!=null?q.ok+'/'+q.tot:'' }; }), parados:par.map(x=>quem(x)+' em '+(x.code||mdTitle(x.titulo))) });
  const rel=semRelOn?`<section class="semrel" aria-label="Relatório pronto pra colar"><div class="semrel-h"><h2>Relatório · pronto pra colar</h2><span class="grow"></span><button type="button" class="btn sm primary" data-semcopiar="1">${semIc('copy')}Copiar</button>${semTemTime()&&typeof relGerar==='function'?`<button type="button" class="btn sm" data-semrelfull="1" title="o relatório completo do período (épicos, pessoas, provas) numa aba — exporta PDF, Markdown ou HTML">Relatório completo</button>`:''}</div><pre id="semRelTx">${esc(relTx)}</pre></section>`:'';
  // calendário: um cartão por dia útil do período (30 dias: só os dias que tiveram entrega)
  const byDia={}; E.forEach(o=>{ (byDia[semKeyDia(o.ts)]=byDia[semKeyDia(o.ts)]||[]).push(o); });
  const hoje=semKeyDia(Date.now());
  let dias=[]; for(let ms=semDia0(r.from); ms<r.to; ms+=86400000){ const d=new Date(ms), k=semKeyDia(ms); if(semEntPer==='mes'?byDia[k]:(d.getDay()!==0&&d.getDay()!==6)||byDia[k]) dias.push(ms); }
  if(semEntPer==='mes') dias=dias.reverse();
  const card=o=>{ const x=o.x, q=semReqTx(x), pr=semPrNum(x.card||x.local), hh=new Date(o.ts).toLocaleTimeString('pt-BR',{ hour:'2-digit', minute:'2-digit' });
    const obj=String((x.local&&x.local.objective)||((x.card&&x.card.spec)||{}).objective||'').replace(/\s+/g,' ').trim();
    return `<button type="button" class="semdc" data-semopen="${escA(x.id)}"><span class="m">${personAv(x.who,{ decor:true })}<span>${esc(quem(x))}</span><span>·</span><span class="tnum">${hh}</span></span><span class="t">${esc(mdTitle(x.titulo))}</span>${obj?`<span class="s">${esc(obj.slice(0,140))}</span>`:''}<span class="m">${pr?`<span class="semcode">PR #${esc(pr)}</span>`:'<span class="semcode">sem PR</span>'}${q?`<span class="semstamp${q.ok!=null&&q.ok<q.tot?' no':''}">${semIc('check')}${q.ok!=null?q.ok+'/'+q.tot:q.tot+' req.'}</span>`:''}${x.code?`<span class="semcode">${esc(x.code)}</span>`:''}</span></button>`; };
  const cal=dias.length?`<div class="semcal">${dias.map(ms=>{ const k=semKeyDia(ms), L=byDia[k]||[], d=new Date(ms); const nome=SEM_DIAS_LONGO[d.getDay()];
    return `<section class="semcalc${k===hoje?' today':''}" aria-label="${escA(nome)}"><div class="ch"><b>${esc(nome.charAt(0).toUpperCase()+nome.slice(1))}</b><span class="dim">${k===hoje?'hoje':d.getDate()+' '+SEM_MESES[d.getMonth()].slice(0,3)} · ${L.length}</span></div>${(()=>{ const ep=typeof epEntregaDiaHtml==='function'?epEntregaDiaHtml(k):''; return ep+(L.map(card).join('')||(ep?'':'<div class="mws-nada">Nada entregue.</div>')); })()}</section>`; }).join('')}</div>`
    :emptyHtml({ icon:'box', title:'Nenhuma entrega neste período', help:'Quando um PR é integrado, a entrega aparece aqui no dia, com quem fez e as provas.' });
  const sub=`${E.length} ${E.length===1?'entrega':'entregas'}, ${ppl} ${ppl===1?'pessoa':'pessoas'}${proj?' · '+proj:''}`;
  return `<div class="sempg wide">${semHead('Entregas', sub, sw)}${strip}${rel}${cal}</div>`;
}

// ---------- Onde fica cada coisa (?) ----------
function mapaHtml(){
  const go=k=>k?` data-semgo="${escA(k)}"`:' disabled';
  const grupos=MAPA_GRUPOS.map(([g, s, its])=>`<section class="mapg"><h2>${esc(g)}</h2><p class="dim">${esc(s)}</p>${its.map(([ic,n,d,k])=>`<button type="button" class="mapi"${go(k)}>${semIc(ic)}<b>${esc(n)}</b><span>${esc(d)}</span></button>`).join('')}</section>`).join('');
  const faq=Object.keys(GUIAS).map(k=>`<div class="mapq"><b>Como ${esc(GUIAS[k].t.charAt(0).toLowerCase()+GUIAS[k].t.slice(1))}?</b><span>${esc(GUIAS[k].steps.slice(0,-1).map(s=>s[0]).join(' › '))}</span><button type="button" class="btn sm" data-semguia="${k}">${semIc('play')}Mostrar passo a passo</button></div>`).join('')
    +`<div class="mapq"><b>Onde foram parar Fábrica e Ideia?</b><span>"Começar um app do zero" está em Projetos › Adicionar repo. "Ainda é uma ideia" é uma opção da Nova demanda.</span></div>`
    +`<div class="mapq"><b>E o quadro do time (Central, Time)?</b><span>Continuam abertos na barra de abas lá em cima. A Semana do time é a porta do dia a dia.</span><button type="button" class="btn sm quiet" data-semgo="time">Abrir o Time</button></div>`;
  return `<div class="sempg">${semHead('Onde fica cada coisa', 'A lateral tem 3 grupos. Uma tarefa abre numa aba, com o terminal da IA no centro; o rodapé da lateral continua igual.')}
    <div class="mapgrid">${grupos}</div>
    <div class="semsec-h" style="margin-top:22px"><h2>Como faço…?</h2><span class="n">o guia mostra cada passo na tela</span></div><div class="mapfaq">${faq}</div></div>`;
}

// ---------- guia passo a passo: faixa "passo N de M" que empurra o conteúdo e realça o próximo clique ----------
let semGuia=null; // { k, i }
function semGuiaIniciar(k){
  const g=GUIAS[k]; if(!g) return;
  semGuia={ k, i:0 };
  const p=guiaPasso(g, 0); if(p.abre) semIr(p.abre);
  semGuiaPinta();
}
function semGuiaSair(){ semGuia=null; semGuiaPinta(); }
function semGuiaPinta(){
  let b=$id('semGuia');
  if(!semGuia){ if(b){ b.hidden=true; b.innerHTML=''; } document.querySelectorAll('.semhl').forEach(e=>e.classList.remove('semhl')); if(typeof syncChromeH==='function') syncChromeH(); return; }
  if(!b) return;
  const g=GUIAS[semGuia.k], p=guiaPasso(g, semGuia.i);
  b.hidden=false;
  b.innerHTML=`${semIc('spark')}<span><b>${esc(g.t)}</b> · passo ${p.i+1} de ${p.n}: ${esc(p.texto)}</span><span class="grow"></span>${p.fim?`<button type="button" class="btn sm" data-guiafim="1">Concluir</button>`:(p.sel?'':`<button type="button" class="btn sm" data-guiaprox="1">Próximo passo</button>`)}<button type="button" class="btn sm quiet" data-guiasair="1">Sair do guia</button>`;
  b.querySelectorAll('[data-guiasair],[data-guiafim]').forEach(x=>x.onclick=semGuiaSair);
  b.querySelectorAll('[data-guiaprox]').forEach(x=>x.onclick=()=>semGuiaAvanca());
  if(typeof syncChromeH==='function'){ syncChromeH(); requestAnimationFrame(syncChromeH); }
  semGuiaRealce();
}
function semGuiaRealce(){
  document.querySelectorAll('.semhl').forEach(e=>e.classList.remove('semhl'));
  if(!semGuia) return;
  const p=guiaPasso(GUIAS[semGuia.k], semGuia.i); if(!p.sel) return;
  let el=null; try{ el=[...document.querySelectorAll(p.sel)].find(e=>e.offsetParent!==null)||null; }catch(_){ }
  if(el){ el.classList.add('semhl'); }
}
function semGuiaAvanca(){
  if(!semGuia) return;
  const g=GUIAS[semGuia.k]; semGuia.i=Math.min(semGuia.i+1, g.steps.length-1);
  const p=guiaPasso(g, semGuia.i); if(p.abre && semAtiva()!==p.abre) semIr(p.abre);
  semGuiaPinta(); setTimeout(semGuiaRealce, 250); setTimeout(semGuiaRealce, 900);
}
// o clique no elemento realçado avança o guia (captura: antes do handler dele, que pode trocar a tela)
document.addEventListener('click', e=>{
  if(!semGuia) return;
  const p=guiaPasso(GUIAS[semGuia.k], semGuia.i); if(!p.sel || !e.target.closest) return;
  let hit=null; try{ hit=e.target.closest(p.sel); }catch(_){ }
  if(hit) setTimeout(semGuiaAvanca, 60);
}, true);

// ===================== navegação: a lateral abre as telas =====================
// Agentes/Skills/Memória: a outra frente cria as telas próprias (kinds 'agentes'|'skills'|'memoria'); enquanto não
// existirem, cai na tela de hoje (Projeto › Agentes/Skills/Memória — o VIEW_ROUTES do 15 já leva pra lá)
function semAbreKind(kind, fallback){
  const rota=(typeof VIEW_ROUTES!=='undefined')?VIEW_ROUTES[kind]:null;
  if(typeof VIEW_META!=='undefined' && VIEW_META[kind] && !rota) return openTab(kind);
  return fallback();
}
function semIr(k){
  switch(k){
    case 'meu': case 'semana': case 'entregas': case 'mapa': return openTab(k);
    case 'issues': return openTab('issues');
    case 'projetos': return openTab('projetos');
    case 'agentes': return semAbreKind('agentes', ()=>openTab('agents'));
    case 'skills': return semAbreKind('skills', ()=>openTab('skills'));
    case 'memoria': return semAbreKind('memoria', ()=>openTab('memoria'));
    case 'pessoas': return (typeof g1Ajustes==='function')?g1Ajustes('times'):openTab('conta');
    case 'ajustes': return (typeof g1Ajustes==='function')?g1Ajustes():openTab('cfg');
    case 'atalhos': return openTab('atalhos');
    case 'time': return openTab('time');
    case 'nova': return openTab('nova');
  }
}
window.semIr=semIr;
[['meuBtn','meu'],['semanaBtn','semana'],['entregasBtn','entregas'],['agentesBtn','agentes'],['skillsNavBtn','skills'],['memoriaBtn','memoria'],['pessoasBtn','pessoas'],['ajustesBtn','ajustes'],['mapaBtn','mapa']]
  .forEach(([id,k])=>bindClick(id, ()=>semIr(k)));
// "?" abre o mapa (antes: a aba Atalhos — que continua no mapa e no menu do avatar)
if(typeof openShortcuts==='function' && !openShortcuts.__sem){ openShortcuts=function(){ openTab('mapa'); }; openShortcuts.__sem=true; window.openShortcuts=openShortcuts; }
// PADRÕES DO TIME recolhível (lembrado por pessoa neste computador)
{ const tg=$id('sbPadTgl'), nav=$id('sbPad');
  const set=(on)=>{ if(!tg||!nav) return; tg.setAttribute('aria-expanded', String(on)); nav.hidden=!on; };
  set(lsGet('sb:padroes')!=='0');
  if(tg) tg.onclick=()=>{ const on=tg.getAttribute('aria-expanded')!=='true'; set(on); lsSet('sb:padroes', on?'1':'0'); }; }
// seletor do projeto atual (topo da lateral): trocar · todos os projetos · adicionar repo
function semProjMenu(){
  const b=$id('sbProjSw'); if(!b) return;
  if(semPopEl && semPopEl.__anchor===b){ semPopClose(true); return; }
  const L=(typeof projects!=='undefined'&&projects)||[];
  const html=`<div class="sempop-h">Projeto atual</div>`+L.map((p,i)=>`<button type="button" role="menuitemradio" aria-checked="${p.path===state.repo}" class="sempop-o" data-k="${i<9?i+1:''}" data-semproj="${escA(p.path)}"><span class="k">${i<9?i+1:''}</span><span class="pdot" style="background:${typeof projColor==='function'?projColor(p.path):'var(--muted)'}"></span><span class="sempop-n">${esc(p.name||pathBase(p.path))}</span>${p.path===state.repo?`<span class="sempop-ld">${semIc('check')}</span>`:''}</button>`).join('')
    +`<div class="sempop-sep" role="separator"></div><button type="button" role="menuitem" class="sempop-o" data-semproj=":todos"><span class="k"></span>${semIc('folder')}<span class="sempop-n">Todos os projetos</span></button><button type="button" role="menuitem" class="sempop-o" data-semproj=":add"><span class="k"></span>${semIc('plus')}<span class="sempop-n">Adicionar repo</span></button>`;
  semPop(b, html, p=>p.querySelectorAll('[data-semproj]').forEach(o=>o.onclick=async()=>{ const v=o.dataset.semproj; semPopClose();
    if(v===':todos'){ openTab('projetos'); return; }
    if(v===':add'){ window.projAddOpen=true; openTab('projetos'); return; }
    if(v!==state.repo && window.switchProject){ try{ await window.switchProject(v); toast('Projeto atual: '+pathBase(v),'ok'); }catch(_){ } } }), { label:'Projeto atual' });
}
bindClick('sbProjSw', semProjMenu);

// ---------- marca da lateral: o LUGAR da aba aberta + contadores ----------
const SEM_NAV={ meu:'meuBtn', semana:'semanaBtn', entregas:'entregasBtn', issues:'issuesBtn', issuesbulk:'issuesBtn', projetos:'projetosBtn', projeto:'projetosBtn',
  agentes:'agentesBtn', agents:'agentesBtn', skills:'skillsNavBtn', memoria:'memoriaBtn', cfg:'ajustesBtn', conta:'pessoasBtn', mapa:'mapaBtn', atalhos:'mapaBtn', time:'semanaBtn' };
function semNavDe(t){
  if(!t) return '';
  if(t.kind==='projeto'){ const s=(typeof projSub!=='undefined')?projSub:''; return s==='agentes'?'agentesBtn':s==='skills'?'skillsNavBtn':s==='memoria'?'memoriaBtn':'projetosBtn'; }
  return SEM_NAV[t.kind]||'';
}
if(typeof g1NavSync==='function'){ g1NavSync=function(){
  const t=(typeof tabById==='function')?tabById(activeTab):null, on=semNavDe(t);
  if(semPopEl && !(semPopEl.__anchor && semPopEl.__anchor.isConnected && semPopEl.__anchor.offsetParent)) semPopClose(); // trocou de aba: o menu não fica solto
  document.querySelectorAll('#sidebar .sbnav2 .sbitem').forEach(b=>{ const v=b.id===on; if(b.classList.contains('on')!==v) b.classList.toggle('on', v); if(v) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
}; }
// PONTO DE EXTENSÃO (outra frente): quando a aba ativa é uma tarefa, a lateral pode virar as etapas da tarefa
// (Conversa ⌘1 · Código ⌘2 · Revisão ⌘3 · Prévia ⌘4 · Entrega ⌘5). task = a tarefa local da aba ativa, ou null fora de uma
// tarefa. Hoje não muda nada: a lateral continua a mesma dentro e fora da tarefa.
// a lateral de etapas mora em 77-tarefa-etapas.js (sideTaskMode/sideTaskActive); daqui saem só as portas que ela chama
window.openMeuTrabalho=function(){ openTab('meu'); };
window.openOndeFica=function(){ openTab('mapa'); };
let semSideSig='';
function semSideSync(){
  const nm=(typeof state!=='undefined'&&state.repo)?pathBase(state.repo):'sem projeto';
  const n=$id('sbProjNm'), d=$id('sbProjDot');
  const ev=(()=>{ try{ return meuEventos().length; }catch(_){ return 0; } })();
  const mem=+(window.memLearnN||0);
  const iss=(()=>{ try{ return Object.keys(typeof trkUnseen==='function'?trkUnseen():{}).length; }catch(_){ return 0; } })();
  const src=(()=>{ try{ return (typeof trk!=='undefined'&&trk&&trk.name)?String(trk.name):''; }catch(_){ return ''; } })();
  const rh=document.querySelector('#rail>.rhead .n'), ab=rh?rh.textContent:'';
  if(typeof ptSideSync==='function') ptSideSync(); // 84-prototipo: contador de Protótipos (relê só quando o projeto muda)
  const sig=[nm, ev, mem, iss, src, state&&state.repo, ab].join('|'); if(sig===semSideSig) return; semSideSig=sig;
  if(n) n.textContent=nm;
  if(d) d.style.background=(state&&state.repo&&typeof projColor==='function')?projColor(state.repo):'var(--muted)';
  const set=(id, v)=>{ const e=$id(id); if(!e) return; e.hidden=!v; e.textContent=v>99?'99+':String(v||''); };
  set('meuCnt', ev); set('memCnt', mem); set('issuesCnt', iss);
  { const h=$id('sbAbertasH'); if(h){ const v=`Abertas${ab?` <span class="n">· ${esc(ab)}</span>`:''}`; if(h.innerHTML!==v) h.innerHTML=v; } }
  // rótulo "Issues" + o nome do painel conectado (vem de qualquer painel com conector, nunca de um só fornecedor)
  const ib=$id('issuesBtn'); if(ib){ const l=ib.querySelector('.sbl'); const h=src?`Issues <span class="sbsrc">${esc(src)}</span>`:'Issues'; if(l && l.innerHTML!==h) l.innerHTML=h; }
}

// ===================== fiação das páginas =====================
function semWire(pg, k){
  pg.querySelectorAll('[data-semopen]').forEach(el=>{ el.onclick=(e)=>{ const b=e.target.closest('button'); if(b && b!==el) return; semAbrir(semFind(el.dataset.semopen)); };
    if(el.getAttribute('role')==='button') el.onkeydown=(e)=>{ if(e.target===el && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); el.click(); } }; });
  pg.querySelectorAll('[data-semmenu]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); semMenu(b, semFind(b.dataset.semmenu)); });
  pg.querySelectorAll('[data-semdev]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); semDevolver(b, semFind(b.dataset.semdev)); });
  pg.querySelectorAll('[data-semassumir]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); semPassar(semFind(b.dataset.semassumir), semMe()); });
  pg.querySelectorAll('[data-semdia]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); semAberto=semAberto===b.dataset.semdia?'':b.dataset.semdia; semRepintar(); });
  pg.querySelectorAll('[data-semmodo]').forEach(b=>b.onclick=()=>{ semModo=b.dataset.semmodo==='dist'?'dist':'grade'; lsSet('sem:modo', semModo); semRepintar(); });
  pg.querySelectorAll('[data-semsel]').forEach(el=>{ el.onclick=(e)=>{ if(e.target.closest('button')) return; semSelQ=semSelQ===el.dataset.semsel?'':el.dataset.semsel; semRepintar(); const n=pg.querySelector(`[data-semsel="${CSS.escape(el.dataset.semsel)}"]`); if(n) n.focus(); };
    el.onkeydown=(e)=>{ if(e.target===el && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); el.click(); } }; });
  pg.querySelectorAll('[data-semtime]').forEach(b=>b.onclick=()=>semIr('pessoas'));
  pg.querySelectorAll('[data-semep]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(b.dataset.semep); });
  pg.querySelectorAll('[data-sempad]').forEach(b=>b.onclick=()=>{ const a=semPadraoAgora&&semPadraoAgora.abrir; semIr(SEM_PADRAO_ABRIR.includes(a)?a:'skills'); });
  pg.querySelectorAll('[data-sement]').forEach(b=>b.onclick=()=>{ semEntPer=b.dataset.sement; lsSet('sem:entper', semEntPer); semEntregasCarimbos(); semRepintar(); });
  pg.querySelectorAll('[data-semrel]').forEach(b=>b.onclick=()=>{ semRelOn=!semRelOn; semRepintar(); });
  pg.querySelectorAll('[data-semcopiar]').forEach(b=>b.onclick=async()=>{ const t=($id('semRelTx')||{}).textContent||''; try{ await navigator.clipboard.writeText(t); toast('Relatório copiado — é só colar.','ok'); }catch(_){ try{ await window.__TAURI__.clipboardManager.writeText(t); toast('Relatório copiado — é só colar.','ok'); }catch(e){ showErr(e, 'Não consegui copiar'); } } });
  pg.querySelectorAll('[data-semrelfull]').forEach(b=>b.onclick=()=>{ const r=semEntPeriodo(); const all=semCards();
    const dd=ms=>perFmtDay(ms); relGerar(b, { all, members:semPessoas(), f:{}, per:{ key:'custom', from:dd(r.from), to:dd(r.to-1) }, range:r, pe:all, escopo:(typeof entEscopo==='function'?entEscopo(false):'') }); });
  pg.querySelectorAll('[data-semgo]').forEach(b=>b.onclick=()=>semIr(b.dataset.semgo));
  pg.querySelectorAll('[data-semguia]').forEach(b=>b.onclick=()=>semGuiaIniciar(b.dataset.semguia));
  if(k==='meu') pg.querySelectorAll('[data-meva]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const [i,j]=b.dataset.meva.split(':').map(Number); const a=((meuEvAtual[i]||{}).a||[])[j]; if(!a) return; if(a.menu) semMenu(b, a.x); else a.act(); });
  // arrastar entre pessoas (o teclado tem o Passar ▾ com os números)
  pg.querySelectorAll('[data-semdrag][draggable="true"]').forEach(el=>el.addEventListener('dragstart', ev=>{ ev.dataTransfer.setData('text/plain', el.dataset.semdrag); ev.dataTransfer.effectAllowed='move'; }));
  pg.querySelectorAll('[data-semdrop]').forEach(el=>{
    el.addEventListener('dragover', ev=>{ ev.preventDefault(); el.classList.add('semover'); });
    el.addEventListener('dragleave', ()=>el.classList.remove('semover'));
    el.addEventListener('drop', ev=>{ ev.preventDefault(); el.classList.remove('semover'); const x=semFind(ev.dataTransfer.getData('text/plain')); if(!x||!x.card) return;
      const to=el.dataset.semdrop||''; if((x.card.assignee||'')===to) return;
      if(!to){ semDevolver(el, x); return; } semPassar(x, to, 'arrastada'); });
  });
}
// teclas da Distribuir: com um cartão de Sem dono selecionado, 1–9 manda pra pessoa n; A abre o menu
document.addEventListener('keydown', e=>{
  if(semAtiva()!=='semana' || semModo!=='dist' || !semSelQ || semPopEl) return;
  if(e.metaKey||e.ctrlKey||e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target&&e.target.tagName)||'') || (e.target&&e.target.closest&&e.target.closest('.xterm'))) return;
  const x=semFind(semSelQ); if(!x) return;
  if(/^[1-9]$/.test(e.key)){ const uid=semPessoas()[+e.key-1]; if(uid){ e.preventDefault(); semPassar(x, uid, 'tecla '+e.key); } return; }
  if(e.key==='a'||e.key==='A'){ const b=document.querySelector(`#semanaPage [data-semmenu="${CSS.escape(semSelQ)}"]`); if(b){ e.preventDefault(); semMenu(b, x); } }
});

// ===================== render: as páginas acompanham o estado (sem timer novo) =====================
let semBootFeito=false;
if(typeof render==='function' && !render.__sem){ const r0=render; render=function(){ const out=r0.apply(this, arguments);
    try{
      semSideSync();
      const k=semAtiva(); if(k && k!=='mapa'){ semPaint(k); semBuscaTime(); }
      // 1º estado com projeto: o app abre em Meu trabalho (a Central continua fixa na barra de abas)
      if(!semBootFeito && typeof state!=='undefined' && state.repo && typeof activeTab!=='undefined'){ semBootFeito=true; if(activeTab==='flow' && lsGet('sem:inicio')!=='central') openTab('meu'); }
      if(semGuia) semGuiaRealce();
    }catch(e){ console.error('semana render', e); }
    return out; }; render.__sem=true; }
window.addEventListener('sf:pessoas', ()=>semRepintar());
semSideSync();
