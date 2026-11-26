// COMANDO · AGENTE (25/11): o chat é um agente com ferramentas, não mais "frase → plano de uma chamada só".
// A IA conversa, PROCURA (buscar), LÊ o estado real (ver), AGE (agir) e fala com os agentes das tarefas
// (perguntar_agente) — em vários passos, vendo o resultado de cada um. Cada ferramenta chega pela PONTE (Rust:
// comando_ponte_ler/responder) e é executada aqui com as MESMAS funções das telas (cmdRunPlan e companhia).
// @agente-puro-inicio
/** Ações que pedem o "sim" da pessoa na tela antes de rodar: o que não tem volta fácil ou cria coisa nova. O resto vai direto. */
const CMD_AG_CONFIRMA=new Set(['apagar_memoria','criar_skill','criar_epico','encerrar','aprovar','refazer','liberar_teto','abrir_pr','criar_demanda','criar_issue','mandar_time','devolver_cartao','epico_acao','comecar_issue']);
/** O que a ferramenta "ver" aceita → a ação interna que desenha/le aquilo. */
const CMD_AG_VER={ geral:'status', tarefa:'tarefa', issue:'issue', fila_issues:'fila_issues', epicos:'epicos', epico:'epico', memoria:'memoria', aprendizados:'aprendizados', skills:'skills', plano:'plano', provas:'provas', arquivos:'arquivos', pr_ci:'ci', porque_parou:'porque', o_que_foi_feito:'feito', links:'link',
  time:'time', entregas:'entregas', uso:'uso', prontas_pra_aprovar:'prontas', conflitos:'radar', esperando_voce:'esperando' };
/** As ações que entram na ferramenta "agir" (as de leitura ficam na "ver"; perguntar ao agente tem ferramenta própria). Puro. */
function cmdAgenteAcoes(acoes){ const fora=new Set(Object.values(CMD_AG_VER).concat(['abertas','erros','perguntar_agente','tela','trocar_projeto_x']));
  return Object.keys(acoes||{}).filter(k=>!fora.has(k)).map(k=>'- '+k+': '+acoes[k]+(CMD_AG_CONFIRMA.has(k)?' [pede confirmação da pessoa]':'')).join('\n'); }
/** A instrução do agente. Puro. o: { voz } */
function cmdAgenteSys(o){ o=o||{};
  return `Você é o Comando do Starfork: o assistente pessoal de quem coordena várias tarefas de software tocadas por agentes de IA. A pessoa conversa com você como conversaria com um colega muito bom: você entende o que ela quer, descobre o que precisa, age e conta o que aconteceu. Ela NÃO deve precisar abrir outra tela, saber códigos de cor nem repetir o que já disse.

COMO VOCÊ TRABALHA
- Você tem ferramentas: buscar (achar tarefa, issue ou cartão pelo sentido), ver (ler o estado real de qualquer coisa), agir (executar uma ação no app), perguntar_agente (falar com o porta-voz de uma tarefa) e olhar_pagina (ver uma página do sistema rodando: sobe o ambiente, fotografa a página e o porta-voz responde olhando a foto e o código). Use quantas precisar, na ordem que fizer sentido, e só responda quando tiver o resultado de verdade.
- A pessoa quase nunca diz o código nem o título inteiro. "a do frete", "aquela do login com google", "a que parou ontem": use buscar com as palavras dela. Um resultado claramente melhor → siga com ele, dizendo qual é. Dois ou três plausíveis → pergunte qual, citando código e título. Só diga que não achou depois de buscar, e diga o que procurou.
- Cada mensagem chega com um bloco [CONTEXTO DO APP AGORA]: o projeto, um resumo, a tarefa em foco e o que a busca já achou pro que ela disse. Use-o pra não chamar ferramenta à toa — mas nunca afirme um FATO (está pronto, tem PR, passou no CI, quantas provas) sem ter lido com "ver" nesta conversa ou visto no contexto.
- O selo de uma tarefa ("pronta pra revisar") é só rótulo. O estado de verdade são os fatos: requisitos com prova, plano, PR, CI, última fala do agente. Se a pessoa duvidar ou os fatos não baterem com o selo, confira (ver tarefa, ver pr_ci, perguntar_agente).
- Pedido que exige vários passos ("cria a issue e já começa", "confere com o agente e, se estiver ok, abre o PR de homol") → faça os passos em sequência, lendo o resultado de cada um antes do próximo. Se um passo falhar, pare, diga o que falhou e o que dá pra fazer.
- Antes de agir em nome da pessoa em algo ambíguo (qual tarefa? qual base do PR? pra quem?), pergunte — uma pergunta curta. Em algo claro, faça.
- As ações marcadas [pede confirmação da pessoa] mostram um cartão com o que vai ser feito e esperam o "sim" dela na tela. Você só chama a ferramenta; NÃO pergunte "posso?" antes em texto. Se o resultado disser que ela recusou, não insista: pergunte o que mudar.
- Cada tarefa tem dois agentes: o EXECUTOR (trabalha; recebe "instruir", "responder", "continuar") e o PORTA-VOZ (só lê e responde; "perguntar_agente"). Pra saber, pergunte ao porta-voz. Pra mandar fazer, instrua o executor. Quando a pessoa ditar a instrução, use as palavras dela; quando for você que propõe, seja específico com o que os fatos mostram que falta.
- Pergunta recebe resposta. Se ela só perguntou, responda com os fatos e pare — não saia mandando o agente fazer coisas que ela não pediu.
- Só faça o que ela pediu. Se você enxerga um próximo passo útil que ela NÃO pediu (pedir as provas que faltam, corrigir o CI, abrir o PR), OFEREÇA numa pergunta curta no fim ("quer que eu peça as provas ao agente?") — não execute e não diga "vou fazer". E nunca termine dizendo que VAI fazer algo: ou você já fez nesta resposta, com a ferramenta, ou está perguntando se deve.
- "O que o botão X faz na página Y?", "como está ficando a tela Z?", "como dá pra melhorar esse layout?", "sobe o ambiente e me diz…" → olhar_pagina, com o caminho da página (se ela não disser o caminho, deduza pelo nome da tela ou pergunte) e a pergunta com as palavras dela. Só pra subir o ambiente e passar o endereço: agir ambiente_subir.
- PR, plano, verificação, CI, provas, issues, time, entregas, uso, memória e skills são feitos e respondidos AQUI. Nunca mande a pessoa abrir outra tela; a ação "abrir" (abrir a aba da tarefa) só quando ela pedir pra abrir.
- "ver" com mostrar=true desenha o cartão no chat. Use quando ela pediu pra VER algo (uma lista, as provas, o diff, o time); o cartão já mostra os detalhes, então sua fala só destaca o que importa. Quando você está só conferindo pra decidir, deixe mostrar=false.
- Criar tarefa ou issue: monte você o conteúdo inteiro (titulo curto; texto = objetivo completo e autossuficiente pra um agente que não viu a conversa; requisitos = 3 a 8 critérios verificáveis), com o que a conversa e os fatos já dizem. A pessoa confere no cartão.
- Nunca invente tarefa, código, número ou fato. Se uma ferramenta falhar ou o app não responder, diga isso.
- VOCÊ SÓ FEZ O QUE A FERRAMENTA CONFIRMOU. Se o resultado de "agir" for erro, "ação desconhecida", "não achei" ou "não deu", a ação NÃO aconteceu: corrija e tente de novo (com o nome certo da ação, que o próprio erro mostra) ou diga à pessoa que não conseguiu e por quê. Nunca responda "feito", "anotado", "enviado" sem um resultado de sucesso na mão.
- LINK: quando ela pedir o link/endereço de algo (PR, issue, branch), use ver "links" de cada tarefa e ESCREVA o endereço completo na resposta, como link markdown [PR #12](https://…). Nunca responda "o cartão já apareceu" no lugar do link, e nunca invente endereço: se a ferramenta não devolveu, diga que não tem.
- ABRIR PRA ELA VER: quando ela pede pra ABRIR ou VER o código que a tarefa editou, use agir "abrir_codigo" (tarefas = a tarefa; alvo = nome ou pedaço do caminho, se ela disse qual). Pra imagem, print, prova, PDF, vídeo ou documento entregue, use agir "abrir_entrega" (alvo = nome do arquivo, ou "imagens"/"pdf"/"vídeo"). Pro app rodando, "abrir_ambiente"; pro celular, "abrir_simulador". Tudo abre numa aba do próprio Starfork (a tela muda pra ela) — diga o que abriu em uma frase. Se a ferramenta devolver uma lista perguntando qual, pergunte a ela.
- Use os nomes das ações EXATAMENTE como estão na lista da ferramenta "agir" (ex.: anotar_memoria, ligar_skill, abrir_pr, mover_issue) — não invente variações.
- RESPONDER x INSTRUIR: se a tarefa tem PERGUNTA ABERTA esperando a pessoa e o que ela disse responde a essa pergunta, use agir "responder" (texto = a resposta; com várias perguntas abertas, alvo = o número da pergunta que ela respondeu — uma chamada por pergunta). "instruir" é só pra mandar algo novo ao executor.

COMO VOCÊ FALA
- Português do Brasil, direto e natural, sem formalidade e sem jargão de sistema. Não presuma o gênero de quem fala.
- Curto: uma a três frases na maioria das vezes. Liste (markdown, um item por linha) só quando for mesmo uma lista. Cite tarefas e issues pelo código e, na primeira vez, um pedaço do título.
- Conversa é conversa: cumprimento, agradecimento ou comentário solto recebem resposta natural, sem ferramenta e sem relatório.
- Termine dizendo o que aconteceu e, se fizer sentido, o próximo passo que você sugere — uma linha.${o.voz?`
- A pessoa está CONVERSANDO POR VOZ: sua resposta será lida em voz alta. Fale como numa conversa — frases curtas, sem markdown, sem listas, sem ler códigos longos letra por letra (diga "a doze vinte e oito" e o assunto). No máximo três frases.`:''}`;
}
/** O que vai junto de cada mensagem da pessoa: o retrato do app agora. Puro. */
function cmdAgenteTurno(o){ o=o||{};
  const A=(o.achados||[]).map(a=>`- [${a.tipo}] ${a.code||'(sem código)'} "${a.title}"${a.st?' — '+a.st:''}${a.who?' · '+a.who:''}${a.trecho?' · «'+a.trecho+'»':''}`);
  const linhas=[`projeto aberto: ${o.proj||'—'}`, o.resumo?`tarefas: ${o.resumo}`:'', o.foco?`tarefa em foco (a última de que a conversa tratou): ${o.foco}`:'', o.esperando?`esperando a pessoa: ${o.esperando}`:'',
    (o.novidades||[]).length?'o que aconteceu no chat desde a sua última resposta:\n'+o.novidades.map(x=>'  '+x).join('\n'):'', A.length?'o que a busca achou pro que ela disse (do mais parecido pro menos):\n'+A.join('\n'):'a busca não achou nada parecido com o que ela disse (se precisar, use buscar com outras palavras)',
    (o.antes||[]).length?'conversa anterior neste chat (antes desta sessão):\n'+o.antes.map(x=>'  '+x).join('\n'):''].filter(Boolean);
  return `[CONTEXTO DO APP AGORA]\n${linhas.join('\n')}\n[/CONTEXTO]\n\n${o.pedido||''}`;
}
/** Os argumentos da ferramenta "agir" → um passo do plano que o executor do app entende. Puro. */
function cmdAgentePasso(a){ a=a||{}; const arr=x=>(Array.isArray(x)?x:(x?[x]:[])).map(v=>String(v||'').trim()).filter(Boolean);
  const p={ acao:String(a.acao||'').trim().toLowerCase(), tarefas:arr(a.tarefas), texto:String(a.texto||'').trim(), alvo:String(a.alvo||'').trim() };
  // "responder": alvo é o NÚMERO da pergunta. Se a IA pôs o código da tarefa em alvo, ele vai pro lugar certo.
  if(p.acao==='responder' && !p.tarefas.length && p.alvo && !/^\d{1,2}$/.test(p.alvo)){ p.tarefas=[p.alvo]; p.alvo=''; }
  if(a.titulo) p.titulo=String(a.titulo).replace(/\s+/g,' ').trim().slice(0,90); const rq=arr(a.requisitos).map(x=>x.replace(/\s+/g,' ')).filter(x=>x.length>3).slice(0,12); if(rq.length || p.acao==='criar_demanda' || p.acao==='criar_issue') p.requisitos=rq;
  return p; }
/** "sim"/"não" dito ou digitado enquanto um cartão de confirmação espera. Puro. → 'sim' | 'nao' | '' */
function cmdAgenteSimNao(tx){ const s=String(tx||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z ]+/g,' ').replace(/\s+/g,' ').trim(); if(!s || s.split(' ').length>5) return '';
  if(/^(sim|pode|pode sim|pode fazer|pode ir|confirmo|confirma|confirmado|isso|isso mesmo|faz|faca|manda|manda ver|vai|ok|okay|beleza|fechado|certo|exato|claro|por favor)( sim| pode| faz| vai)?$/.test(s)) return 'sim';
  if(/^(nao|nao e isso|nao faz|nao faca|cancela|cancelar|para|espera|deixa|deixa pra la|negativo|errado)( nao| nao faz)?$/.test(s)) return 'nao'; return ''; }
/** Nome de ação que não existe → mensagem que ENSINA o certo (as parecidas e a lista inteira), pra IA acertar na próxima em vez de chutar. Puro. */
function cmdAgAcaoErrada(nome, acoes){ const n=String(nome||'').toLowerCase(), ks=Object.keys(acoes||{}).filter(k=>!Object.values(CMD_AG_VER).includes(k) || k==='plano'), toks=n.split(/[^a-z]+/).filter(w=>w.length>=4).map(w=>w.slice(0,5));
  const per=ks.filter(k=>toks.some(w=>k.includes(w)) || toks.some(w=>String(acoes[k]).toLowerCase().includes(w))).slice(0,6);
  return 'Ação desconhecida: “'+nome+'”. NADA foi feito.'+(per.length?' Você quis dizer: '+per.map(k=>k+' ('+String(acoes[k]).slice(0,70)+')').join('; ')+'?':'')+' Nomes válidos: '+ks.join(', ')+'.'; }
/** Chamada de "agir" SEM o que a ação precisa → mensagem que ensina o que falta. A pessoa nunca vê cartão de confirmação
 *  de uma chamada torta (26/11, uso real: "No épico" vazio apareceu pra confirmar no meio de um "criar issue"). Puro. → '' = ok */
const CMD_AG_PRECISA={ epico_acao:['alvo','texto'], criar_issue:['titulo'], criar_demanda:['titulo'], criar_epico:['titulo'], criar_skill:['titulo'], apagar_memoria:['alvo'], mandar_time:['alvo'], devolver_cartao:['alvo'], comecar_issue:['alvo'],
  encerrar:['tarefas'], aprovar:['tarefas'], refazer:['tarefas'], liberar_teto:['tarefas'], abrir_pr:['tarefas'] };
const CMD_AG_EPICO_TX=['comecar','liberar','verificar','entregar'];
function cmdAgFalta(p, nAlvos, desc){ p=p||{}; const falta=(CMD_AG_PRECISA[p.acao]||[]).filter(c=>c==='tarefas'?!(nAlvos>0):!String(p[c]||'').trim());
  if(!falta.length && p.acao==='epico_acao' && !CMD_AG_EPICO_TX.includes(String(p.texto||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim())) return 'NADA foi feito: em epico_acao o campo texto tem que ser um destes: '+CMD_AG_EPICO_TX.join(' | ')+'. Se a pessoa não pediu pra agir num épico, a ação certa é outra.';
  if(!falta.length) return '';
  return 'NADA foi feito e a pessoa não viu nada: a ação “'+p.acao+'” veio sem '+falta.map(c=>c==='tarefas'?'a tarefa (campo tarefas = código)':'o campo '+c).join(' e ')+'.'+(desc?' O que ela faz: '+String(desc).slice(0,220)+'.':'')+' Confira se é esta a ação que a pessoa pediu e chame de novo com os campos preenchidos.'; }
/** A pessoa (ou a IA) deu um CÓDIGO ou número ("FND-1260", "1260", "T3")? Código nunca é adivinhado por parecido:
 *  26/11, uso real — "abrir o PR da 1260" (já entregue) virou cartão pra FND-1256, que é outra tarefa. Puro. */
function cmdAgPareceCodigo(q){ return /^@?\s*(?:[a-z]{1,10}[_-]?|[a-z]{1,4}\s)?\d{1,7}$/i.test(String(q||'').trim()); }
// @agente-puro-fim

const CMDAG={ on:false, laco:0, fila:Promise.resolve(), msg:null, espera:null, semFerramentas:false };
function cmdAgSidKey(){ return 'cmdagsid:'+cmdRepo(); }
/** Uma mensagem do chat em texto pro agente — com mais detalhe que o resumo da conversa nos cartões que ele acabou de causar. */
function cmdAgMsgTx(m){ if(!m) return '';
  if(m.k==='resultado') return (m.titulo||'Resultado')+': '+(m.itens||[]).map(i=>(i.code||'')+' '+(i.ok?'ok':'NÃO deu'+(i.nota?' ('+i.nota+')':''))).join('; ');
  if(m.k==='issdet'){ const i=cmdIssue(m.code); if(!i) return 'Issue '+m.code+' não está mais no painel.'; const sp=trkIssueSpec(i), sts=((trk&&trk.connector)||{}).statuses||[]; return `Issue ${i.code} "${i.title||''}" — ${((sts.find(x=>x.id===i.status)||{}).label)||i.status||'?'} · ${i.assignee?trkPretty(i.assignee):'sem responsável'} · ${cmdIssueTask(i.code)?'já é tarefa aberta':'ainda não virou tarefa'}\nDescrição: ${String(sp.objective||'').trim().slice(0,2500)||'(vazia)'}\nRequisitos: ${(sp.reqs||[]).length?sp.reqs.map(r=>'\n- '+r).join(''):'nenhum'}`; }
  if(m.k==='issok') return (m.tx||'Issue criada.')+' Código: '+(m.code||'?')+' — "'+(m.titulo||'')+'"';
  if(m.k==='issqual') return 'Há mais de uma issue parecida, perguntei qual: '+(m.itens||[]).map(i=>i.code+' "'+i.title+'"').join('; ');
  if(m.k==='pergunta') return m.text?((m.modo==='conferir'?'Porta-voz':'Executor')+' respondeu: '+String(m.text).slice(0,3000)):(m.modo==='conferir'?'Pergunta enviada ao porta-voz':'Enviado ao executor da tarefa')+' — «'+cmdUma(m.q||'')+'». A resposta aparece ao vivo no chat da pessoa.';
  // LINKS: o endereço vai ESCRITO pro agente (26/11: voltava só "[Comando mostrou: link]" e ele respondia "o cartão já apareceu", sem link nenhum)
  if(m.k==='link'){ const t=(typeof cmdTaskAny==='function'&&cmdTaskAny(m.id))||cmdTask(m.id); if(!t) return 'Essa tarefa não está nesta máquina.'; const l=cmdLinks(t), c=cmdCode(t)||mdTitle(t.title||'');
    return l.length?'Links de '+c+' — '+l.map(x=>x[0]+': '+x[1]).join(' · '):c+' não tem link ainda (sem issue, PR nem branch).'; }
  if(m.k==='plano') return 'Cartão de confirmação: '+(m.done==='sim'?'a pessoa confirmou e foi executado':m.done==='nao'?'a pessoa RECUSOU':'esperando');
  return cmdMsgTx(m)||''; }
/** Resolve as tarefas de um passo (pelo código, número ou título, inclusive encerradas quando a ação só lê). */
function cmdAgAlvos(p, incluiEncerradas){ const refs=cmdRefs(), todas=incluiEncerradas?refs.concat(cmdAllTasks().filter(t=>taskEncerrada(t) && !refs.some(r=>r.id===t.id)).map(t=>({ id:t.id, ref:cmdCode(t)||t.id, code:cmdCode(t), title:mdTitle(t.title||''), st:'encerrada' }))):refs;
  p.alvos=[]; p.faltam=[]; if(p.acao==='criar_demanda') p.origem=(p.tarefas||[]).map(q=>cmdRefTask(q, todas)).filter(Boolean); if(CMD_SEM_TAREFA.has(p.acao)) return p;
  (p.tarefas||[]).forEach(q=>{ if(/^(todas|tudo)$/i.test(q)) return; let r=cmdRefTask(q, todas);
    if(!r && !cmdAgPareceCodigo(q)){ const d=cmdBuscaDecide(cmdBusca(q, todas.map(x=>({ tipo:'tarefa', code:x.code||x.ref, id:x.id, title:x.title, text:'' })), 4)); if(d && d.um) r=todas.find(x=>x.id===d.um.id)||null; }
    if(r && !p.alvos.some(a=>a.id===r.id)) p.alvos.push(r); else if(!r) p.faltam.push(q); });
  if(!p.alvos.length && !(p.tarefas||[]).length && p.alvo && !['abrir_pr','liberar_teto','epico','epico_acao','responder','abrir_codigo','abrir_entrega'].includes(p.acao)){ const r=cmdRefTask(p.alvo, todas); if(r) p.alvos.push(r); }
  if(p.acao==='responder' && !p.alvos.length && !(p.tarefas||[]).length && CMD.sel){ const r=todas.find(x=>x.id===CMD.sel); if(r) p.alvos.push(r); } // respondeu sem repetir a tarefa: é a que está em foco // "alvo" usado no lugar de "tarefas"
  return p; }
/** Roda um passo pelo MESMO executor dos planos e devolve, em texto, o que apareceu no chat por causa dele. */
async function cmdAgRoda(p, o){ o=o||{}; const ms=cmdMsgs(), n0=ms.length;
  await cmdRunPlan({ passos:[p], pedido:'', fala:'', duvida:'' });
  const novos=ms.slice(n0), tx=novos.map(cmdAgMsgTx).filter(Boolean).join('\n');
  if(o.silencio){ novos.forEach(m=>{ const i=ms.indexOf(m); if(i>=0 && !(m.k==='pergunta')) ms.splice(i,1); }); cmdPaint(true); }
  return tx || 'Feito (sem mensagem).'; }
/** A bolha do agente fica SEMPRE por último: os cartões que ele causa (e o "sim"/"não" da pessoa) aparecem antes da resposta. */
function cmdAgPorUltimo(){ const m=CMDAG.msg, ms=cmdMsgs(); if(!m) return; const i=ms.indexOf(m); if(i>=0 && i!==ms.length-1){ ms.splice(i,1); ms.push(m); } }
function cmdAgAtividade(tx){ const m=CMDAG.msg; if(!m) return; cmdAgPorUltimo(); m.agora=tx; (m.acts||(m.acts=[])).push(tx); if(m.acts.length>5) m.acts.shift(); if(cmdAtiva()) cmdPaint(); }
/** Atende UM pedido de ferramenta do agente. Sempre devolve texto. */
async function cmdAgFerramenta(req){ const a=req.args||{}, t=req.tool;
  try{
    if(t==='buscar'){ cmdAgAtividade('procurando “'+String(a.texto||'').slice(0,50)+'”…'); try{ await Promise.race([cmdIssuesEnsure(), new Promise(r=>setTimeout(r, 4000))]); }catch(_){ }
      const docs=cmdDocs(), R=cmdAchar(a.texto, docs, 10); if(!R.length) return `Nada parecido com “${a.texto}”. Procurei em ${docs.filter(d=>d.tipo==='issue').length} issues do painel, ${docs.filter(d=>/tarefa/.test(d.tipo)).length} tarefas e ${docs.filter(d=>/cart/.test(d.tipo)).length} cartões do time. Tente outras palavras ou pergunte à pessoa.`;
      return R.map(r=>`[${r.tipo}] ${r.code||'(sem código)'} "${r.title}"${r.st?' — '+r.st:''}${r.who?' · '+r.who:''}${r.trecho?' · «'+r.trecho+'»':''} (parecido: ${r.nota})`).join('\n'); }
    if(t==='ver'){ const acao=CMD_AG_VER[String(a.o_que||'')]; if(!acao) return 'Não sei ver “'+a.o_que+'”. Opções: '+Object.keys(CMD_AG_VER).join(', ')+'.';
      cmdAgAtividade('lendo '+String(a.o_que).replace(/_/g,' ')+(a.alvo?' de '+String(a.alvo).slice(0,40):'')+'…'); const mostrar=!!a.mostrar;
      if(acao==='status' && !mostrar){ const R=cmdRefs(); if(!R.length) return 'Nenhuma tarefa aberta neste projeto.'; for(const r of R.slice(0,25)){ const tk=cmdTask(r.id); if(tk){ try{ await Promise.race([cmdProvasFrescas(tk.id, 60000), new Promise(x=>setTimeout(x,1500))]); }catch(_){ } } }
        return cmdRefs().map(r=>`${r.ref} "${r.title}" — ${r.st}${r.proj?' · projeto '+r.proj:''}${r.mexida?' · mexida '+r.mexida:''}${r.fatos?' · '+r.fatos:''}${r.q?' · PERGUNTA ABERTA: «'+cmdUma(r.q)+'»'+((r.ops||[]).length?' opções: '+r.ops.join(' | '):''):''}`).join('\n'); }
      if(acao==='issue' || acao==='fila_issues'){ try{ await Promise.race([cmdIssuesEnsure(), new Promise(r=>setTimeout(r, 4000))]); }catch(_){ } if(!cmdTrkOn()) return 'O painel de issues não está conectado neste projeto.';
        if(acao==='fila_issues' && !mostrar){ const f=cmdFila(), sts=(trk.connector||{}).statuses||[]; return f.length?f.slice(0,40).map(i=>`${i.code} "${cmdUma(i.title||'')}" — ${((sts.find(x=>x.id===i.status)||{}).label)||i.status||'?'}${i.assignee?' · '+trkPretty(i.assignee):''}`).join('\n'):'Nenhuma issue do painel esperando virar tarefa.'; }
        if(acao==='issue'){ const i=cmdIssueAcha(a.alvo); if(!i) return 'Não achei a issue “'+(a.alvo||'')+'”. Use buscar.'; if(i.varios) return 'Mais de uma parecida: '+i.varios.map(x=>x.code+' "'+x.title+'"').join('; ')+'. Pergunte qual.';
          if(mostrar){ cmdMsgs().push({ r:'bot', k:'issdet', code:i.code }); cmdPaint(true); } return cmdAgMsgTx({ k:'issdet', code:i.code }); } }
      const p=cmdAgAlvos({ acao, tarefas:a.alvo&&!CMD_SEM_TAREFA.has(acao)?[a.alvo]:[], alvo:a.alvo||'', texto:a.periodo||'' }, true);
      if(p.faltam.length) return 'Não achei a tarefa “'+p.faltam.join(', ')+'”. Use buscar pra achar o código.';
      if(acao==='tarefa' && p.alvos.length){ const tk=cmdTask(p.alvos[0].id)||cmdAllTasks().find(x=>x.id===p.alvos[0].id); if(!tk) return 'Essa tarefa não está nesta máquina.'; CMD.sel=tk.id;
        if(cmdTask(tk.id)){ try{ await cmdProvasFrescas(tk.id, 8000); }catch(_){ } if(!cmdHistReady(tk.id)){ try{ await cmdHistFetch(tk.id); }catch(_){ } } }
        let ctx=''; try{ ctx=cmdTaskContext(tk); }catch(_){ } { const q=cmdTask(tk.id)?cmdPerguntasAbertas(tk):[]; if(q.length) ctx+='\nPERGUNTAS ABERTAS esperando a pessoa ('+q.length+'):\n'+q.join('\n'); } if(mostrar){ cmdMsgs().push({ r:'bot', k:'tarefa', id:tk.id }); cmdPaint(true); } return ctx||('Tarefa '+(cmdCode(tk)||tk.id)+': '+stLabel(taskSt(tk))); }
      if(!CMD_SEM_TAREFA.has(acao) && !p.alvos.length && ['plano','provas','arquivos','ci','porque','feito','link','tarefa'].includes(acao)) return 'Diga de qual tarefa (alvo = código). Use buscar se não souber o código.';
      return await cmdAgRoda(p, { silencio:!mostrar }); }
    if(t==='agir'){ const p=cmdAgentePasso(a); if(!CMD_ACOES[p.acao]) return cmdAgAcaoErrada(p.acao, CMD_ACOES);
      if(Object.values(CMD_AG_VER).includes(p.acao) && !['plano','checks'].includes(p.acao)) return 'Isso é leitura: use a ferramenta "ver".';
      cmdAgAlvos(p, false); if(p.faltam.length){ // a que falta pode existir e já estar ENCERRADA: diz isso com todas as letras, em vez de "não achei"
        const enc=cmdAllTasks().filter(t=>taskEncerrada(t)).map(t=>({ id:t.id, ref:cmdCode(t)||t.id, code:cmdCode(t), title:mdTitle(t.title||''), st:stLabel(taskSt(t)) }));
        const linhas=p.faltam.map(q=>{ const r=cmdRefTask(q, enc); return r?`${r.code||r.ref} "${cmdUma(r.title).slice(0,70)}" já está encerrada (${r.st}) — a ação “${p.acao}” só vale pra tarefa aberta`:`não achei “${q}” entre as tarefas abertas`; });
        return 'NADA foi feito: '+linhas.join('; ')+'. Diga isso à pessoa como está; NÃO troque por outra tarefa parecida. Se ela quer algo novo a partir de uma tarefa encerrada (ex.: levar a entrega pra outra branch), proponha criar_demanda com a encerrada como origem.'; }
      cmdAgAtividade((CMD_ACAO_TX[p.acao]||p.acao)+(p.alvos.length?' '+p.alvos.map(x=>x.code||x.ref).join(', '):p.alvo?' '+p.alvo:'')+'…');
      { const f=cmdAgFalta(p, p.alvos.length, CMD_ACOES[p.acao]); if(f) return f; }
      if(p.acao==='epico_acao' && typeof cmdEpics==='function'){ const E=cmdEpics(), n=cmdNorm(p.alvo); if(!E.some(x=>cmdNorm(x.name)===n || (cmdNorm(x.name).includes(n) && p.alvo.length>=3))) return 'NADA foi feito: não existe épico chamado “'+p.alvo+'”. Épicos: '+(E.map(x=>x.name).slice(0,12).join(', ')||'nenhum')+'.'; }
      if(p.acao==='ambiente_subir'){ if(!p.alvos.length) return 'Diga de qual tarefa subir o ambiente.'; const r=await cmdAgAmbiente(p.alvos[0].id); return r.url?`Ambiente da ${p.alvos[0].code||p.alvos[0].ref} ${r.jaEstava?'já estava':'está'} no ar: ${r.url}`:'Não consegui subir o ambiente: '+r.erro; }
      if(CMD_AG_CONFIRMA.has(p.acao)){ const ms=cmdMsgs(), m={ r:'bot', k:'plano', agente:true, plan:{ passos:[p], pedido:'', fala:'', duvida:'', refs:[] } }, n0=ms.length; ms.push(m); CMDAG.espera=m; cmdAgAtividade('esperando a sua confirmação…'); cmdPaint(true); if(typeof cmdAgFalaConfirma==='function') cmdAgFalaConfirma(p);
        const t0=Date.now(); while(m.done!=='sim' && m.done!=='nao' && CMDAG.on && Date.now()-t0<12*60000) await new Promise(r=>setTimeout(r, 200)); CMDAG.espera=null;
        if(m.done==='nao') return 'A pessoa RECUSOU no cartão de confirmação. Nada foi feito. Pergunte o que ela quer mudar.'; if(m.done!=='sim'){ m.done='nao'; cmdPaint(true); return 'A pessoa não confirmou a tempo. Nada foi feito.'; }
        return 'A pessoa confirmou. '+(ms.slice(n0+1).map(cmdAgMsgTx).filter(Boolean).join('\n')||'Feito.'); }
      return await cmdAgRoda(p); }
    if(t==='perguntar_agente'){ const p=cmdAgAlvos({ acao:'perguntar_agente', tarefas:[a.tarefa], texto:a.pergunta||'' }, false); if(!p.alvos.length) return 'Não achei a tarefa “'+(a.tarefa||'')+'” entre as abertas. Use buscar.';
      cmdAgAtividade('perguntando ao porta-voz da '+(p.alvos[0].code||p.alvos[0].ref)+'…'); return await cmdAgPortaVoz(p.alvos[0].id, String(a.pergunta||'Como esta tarefa está de verdade agora?')); }
    if(t==='olhar_pagina'){ const p=cmdAgAlvos({ acao:'perguntar_agente', tarefas:[a.tarefa], texto:'' }, false); if(!p.alvos.length) return 'Não achei a tarefa “'+(a.tarefa||'')+'” entre as abertas. Use buscar.';
      const id=p.alvos[0].id, code=p.alvos[0].code||p.alvos[0].ref; cmdAgAtividade('subindo o ambiente da '+code+'…'); const amb=await cmdAgAmbiente(id); if(!amb.url) return 'Não consegui subir o ambiente da '+code+': '+amb.erro;
      let url; try{ url=new URL(String(a.caminho||'/').trim()||'/', amb.url).toString(); }catch(_){ url=amb.url; }
      cmdAgAtividade('abrindo '+url.replace(/^https?:\/\//,'')+' e tirando a foto…'); let f; try{ f=await invoke('comando_pagina_foto',{ taskId:id, url }); }catch(e){ return 'O ambiente está no ar em '+amb.url+', mas não consegui fotografar a página '+url+': '+String((e&&e.message)||e).slice(0,240); }
      cmdAgAtividade('o porta-voz da '+code+' está olhando a página e o código…');
      const resp=await cmdAgPortaVoz(id, `A pessoa quer saber sobre a página ${url} do ambiente desta tarefa, que está rodando agora.\n- FOTO da página (abra com a ferramenta Read — é uma imagem PNG de 1440×1000): ${f.png}\n- HTML renderizado da página (depois do JavaScript): ${f.html}\nOlhe a foto, leia o HTML e ache no CÓDIGO desta branch o componente/rota que desenha essa página.\n\nPERGUNTA DA PESSOA: ${String(a.pergunta||'').trim()}\n\nResponda com o que você VIU na foto e no código (cite o arquivo). Se a foto mostrar tela de login, erro ou página em branco em vez da página pedida, diga isso primeiro e o que seria preciso pra chegar nela.`);
      return `Página olhada: ${url} (ambiente em ${amb.url}).\n${resp}`; }
    return 'Ferramenta desconhecida.';
  }catch(e){ return 'Deu erro ao executar no app: '+String((e&&e.message)||e).slice(0,300); }
}
/** Pergunta ao porta-voz de uma tarefa e ESPERA a resposta (até 6 min). Devolve o texto dele. */
async function cmdAgPortaVoz(id, pergunta){ const t0=Date.now(); while(CMD.asking && Date.now()-t0<30000) await new Promise(r=>setTimeout(r, 300));
  const antes=cmdThreadDe(id), nAntes=antes&&antes.turns?antes.turns.length:0; await cmdConferir(id, pergunta);
  const th=cmdThreadDe(id); if(!th) return 'Não consegui falar com o porta-voz dessa tarefa.'; const t1=Date.now(); while(th.state==='wait' && CMDAG.on && Date.now()-t1<6*60000) await new Promise(r=>setTimeout(r, 400));
  const falas=(th.turns||[]).slice(nAntes).filter(x=>x.w!=='cmd' && x.w!=='you').map(x=>x.tx).filter(Boolean); return (falas.length?falas.join('\n'):th.text)||'O porta-voz não respondeu.'; }
/** Sobe o ambiente (prévia) da tarefa e ESPERA ficar no ar. → { url } | { erro } — sem abrir aba nenhuma. */
async function cmdAgAmbiente(id){ if(typeof envSt!=='function') return { erro:'a prévia não está disponível nesta versão' }; const s=envSt(id);
  if(s.view && s.view.ready && s.view.url) return { url:s.view.url, jaEstava:true };
  const t0=Date.now(); while(s.busy && Date.now()-t0<180000) await new Promise(r=>setTimeout(r, 500)); if(s.view && s.view.ready && s.view.url) return { url:s.view.url };
  s.busy=true; try{ const v=await invoke('env_up',{ taskId:id, main:false }); s.view=Object.assign({}, s.view||{}, v||{}); if(v && v.ready && v.url){ if(!cmdMsgs().some(m=>m.k==='ambiente' && m.id===id)) cmdMsgs().push({ r:'bot', k:'ambiente', id }); cmdPaint(true); return { url:v.url }; }
    return { erro:'o ambiente não ficou pronto'+(v&&v.fail?' ('+String(v.fail.msg||v.fail.code||'').slice(0,160)+')':'') }; }
  catch(e){ return { erro:String((e&&e.message)||e).slice(0,300) }; } finally{ s.busy=false; try{ if(typeof envPaint==='function') envPaint(id); }catch(_){ } } }
function cmdAgLaco(){ clearInterval(CMDAG.laco); CMDAG.laco=setInterval(()=>{ if(!CMDAG.on) return; invoke('comando_ponte_ler').then(L=>{ (L||[]).forEach(req=>{ CMDAG.fila=CMDAG.fila.then(async()=>{ const texto=await cmdAgFerramenta(req); try{ cmdLog({ via:'ferramenta', pedido:req.tool+' '+JSON.stringify(req.args||{}).slice(0,300), res:String(texto).slice(0,200) }); }catch(_){ }
      await invoke('comando_ponte_responder',{ id:req.id, texto:String(texto) }).catch(()=>{}); cmdAgAtividade('pensando…'); }); }); }).catch(()=>{}); }, 200); }
/** Frase curta lida em voz alta quando um cartão de confirmação aparece (a pessoa pode responder "sim" falando). */
function cmdAgFalaConfirma(p){ if(!CMDV.on) return; const al=(p.alvos||[]).map(x=>x.code||x.ref).join(', '); cmdSpeak((CMD_ACAO_TX[p.acao]||p.acao)+(al?' '+al:p.titulo?': '+p.titulo:'')+'. Confirma?'); }
function cmdAgNovidades(){ const ms=cmdMsgs(); let i=ms.length-2; const out=[]; for(;i>=0;i--){ const m=ms[i]; if(m.ag || m.r==='you') break; const tx=cmdAgMsgTx(m); if(tx) out.unshift(cmdUma(tx).slice(0,400)); } return out.slice(-6); }
/** A pessoa falou: o agente trabalha. Devolve false quando o agente não está disponível (o chamador usa o planejador). */
async function cmdAgente(text){
  const ms=cmdMsgs(), sid=lsGet(cmdAgSidKey())||'', m={ r:'bot', k:'agente', ag:true, state:'wait', text:'', agora:'pensando…', acts:[], t0:Date.now() };
  CMD.busy=true; CMD.stopping=false; CMDAG.on=true; CMDAG.msg=m; CMDAG.fila=Promise.resolve(); ms.push(m); cmdPaint(true); cmdAgLaco();
  let foco=''; try{ const ft=CMD.sel?cmdTask(CMD.sel):null; if(ft) foco=(cmdCode(ft)||ft.id)+' "'+cmdUma(mdTitle(ft.title||'')).slice(0,80)+'" — '+stLabel(taskSt(ft)); }catch(_){ }
  let resumo=''; try{ const c=cmdCounts(cmdTasks()); resumo=`${c.all} abertas · ${c.run} rodando · ${c.ask} esperando você · ${c.bad} paradas com erro · ${c.rev} prontas pra revisar`; }catch(_){ }
  try{ await Promise.race([cmdIssuesEnsure(), new Promise(r=>setTimeout(r, 1500))]); }catch(_){ }
  const turno=cmdAgenteTurno({ pedido:text, proj:pathBase(cmdRepo()), resumo, foco, achados:cmdAchados(text), novidades:sid?cmdAgNovidades():[], antes:sid?[]:cmdMsgs().slice(-12,-2).map(cmdMsgTx).filter(Boolean).map(x=>cmdUma(x).slice(0,300)) });
  const fim=(ok)=>{ CMDAG.on=false; clearInterval(CMDAG.laco); CMDAG.msg=null; if(CMDAG.espera && !CMDAG.espera.done){ CMDAG.espera.done='nao'; } CMDAG.espera=null; CMD.busy=false; CMD.stopping=false; return ok; };
  const t0=Date.now();
  try{
    const chama=(pr, s)=>invoke('comando_agente',{ prompt:pr, system:cmdAgenteSys({ voz:CMDV.on }), acoes:cmdAgenteAcoes(CMD_ACOES), sessionId:s||'', model:aiClaudeModel()||'claude-sonnet-5' });
    let r; try{ r=await chama(turno, sid); }catch(e){ const msg=String((e&&e.message)||e||''); if(sid && !CMD.stopping && !/AGENTE_STOPPED|AGENTE_SO_CLAUDE/.test(msg)){ lsSet(cmdAgSidKey(), ''); r=await chama(cmdAgenteTurno({ pedido:text, proj:pathBase(cmdRepo()), resumo, foco, achados:cmdAchados(text), antes:cmdMsgs().slice(-12,-2).map(cmdMsgTx).filter(Boolean).map(x=>cmdUma(x).slice(0,300)) }), ''); } else throw e; }
    if(CMDAG.semFerramentas) throw new Error('AGENTE_SEM_FERRAMENTAS');
    await CMDAG.fila; cmdAgPorUltimo(); if(r && r.sessionId) lsSet(cmdAgSidKey(), r.sessionId);
    m.k='md'; m.state='done'; m.text=String((r&&r.text)||'').trim()||'(sem resposta)'; delete m.agora; delete m.acts; m.ms=Date.now()-t0;
    try{ cmdLog({ via:'agente', pedido:text, ms:m.ms, fala:m.text.slice(0,300) }); }catch(_){ }
    fim(true); CMD.spoken=cmdMsgs().length; cmdPaint(true); if(CMDV.on) cmdSpeak(m.text.replace(/[*_`#>]/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')); return true;
  }catch(e){ const msg=String((e&&e.message)||e||''); fim(false); const i=ms.indexOf(m);
    if(CMDAG.semFerramentas){ CMDAG.semFerramentas=false; try{ cmdLog({ via:'agente', pedido:text, erro:'servidor de ferramentas não conectou — atendido pelo planejador' }); }catch(_){ } if(i>=0) ms.splice(i,1); cmdPaint(true); return false; }
    if(CMD.stopping || /AGENTE_STOPPED/.test(msg)){ if(i>=0) ms.splice(i,1); ms.push({ r:'sys', text:'parado' }); cmdPaint(true); return true; }
    if(i>=0) ms.splice(i,1); try{ invoke('web_log',{ line:'[agente] falhou: '+msg.slice(0,300) }); }catch(_){ } try{ cmdLog({ via:'agente', pedido:text, ms:Date.now()-t0, erro:msg.slice(0,300) }); }catch(_){ }
    if(/AGENTE_SO_CLAUDE/.test(msg)) return false; // outra IA: o planejador de uma chamada atende
    const h=humanErr(msg); ms.push({ r:'sys', text:'Não consegui responder agora: '+(h&&h.msg?h.msg:msg.slice(0,240)) }); if(h&&h.action) showErr(e); cmdPaint(true); return true; }
}
// as ferramentas não subiram: sem elas a IA inventaria que agiu. Para o agente e deixa o planejador de uma chamada atender.
try{ window.__TAURI__.event.listen('comando-agente-activity', ev=>{ const l=String((ev&&ev.payload&&ev.payload.line)||''); if(l==='__MCP_FALHOU__' && CMDAG.on){ CMDAG.semFerramentas=true; try{ invoke('web_log',{ line:'[agente] servidor de ferramentas não conectou' }); }catch(_){ } invoke('comando_agente_stop').catch(()=>{}); } }); }catch(_){ }
function cmdAgenteHtml(m){ const acts=(m.acts||[]).slice(-3, -1); return `<div class="cmdag">${acts.map(a=>`<div class="cmdag-a done">✓ ${esc(a.replace(/…$/,''))}</div>`).join('')}<div class="cmdag-a"><span class="pltyping"><i></i><i></i><i></i></span> ${esc(m.agora||'pensando…')}</div></div>`; }
/** "sim"/"não" (digitado ou falado) enquanto um cartão do agente espera: vale como o clique. true = tratou. */
function cmdAgDecide(text){ const m=CMDAG.espera; if(!m || m.done) return false; const d=cmdAgenteSimNao(text); if(!d) return false; const i=cmdMsgs().indexOf(m), b=document.querySelector(`[data-cmdplano="${i}"][data-ok="${d==='sim'?'1':''}"]`); cmdMsgs().push({ r:'you', text }); if(b) b.click(); else { m.done='nao'; } cmdAgPorUltimo(); cmdPaint(true); return true; }
