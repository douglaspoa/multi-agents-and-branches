// Roteiro do e2e do COMANDO (build de teste isolada): o chat de verdade, pelo caminho de verdade (cmdSay → comando_plan no
// Rust → IA falsa → plano → cartões). Pega o que os testes de unidade não pegam: corte do pedido, busca rodando no app,
// issue achada por pedaço de descrição. Dados fictícios.
(async()=>{
const R=(l)=>invokeQuiet('e2e_report',{ line:String(l) }).catch(()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=30000,step=250)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ try{ const v=await fn(); if(v) return v; }catch(_){ } await sleep(step); } return null; };
const T=id=>(state.tasks||[]).find(t=>t.id===id);
const ok=(name, v, extra)=>R((v?'OK   ':'FALHA ')+name+(extra?' · '+extra:''));
window.addEventListener('error', e=>R('ERRO js '+e.message+' @'+String(e.filename||'').split('/').pop()+':'+e.lineno));
window.addEventListener('unhandledrejection', e=>R('ERRO promessa '+String((e.reason&&e.reason.message)||e.reason).slice(0,200)));
try{
  await until(()=>(state.tasks||[]).length>=40, 60000);
  await R('BOOT '+(state.tasks||[]).length+' tarefas');
  // painel de issues falso, já carregado (sem rede): 6 issues com descrição + 44 parecidas entre si
  const st=[{ id:'todo', label:'Backlog', kind:'todo' }, { id:'doing', label:'Em andamento', kind:'doing' }, { id:'done', label:'Concluído', kind:'done' }];
  const base=[['LW-300','Frete grátis acima de 200','Hoje o frete é sempre cobrado. Regra nova: pedidos acima de R$ 200 têm frete grátis.'],['LW-301','Exportar pedidos em CSV','O financeiro precisa baixar a planilha de pedidos do mês.'],
    ['LW-302','Login social','Permitir entrar com a conta do Google e da Apple, vinculando ao cadastro existente pelo e-mail.'],['LW-303','Tela de rastreio','O cliente acompanha a entrega com o código da transportadora.'],
    ['LW-304','Cupom de primeira compra','Desconto de 10% automático no primeiro pedido.'],['LW-305','Lentidão no carrinho','O carrinho demora mais de 4 segundos pra abrir quando há mais de 30 itens.']]
    .concat(Array.from({ length:44 }, (_, k)=>['LW-'+(400+k), ['Ajuste de layout no rodapé','Texto de ajuda do checkout','Ícones do menu lateral','Cor do botão de pagar'][k%4]+' '+(k+1), 'Pequeno ajuste visual pedido pelo time de produto.']));
  trkLoad=async()=>{}; trkFetchIssues=async()=>{};
  trk={ name:'Painel de teste', docs:'', connector:{ baseUrl:'http://127.0.0.1:9', ops:{ list:{} }, statuses:st, vars:[] }, vars:{}, projects:[], allProjects:true, rules:{} };
  trkIssues=base.map(([code,title,description])=>({ id:code, code, title, description, status:'todo', assignee:'', url:'' })); trkIssuesAt=Date.now();
  openTab('comando'); await until(()=>document.getElementById('cmdQ'), 15000); await sleep(800);
  await ok('painel falso ligado', cmdTrkOn() && trkIssues.length===50, trkIssues.length+' issues');
  // conversa longa: empurra o pedido pra além do teto antigo de 24 mil caracteres
  for(let k=0;k<16;k++) cmdMsgs().push(k%2?{ r:'bot', k:'txt', text:'Resposta antiga '+k+': '+'detalhe do andamento das tarefas, '.repeat(45) }:{ r:'you', text:'Pergunta antiga '+k+': '+'como está o andamento geral, '.repeat(45) });
  cmdPaint(true);
  const pede=async(tx)=>{ const n=cmdMsgs().length; await cmdSay(tx); await until(()=>!CMD.busy && cmdMsgs().length>n+1, 40000); await sleep(600); return cmdMsgs().slice(n+1); };
  const desc=L=>L.map(m=>m.r+':'+(m.k||'')+(m.code?'='+m.code:'')+(m.text?' «'+String(m.text).slice(0,70)+'»':'')+(m.itens?' ['+m.itens.map(i=>i.code).join(',')+']':'')).join(' | ');
  lsSet('cmdmotor','plano'); // 1ª parte: o planejador de uma chamada (o caminho de reserva)
  let L=await pede('ola');
  await ok('"ola" recebe conversa, não cartão de tarefa', L.some(m=>m.r==='bot' && /Oi!/.test(m.text||'')) && !L.some(m=>['tarefa','status','porque','provas'].includes(m.k)), desc(L));
  L=await pede('o que diz aquela issue de entrar com a conta do google?');
  await ok('issue achada por pedaço da DESCRIÇÃO (busca do app → planejador → cartão)', L.some(m=>m.k==='issdet' && m.code==='LW-302'), desc(L));
  await sleep(500); await R('SHOT comando-issue');
  L=await pede('detalha a issue do carrinho');
  await ok('alvo descritivo ("carrinho demorando") vira a issue certa', L.some(m=>m.k==='issdet' && m.code==='LW-305'), desc(L));
  L=await pede('mostra o ajuste do rodapé');
  await ok('várias parecidas → pergunta qual, com as candidatas', L.some(m=>m.k==='issqual' && (m.itens||[]).length>=2), desc(L));
  L=await pede('procura a issue da banana');
  await ok('nada parecido → diz o que procurou', L.some(m=>/Procurei/.test(m.text||'')), desc(L));
  await R('SHOT comando-final');
  // ---------------- AGENTE: o caminho padrão. IA falsa, mas ponte, ferramentas, cartões e confirmação são os de verdade
  lsSet('cmdmotor','');
  const fala=L=>{ const m=L.filter(x=>x.r==='bot' && x.k==='md').pop(); return m?String(m.text||''):''; };
  L=await pede('ola');
  await ok('agente: conversa simples responde', /Oi! Tudo certo/.test(fala(L)), desc(L));
  L=await pede('o que diz a issue do google?');
  await ok('agente: ferramenta "ver issue" acha por descrição, devolve o conteúdo e desenha o cartão', /LIDO: Issue LW-302/.test(fala(L)) && /Google e da Apple/.test(fala(L)) && L.some(m=>m.k==='issdet' && m.code==='LW-302'), desc(L)+' · '+fala(L).slice(0,120));
  L=await pede('busca o carrinho');
  await ok('agente: ferramenta "buscar" devolve a issue certa em primeiro', /ACHEI: \[issue\] LW-305/.test(fala(L)), fala(L).slice(0,140));
  L=await pede('como estão as tarefas?');
  await ok('agente: "ver geral" devolve as 42 tarefas em texto, sem encher o chat de cartão', /GERAL: /.test(fala(L)) && (fala(L).match(/rascunho|Rascunho/g)||[]).length>=20 && !L.some(m=>m.k==='status'), 'linhas='+fala(L).split('\n').length+' · '+desc(L).slice(0,120));
  L=await pede('faz em dois passos');
  await ok('agente: dois passos na mesma resposta (buscar → ver)', /A: \[issue\] LW-301/.test(fala(L)) && /B: Issue LW-301/.test(fala(L)), fala(L).slice(0,200));
  L=await pede('ação desconhecida');
  await ok('agente: ação que não existe volta como erro pro agente, sem executar nada', /RES: Ação desconhecida/.test(fala(L)), fala(L).slice(0,120));
  // confirmação: recusa DIGITANDO "não" (é o mesmo caminho da voz)
  { const n=cmdMsgs().length; const pr=cmdSay('encerra a t1'); const card=await until(()=>cmdMsgs().slice(n).find(m=>m.k==='plano' && m.agente && !m.done), 20000);
    await ok('agente: ação sem volta mostra o cartão e ESPERA', !!card && !taskEncerrada(T('t1')), card?'cartão na tela':'sem cartão');
    await R('SHOT agente-confirma'); await cmdSay('não'); await pr; await until(()=>!CMD.busy, 20000); await sleep(500);
    await ok('agente: "não" digitado recusa — nada é encerrado e o agente fica sabendo', /RECUSOU/.test(fala(cmdMsgs().slice(n))) && !taskEncerrada(T('t1')), fala(cmdMsgs().slice(n)).slice(0,120)); }
  // confirmação: aceita clicando
  { const n=cmdMsgs().length; const pr=cmdSay('encerra a t1'); const card=await until(()=>cmdMsgs().slice(n).find(m=>m.k==='plano' && m.agente && !m.done), 20000);
    const b=card && await until(()=>document.querySelector(`[data-cmdplano="${cmdMsgs().indexOf(card)}"][data-ok="1"]`), 5000); if(b) b.click(); await pr; await until(()=>!CMD.busy, 40000); await sleep(800);
    await ok('agente: "Sim" no cartão executa de verdade e o resultado volta pro agente', /RES: A pessoa confirmou/.test(fala(cmdMsgs().slice(n))) && (!T('t1') || taskEncerrada(T('t1'))), fala(cmdMsgs().slice(n)).slice(0,160)+' · t1='+(T('t1')?T('t1').status:'sumiu')); }
  // ferramentas que não sobem: não aceita a resposta inventada, cai no planejador
  L=await pede('falha mcp');
  await ok('agente: servidor de ferramentas falhou → resposta inventada é descartada e o planejador atende', !/fingindo/.test(desc(L)+fala(L)) && L.some(m=>m.r==='bot'), desc(L));
  await ok('agente: guardou a sessão pra lembrar da conversa', lsGet('cmdagsid:'+cmdRepo())==='fake-ag-1', lsGet('cmdagsid:'+cmdRepo()));
  await R('SHOT agente-final');
  // áudio: o que este WebView oferece (não liga o microfone aqui — pediria permissão na tela)
  let vozes=0; try{ vozes=speechSynthesis.getVoices().length; }catch(_){ }
  await R('VOZ reconhecimento='+(cmdVoiceApi()?'disponível':'INDISPONÍVEL')+' · síntese='+(window.speechSynthesis?'sim':'não')+' · vozes='+vozes+' · linha de estado='+(!!document.getElementById('cmdVozSt')));
  // menu do "/": fecha ao apagar
  { const q=document.getElementById('cmdQ'), b=document.getElementById('cmdAc'); q.value='/'; q.setSelectionRange(1,1); q.dispatchEvent(new Event('input')); const aberto=getComputedStyle(b).display!=='none'; q.value=''; q.dispatchEvent(new Event('input'));
    await ok('menu do "/" abre e fecha', aberto && getComputedStyle(b).display==='none'); }
  await ok('sem barra de destino nem painel lateral', !document.getElementById('cmdAlvo') && (document.getElementById('cmdSide')||{ hidden:true }).hidden!==false);
}catch(e){ await R('ERRO roteiro '+String((e&&e.stack)||e).slice(0,400)); }
await R('FIM');
})();
