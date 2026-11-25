// Roteiro do e2e do COMANDO (build de teste isolada): o chat de verdade, pelo caminho de verdade (cmdSay → comando_plan no
// Rust → IA falsa → plano → cartões). Pega o que os testes de unidade não pegam: corte do pedido, busca rodando no app,
// issue achada por pedaço de descrição. Dados fictícios.
(async()=>{
const R=(l)=>invokeQuiet('e2e_report',{ line:String(l) }).catch(()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=30000,step=250)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ try{ const v=await fn(); if(v) return v; }catch(_){ } await sleep(step); } return null; };
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
