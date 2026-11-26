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
  L=await pede('anota isso na memória');
  await ok('agente: anota na memória do projeto (grava de verdade) e lê de volta pelo assunto', /ANOTEI: .*Anotei na memória/.test(fala(L)) && /LI: .*PR passa por homol/.test(fala(L)) && /Todo PR vai pra homol/.test(fala(L)), fala(L).slice(0,260));
  { let n=[]; try{ n=((await invoke('memory_list',{ repo:cmdRepo(), withBody:true }))||{}).notes||[]; }catch(_){ } await ok('agente: a nota está na memória do projeto, como regra', n.some(x=>x.title==='PR passa por homol' && x.type==='regra'), n.map(x=>x.title+'/'+x.type).join(', ')); }
  L=await pede('quais skills?');
  await ok('agente: "ver skills" responde (lista ou biblioteca vazia)', /SKILLS: (.*Skills \(|.*Nenhuma skill)/.test(fala(L)), fala(L).slice(0,140));
  L=await pede('usa um nome errado');
  await ok('agente: nome de ação errado volta ensinando o certo', /NADA foi feito/.test(fala(L)) && /anotar_memoria/.test(fala(L)), fala(L).slice(0,160));
  L=await pede('olha a página de pedidos');
  await ok('agente: olhar página sem ambiente disponível devolve o motivo, sem travar', /OLHEI: Não consegui subir o ambiente/.test(fala(L)), fala(L).slice(0,200));
  { let e1=''; try{ await invoke('comando_pagina_foto',{ taskId:'t2', url:'https://example.com/' }); }catch(e){ e1=String((e&&e.message)||e); }
    await ok('foto de página: recusa endereço que não é local', /local/.test(e1), e1.slice(0,90));
    let f=null, e2=''; const t0=Date.now(); try{ f=await invoke('comando_pagina_foto',{ taskId:'t2', url:'http://127.0.0.1:4191/pedidos.html' }); }catch(e){ e2=String((e&&e.message)||e); }
    await ok('foto de página: fotografa e lê uma página local de verdade, sem janela', !!(f && /\.png$/.test(f.png) && /\.html$/.test(f.html)), f?('em '+Math.round((Date.now()-t0)/1000)+' s com '+f.navegador):e2.slice(0,160));
    if(f) await R('FOTO '+f.png+' '+f.html); }
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
  // abrir no próprio Starfork: o código que a tarefa editou (aba da tarefa, no arquivo) e a imagem entregue (aba Documento)
  const ref3=((cmdRefs().find(r=>r.id==='t3'))||{}).ref||'t3';
  { const n=cmdMsgs().length; cmdSay('abre o código da '+ref3); await until(()=>!CMD.busy && /ABRI: /.test(fala(cmdMsgs().slice(n))), 40000); await sleep(1500);
    const tab=TABS.find(x=>x.id==='task:t3'), tx=fala(cmdMsgs().slice(n));
    await ok('abrir código: o agente abre o arquivo mais alterado na aba da tarefa', !!tab && tab.path==='src/frete.ts' && activeTab==='task:t3' && /Abri src\/frete\.ts/.test(tx) && /versao\.ts/.test(tx), tx.slice(0,170)+' · aba='+(tab?tab.path:'não abriu')+' · ativa='+activeTab);
    const visto=await until(()=>typeof fwPath!=='undefined' && fwPath==='src/frete.ts' && /startsWith/.test(String(fwContent||'')+document.body.innerText), 12000);
    await ok('abrir código: o arquivo editado aparece na tela da tarefa', !!visto, 'fwPath='+(typeof fwPath!=='undefined'?fwPath:'?')); await sleep(400); await R('SHOT abrir-codigo'); await sleep(900);
    openTab('comando'); await until(()=>document.getElementById('cmdQ'), 15000); await sleep(500); }
  { const n=cmdMsgs().length; cmdSay('abre a imagem da '+ref3); await until(()=>!CMD.busy && /ABRI: /.test(fala(cmdMsgs().slice(n))), 40000); await sleep(1500);
    const tab=TABS.find(x=>x.kind==='doc' && x.taskId==='t3' && x.ref==='art:proof-1.png'), tx=fala(cmdMsgs().slice(n));
    await ok('abrir imagem: o agente abre a imagem entregue numa aba do Starfork', !!tab && /Abri proof-1\.png \(imagem\)/.test(tx), tx.slice(0,170)+' · aba='+(tab?tab.id:'não abriu'));
    const img=await until(()=>[...document.querySelectorAll('.cvdoc img, .cvpb img')].find(i=>i.naturalWidth>0), 12000);
    await ok('abrir imagem: a imagem carrega dentro do app, sem aviso de erro', !!img && !document.querySelector('.toast.warn, .toast.err, .toast.bad'), (img?img.naturalWidth+'px':'sem <img> carregada')+' · avisos='+[...document.querySelectorAll('.toast')].map(t=>t.textContent.slice(0,50)).join(' | ')); await sleep(400); await R('SHOT abrir-imagem'); await sleep(900);
    openTab('comando'); await until(()=>document.getElementById('cmdQ'), 15000); await sleep(500); }
  // voz tratada: o app grava a fala com a voz do macOS, decodifica e toca pela cadeia de filtros (sem ligar o microfone)
  { let wav=''; try{ wav=await invokeQuiet('comando_fala',{ texto:'Teste da voz tratada.', voz:'', ritmo:190 }); }catch(e){ wav='ERRO '+String((e&&e.message)||e); }
    await ok('voz tratada: o app grava a fala do macOS em WAV', /^UklGR/.test(wav) && wav.length>20000, String(wav).slice(0,40)+' · '+String(wav).length);
    CMDV.on=true; CMDV.fxFalhou=false; const antes=CMDV.falaSeq||0; let listen=0; const orig=cmdVoiceListen; cmdVoiceListen=(x)=>{ if(x) listen++; };
    try{ cmdSpeak('Teste da voz tratada.'); const tocou=await until(()=>!!CMDV.src, 8000); const st=CMDV.ctx?CMDV.ctx.state:'sem contexto'; const dur=CMDV.src&&CMDV.src.buffer?CMDV.src.buffer.duration:0;
      await ok('voz tratada: decodifica e começa a tocar pelos filtros', !!tocou && dur>0.5 && !CMDV.fxFalhou, 'contexto='+st+' · duração='+dur+' · falhou='+!!CMDV.fxFalhou);
      const acabou=await until(()=>!CMDV.speaking, 9000);
      await ok('voz tratada: ao terminar de falar volta a ouvir', st!=='running' || (!!acabou && listen>0), 'contexto='+st+' · acabou='+!!acabou+' · voltou a ouvir='+listen);
      cmdSpeak('Outra frase mais comprida para dar tempo de interromper no meio da fala.'); await until(()=>!!CMDV.src, 8000); cmdVozCala();
      await ok('voz tratada: calar interrompe na hora', !CMDV.src && (CMDV.falaSeq||0)>antes); }
    finally{ cmdVoiceListen=orig; CMDV.on=false; CMDV.speaking=false; cmdVozCala(); } }
  // NÚCLEO DA VOZ: com a voz ligada aparece o anel; ele segue quem está com a palavra e desenha o áudio real da fala
  { const hud=()=>document.getElementById('cmdHud'), tinta=()=>{ const cv=document.getElementById('cmdHudCv'); try{ const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>40) n++; return n; }catch(_){ return -1; } };
    await sleep(300); // a voz foi desligada no bloco acima SEM repintar: o núcleo tem que se acertar sozinho no quadro seguinte
    await ok('núcleo: com a voz desligada não aparece nem anima', hud() && hud().hidden && !CMDH.raf, 'hidden='+(hud()&&hud().hidden)+' raf='+CMDH.raf);
    const orig=cmdVoiceListen; cmdVoiceListen=()=>{}; CMDV.on=true; CMDV.fxFalhou=false;
    try{
      const frase='Três tarefas abertas: a do frete está rodando, a do login espera a sua resposta e a da versão está pronta para aprovar.';
      cmdSpeak(frase); await until(()=>!!CMDV.src, 8000); await sleep(700);
      let pico=0; try{ const f=new Uint8Array(CMDV.analisa.frequencyBinCount); for(let k=0;k<12 && pico<20;k++){ CMDV.analisa.getByteFrequencyData(f); pico=Math.max(pico, ...f); await sleep(80); } }catch(_){ }
      const rodando=CMDV.ctx && CMDV.ctx.state==='running';
      await ok('núcleo: falando — aparece, mostra a frase e o anel está desenhado', !hud().hidden && hud().dataset.estado==='falando' && document.getElementById('cmdHudL').textContent===frase && tinta()>300, 'estado='+hud().dataset.estado+' · tinta='+tinta()+' · linha='+document.getElementById('cmdHudL').textContent.slice(0,40));
      await ok('núcleo: as barras leem o áudio REAL da fala (analisador)', !rodando || pico>20, 'contexto='+(CMDV.ctx&&CMDV.ctx.state)+' · pico='+pico);
      await ok('núcleo: no modo voz as sugestões saem da frente', getComputedStyle(document.querySelector('.cmdchips')).display==='none');
      await sleep(300); await R('SHOT hud-falando'); await sleep(500); cmdVozCala(); CMDV.speaking=false;
      CMDV.live=true; cmdHudOuve('abre o código da tarefa do frete'); await sleep(300);
      await ok('núcleo: ouvindo — o que foi entendido aparece ao vivo', hud().dataset.estado==='ouvindo' && /abre o código/.test(document.getElementById('cmdHudL').textContent) && CMDH.energia>0.05, 'estado='+hud().dataset.estado+' · energia='+CMDH.energia);
      await sleep(200); await R('SHOT hud-ouvindo'); await sleep(500);
      CMDV.live=false; CMD.busy=true; const m0=CMDAG.msg; CMDAG.msg={ agora:'procurando “frete”…', acts:[] }; cmdHudPaint(); await sleep(300);
      await ok('núcleo: trabalhando — diz o que o agente faz agora', hud().dataset.estado==='pensando' && /procurando/.test(document.getElementById('cmdHudL').textContent), 'estado='+hud().dataset.estado);
      await sleep(200); await R('SHOT hud-trabalhando'); await sleep(500); CMD.busy=false; CMDAG.msg=m0;
    } finally { cmdVoiceListen=orig; CMDV.on=false; CMDV.live=false; CMDV.speaking=false; CMD.busy=false; cmdVozCala(); cmdVoicePaint(); }
    await sleep(200); await ok('núcleo: desligou a voz, some e para de animar', hud().hidden && !CMDH.raf && getComputedStyle(document.querySelector('.cmdchips')).display!=='none', 'hidden='+hud().hidden+' raf='+CMDH.raf); }
  // enquanto o agente trabalha aparece UMA bolha de andamento, não duas (26/11)
  { const ms=cmdMsgs(), m={ r:'bot', k:'agente', ag:true, state:'wait', text:'', agora:'pensando…', acts:[] }; ms.push(m); CMD.busy=true; cmdPaint(true); await sleep(150);
    const n=document.querySelectorAll('#cmdLog .pltyping').length; ms.splice(ms.indexOf(m),1); cmdPaint(true); await sleep(100); const n2=document.querySelectorAll('#cmdLog .pltyping').length; CMD.busy=false; cmdPaint(true);
    await ok('agente: uma bolha de "pensando…" só enquanto trabalha (e a genérica continua pro planejador)', n===1 && n2===1, 'com agente='+n+' · sem agente='+n2); }
  // chamada torta de "agir" (caso real de 26/11): volta pra IA e a pessoa NÃO vê cartão de confirmação
  { const n0=cmdMsgs().length; const r=await cmdAgFerramenta({ tool:'agir', args:{ acao:'epico_acao', alvo:'' } });
    await ok('agente: ação sem os campos volta pra IA sem mostrar cartão', /NADA foi feito/.test(r) && cmdMsgs().length===n0 && !CMDAG.espera, String(r).slice(0,120)+' · msgs '+n0+'→'+cmdMsgs().length);
    const r2=await cmdAgFerramenta({ tool:'agir', args:{ acao:'epico_acao', alvo:'Épico que não existe', texto:'comecar' } });
    await ok('agente: épico inexistente volta pra IA sem mostrar cartão', /não existe épico/.test(r2) && cmdMsgs().length===n0 && !CMDAG.espera, String(r2).slice(0,120)); }
  // menu do "/": fecha ao apagar
  { const q=document.getElementById('cmdQ'), b=document.getElementById('cmdAc'); q.value='/'; q.setSelectionRange(1,1); q.dispatchEvent(new Event('input')); const aberto=getComputedStyle(b).display!=='none'; q.value=''; q.dispatchEvent(new Event('input'));
    await ok('menu do "/" abre e fecha', aberto && getComputedStyle(b).display==='none'); }
  await ok('sem barra de destino nem painel lateral', !document.getElementById('cmdAlvo') && (document.getElementById('cmdSide')||{ hidden:true }).hidden!==false);
}catch(e){ await R('ERRO roteiro '+String((e&&e.stack)||e).slice(0,400)); }
await R('FIM');
})();
