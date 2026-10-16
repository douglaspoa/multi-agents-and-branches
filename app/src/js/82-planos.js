// Starfork — 82-planos: aba "Planos" (Grátis × Pro × Empresa) e os CTAs de upgrade das superfícies de nuvem (plano Grátis, F1).
// Matriz resumida da decisão do dono (party-preco, seção 9). Regras (vetos da mesa):
//  - o CTA só aparece no PRIMEIRO USO DE NUVEM (convidar, quadro do time, celular, link pro cliente, épico do time…);
//  - nunca dentro do plano, da prova ou do portão, e nunca contador de limite em recurso local;
//  - sempre com a alternativa grátis quando ela existe (relatório local de Entregas, prova no próprio PR, Dividir).
// Tela nova = ABA (VIEW_META/VIEW_OVERLAY/viewOpen), nunca modal.
// @puro-planos-inicio — textos e decisões puras (testadas em app/tests/plano-gratis.test.mjs)
const PLANOS=[
  { id:'gratis', nome:'Grátis', preco:'R$0', per:'sem cartão', lead:'Tudo no seu computador, sem limite.',
    itens:['Demandas, projetos e agentes em paralelo, sem limite','Plano, requisitos, provas e o portão — no seu disco','Várias IAs, previsão de custo, teto e aba Uso','Memória, mesa, piloto automático e exportação total','Relatório de entregas em PDF/HTML pra mandar ao cliente'] },
  { id:'pro', nome:'Pro', preco:'R$29', per:'por criador por mês · R$290/ano', lead:'Aprovadores ilimitados de graça.', hot:true,
    itens:['Tudo do Grátis','Quadro do time na nuvem','App de celular e push','Provas na nuvem','Links de entrega pro cliente','Memória sincronizada entre máquinas e pessoas'] },
  { id:'empresa', nome:'Empresa', preco:'R$79', per:'por criador por mês · mínimo de 5', lead:'Pra organização com regra e auditoria.',
    itens:['Tudo do Pro','Política da organização (portão obrigatório)','Auditoria completa','SSO'] },
];
const PLANOS_RODAPE='Abre sem login e sem rede; cancelar não trava nada local.';
// motivo + preço + alternativa grátis de cada superfície de nuvem
const UPGRADE={
  convite:{ t:'Convidar alguém é do Pro', p:'Quem cria custa R$29/mês, quem só aprova não paga.', alt:'No Grátis, cada pessoa roda o Starfork no próprio computador e a prova vai no próprio PR.' },
  time:{ t:'O quadro do time na nuvem é do Pro', p:'R$29 por criador por mês; quem só aprova não paga.', alt:'Usar com o time no Grátis: cada pessoa no próprio computador, e a prova vai no próprio PR.' },
  celular:{ t:'Abrir no celular é do Pro', p:'O app de celular e o push usam a nuvem do Starfork: R$29 por criador por mês.', alt:'No Grátis, abra a prévia neste computador.' },
  cliente:{ t:'Link pro cliente é do Pro', p:'O cliente abre sem conta, direto da nuvem: R$29 por criador por mês.', alt:'No Grátis: gere o relatório local em Entregas (PDF ou HTML) e mande você mesmo.', altBtn:['entregas','abrir Entregas'] },
  epico:{ t:'Épico no quadro do time é do Pro', p:'R$29 por criador por mês; quem só aprova não paga.', alt:'No Grátis: divida em etapas neste computador (Dividir) — a próxima começa quando a anterior provar.', altBtn:['orq','abrir Dividir'] },
  sync:{ t:'Usar em outro computador é do Pro', p:'Quadro e memória sincronizados entre máquinas e pessoas: R$29 por criador por mês.', alt:'No Grátis, a memória fica no disco do projeto (.cardume) e pode ir junto no git.' },
  empresa:{ t:'Regras da organização são do Empresa', p:'R$79 por criador por mês (mínimo de 5): política da org, auditoria e SSO.', alt:'' },
};
function upgradeInfo(feature){ return UPGRADE[feature]||UPGRADE.time; }
// o que o botão "Assinar o Pro" faz agora: sem conta → entrar (e depois os planos) · cobrança ligada → os planos do
// Stripe que já existem · desligada (ou ainda não lida) → "abre em breve", sem botão que não funciona
function planosAssinarAcao(hasSess, billingOnNow){
  if(!hasSess) return 'entrar';
  if(billingOnNow) return 'checkout';
  return 'embreve'; // desligada ou ainda não lida: nada de checkout que não existe
}
// @puro-planos-fim

function upgradeCtaHtml(feature, o){
  o=o||{}; const u=upgradeInfo(feature), sess=typeof SB!=='undefined' && !!SB.sess();
  const alt=u.altBtn?`<button type="button" class="btn sm" data-upalt="${escA(u.altBtn[0])}">${esc(u.altBtn[1])}</button>`:'';
  // cobrança desligada: entrar numa conta já liga a nuvem do time (quem é do time Enterprise numa máquina nova)
  const entrar=sess?'':`<button type="button" class="upcta-entrar" data-upentrar>já tem conta? entrar</button>`;
  return `<section class="upcta${o.compact?' compact':''}" data-upcta="${escA(feature)}" role="note"><div class="upcta-t"><b>${esc(u.t)}</b><p>${esc(u.p)}</p>${u.alt?`<p class="upcta-alt">${esc(u.alt)}</p>`:''}</div>`
    +`<div class="upcta-acts"><button type="button" class="btn primary sm" data-upgo>ver os planos</button>${alt}${entrar}</div></section>`;
}
function upgradeCtaWire(root){
  if(!root) return;
  root.querySelectorAll('[data-upgo]').forEach(b=>b.onclick=()=>planosOpen());
  root.querySelectorAll('[data-upalt]').forEach(b=>b.onclick=()=>{ if(window.openTab) window.openTab(b.dataset.upalt); });
  root.querySelectorAll('[data-upentrar]').forEach(b=>b.onclick=()=>contaEntrar());
}
// o mesmo recado em toast, pras ações soltas (menu da tarefa, atalhos) — o botão abre a aba Planos
function upgradeToast(feature){
  const u=upgradeInfo(feature);
  const acts=[{ label:'ver os planos', fn:()=>planosOpen() }];
  if(u.altBtn) acts.push({ label:u.altBtn[1], fn:()=>{ if(window.openTab) window.openTab(u.altBtn[0]); } });
  toast(u.t+' — '+u.p+(u.alt?' '+u.alt:''), 'info', acts[0], acts[1]);
}
// "Entrar na conta" opcional (lateral, Ajustes, CTAs): a tela de entrada sempre pode ser fechada
function contaEntrar(o){
  if(typeof auShow!=='function') return;
  auShow(lsGet('sb:email')?'login':'signup', Object.assign({ backTo:()=>{} }, o||{}));
}
window.upgradeCtaHtml=upgradeCtaHtml; window.upgradeCtaWire=upgradeCtaWire; window.upgradeToast=upgradeToast; window.contaEntrar=contaEntrar;

// ---------------------------------------------------------------- aba Planos
let planosMsg='';
function planosOpen(){ if(window.openTab) window.openTab('planos'); }
window.planosOpen=planosOpen;
function planosEspacoTxt(){
  if(typeof cloudAllowed==='function' && cloudAllowed()){
    const org=(typeof cloudData!=='undefined' && cloudData && cloudData.org && cloudData.org.name)||'';
    return 'Seu espaço está na nuvem'+(org?' da '+org:'')+': quadro do time, celular e sync ligados.';
  }
  const sess=typeof SB!=='undefined' && !!SB.sess();
  return sess?'Sua conta está no Grátis: tudo roda no seu computador. A nuvem do time é do Pro.':'Você está no Grátis: tudo roda no seu computador, sem conta.';
}
function planosHtml(){
  const local=typeof isLocalSpace!=='function' || isLocalSpace();
  const head=(typeof pageHead==='function')?pageHead({ title:'Planos', sub:'Grátis pra sempre no seu computador. Pague só quando o time precisar da nuvem.' })
    :'<header class="pghead"><h1 class="pgh-title">Planos</h1></header>';
  const card=p=>{
    const atual=(p.id==='gratis' && local) || (p.id!=='gratis' && !local && p.id==='pro');
    const btn=p.id==='pro'?`<button type="button" class="btn primary" id="plnAssinar">Assinar o Pro</button>`
      : p.id==='empresa'?`<p class="pln-cta-t">Fale com a gente pelo site: starfork.com.br/precos</p>`
      : (atual?'<p class="pln-cta-t">É o seu plano agora.</p>':'');
    return `<article class="pln-card${p.hot?' hot':''}${atual?' atual':''}" data-plano="${p.id}"><header><b class="pln-nome">${esc(p.nome)}</b>${atual?'<span class="pln-tag">seu espaço</span>':''}</header>
      <div class="pln-preco"><span class="pln-v">${esc(p.preco)}</span><span class="pln-per">${esc(p.per)}</span></div>
      <p class="pln-lead">${esc(p.lead)}</p><ul>${p.itens.map(i=>`<li>${esc(i)}</li>`).join('')}</ul><div class="pln-cta">${btn}</div></article>`;
  };
  return `${head}<div class="pgbody"><div class="pln-page"><p class="pln-espaco" role="status">${esc(planosEspacoTxt())}</p>
    ${planosMsg?`<div class="pln-msg" role="status">${planosMsg}</div>`:''}
    <div class="pln-grid">${PLANOS.map(card).join('')}</div><p class="pln-rodape">${esc(PLANOS_RODAPE)}</p></div></div>`;
}
function planosPaint(){
  const pg=$id('planosPage'); if(!pg) return;
  pg.innerHTML=planosHtml();
  bindClick('plnAssinar', ()=>planosAssinar());
}
function planosAssinar(){
  const sess=typeof SB!=='undefined' && !!SB.sess();
  const a=planosAssinarAcao(sess, typeof billingOn!=='undefined' && billingOn);
  if(a==='entrar'){ planosMsg='Pra assinar, entre na sua conta — depois você escolhe o plano.'; planosPaint(); contaEntrar({ wantPlans:true, backTo:()=>planosOpen() }); return; }
  if(a==='checkout'){ if(typeof auShow==='function') auShow('plans', { backTo:()=>planosOpen() }); return; }
  planosMsg='A assinatura abre em breve. Os preços ficam em starfork.com.br/precos.'; planosPaint();
}
window.planosAssinar=planosAssinar;
if(typeof VIEW_META!=='undefined'){
  VIEW_META.planos={ title:'Planos', icon:'<path d="M2.5 5.5h11v7.5h-11z" stroke-linejoin="round"/><path d="M2.5 8h11M5 11h2" stroke-linecap="round"/>' };
  VIEW_OVERLAY.planos='planosOverlay';
}
if(typeof viewOpen==='function' && !viewOpen.__pln){ const vo=viewOpen; viewOpen=function(kind){
    if(kind==='planos'){ planosPaint(); if(typeof ovShow==='function') ovShow('planosOverlay'); return; }
    return vo.apply(this, arguments); }; viewOpen.__pln=true; }
// o espaço mudou (entrou, saiu, assinou): a aba aberta se redesenha
window.addEventListener('sf:espaco-mudou', ()=>{
  planosMsg=''; const o=$id('planosOverlay'); if(o && o.style.display!=='none') planosPaint();
  // as superfícies de nuvem abertas se redesenham (CTA ↔ conteúdo do time) — sem esperar o próximo clique
  try{ if(typeof teamPaintSig!=='undefined') teamPaintSig=''; if(typeof renderTeamBoard==='function') renderTeamBoard(); }catch(_){ }
  try{ if(typeof activeTab!=='undefined' && activeTab==='cfg' && typeof ajSectionPaint==='function') ajSectionPaint(); }catch(_){ }
  try{ if(typeof secretsCache!=='undefined') secretsCache=null; }catch(_){ } // as chaves passam a vir do outro lugar (llm.env × cofre)
});
