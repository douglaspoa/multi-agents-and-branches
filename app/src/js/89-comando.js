// Starfork — 89-comando: COMANDO, o centralizador (aba, nunca modal).
// Uma conversa que responde sobre TODAS as tarefas e agentes e age por você; ao lado, o painel vivo: todos os agentes
// e, ao clicar numa tarefa, a VISÃO GERAL dela (pedido, plano da IA, decisões, caminho, arquivos) — tudo numa tela.
// Fontes únicas: taskSt/STATUS_META (estado), pendingOf/tlAskGroup (perguntas), term_history (o que a IA fez),
// tlAskPaint (a MESMA folha de pergunta do terminal), tiSend (instrução), stopTask, project_chat (pergunta livre).
// Perguntas de estado NÃO gastam IA: saem direto dos dados. Só o texto livre vai pra IA, com o estado junto.

// @comando-puro-inicio (testado em app/tests/comando.test.mjs)
const CMD_ORDEM={ asking:0, 'needs-you':0, 'plan-review':0, error:1, conflict:1, 'mudanca-pedida':1, review:2, delivered:2, 'falta-prova':2, 'para-aprovar':2, 'pr-open':3, running:4, thinking:4, integrando:4 };
function cmdNorm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
/** O que a pessoa quis: { k, id?, code?, text?, tela? }.
 *  k: status | espera | erro | fila | parar | tarefa | porque | abrir | provas | link | instruir | issue | epicos | epico | tela | ia.
 *  `tasks`: [{id, code, title}] · `epics`: [{id, name}]. A IA devolve "ACAO: <frase>" e a frase passa por aqui de novo. */
const CMD_TELAS=[['issues','issues'],['central','flow'],['entregas','entregas'],['semana','semana'],['aprovar','aprovar'],['meu trabalho','meu'],['projetos','projetos'],['nova demanda','nova']];
function cmdIntent(text, tasks, epics, sel){
  const raw=String(text||'').trim(), s=cmdNorm(raw); if(!s) return { k:'' };
  const m=/\b([a-z]{2,10}-\d+)\b/.exec(s);
  let t=m?(tasks||[]).find(x=>cmdNorm(x.code)===m[1]):null;
  if(!t){ const hit=(tasks||[]).filter(x=>{ const ti=cmdNorm(x.title); return ti.length>=6 && s.includes(ti); }); if(hit.length===1) t=hit[0]; }
  // "a task", "essa tarefa", "o agente dela": fala da tarefa que está aberta ao lado
  if(!t && sel && s.split(/\s+/).length<=6 && /\b(a task|essa task|esta task|da task|na task|a tarefa|essa tarefa|esta tarefa|dessa tarefa|da tarefa|na tarefa|o agente|ao agente|pro agente|dela|nela|o ambiente|ambiente|servidor|previa|encerr\w*|o que foi feito|o que mudou)\b/.test(s)) t=(tasks||[]).find(x=>x.id===sel)||null;
  const quer={ provas:/\b(prova|provas|print|prints|imagem|imagens|screenshot|evidencia|evidencias|foto|fotos)\b/.test(s), link:/\b(link|links|url|endereco|pull request|pr)\b/.test(s) };
  if(t){
    const ins=/^\s*[a-z]{2,10}-\d+\s*:\s*(.{3,})$/i.exec(raw); if(ins) return { k:'instruir', id:t.id, text:ins[1].trim() };
    // perguntar AO AGENTE da tarefa (a palavra dele, não o selo): "pergunta pro agente…", "confirma com a IA…", "perguntar FND-1: …"
    if(/\b(pergunt\w*|consult\w*|confirm\w*|checa\w*|verific\w*)\b.*\b(agente|ia|ele|ela)\b/.test(s) || /^perguntar\b/.test(s)){ const q=/:\s*(.{3,})$/.exec(raw); return { k:'perguntar', id:t.id, text:(q?q[1]:raw).trim() }; }
    if(/\b(ambiente|servidor|site|previa|preview|localhost)\b/.test(s)){ if(/\b(deslig\w*|derrub\w*|pare|parar|mata\w*|fech\w*)\b/.test(s)) return { k:'ambiente', id:t.id, on:false }; if(/\b(sob[ea]\w*|subir|lig\w*|inici\w*|roda\w*|abr\w*|levant\w*)\b/.test(s)) return { k:'ambiente', id:t.id, on:true }; }
    if(/\b(encerr\w*|finaliz\w*|descart\w*|cancel\w*|arquiv\w*)\b/.test(s)) return { k:'encerrar', id:t.id };
    if(/(o que (foi feito|ela fez|ele fez|a ia fez|o agente fez|mudou|foi alterado)|\b(mudancas|alteracoes|resumo do que)\b)/.test(s)) return { k:'feito', id:t.id };
    if(quer.provas) return { k:'provas', id:t.id };
    if(quer.link) return { k:'link', id:t.id };
    if(/\b(por ?que|parou|erro|falh|travou|travad)/.test(s)) return { k:'porque', id:t.id };
    if(/\b(abr[ea]|abrir|entra|entrar|mostra|ver)\b/.test(s)) return { k:'abrir', id:t.id };
    if(/\b(continu\w*|retom\w*|volt\w* a rodar|segu\w* rodando)\b/.test(s)) return { k:'continuar', id:t.id };
    if(/\b(pare|parar|pausa|pausar|pause|interromp\w*)\b/.test(s)) return { k:'parar', id:t.id };
    return { k:'tarefa', id:t.id };
  }
  // código que não é tarefa aberta = issue do painel (começar/ver); quem chama confere se ela existe lá
  if(m) return { k:'issue', code:m[1].toUpperCase(), go:/\b(comec\w*|inici\w*|peg[ao]\w*|faz\w*|roda\w*|toca\w*|resolv\w*|bora)\b/.test(s), link:quer.link };
  const ep=(epics||[]).filter(e=>{ const n=cmdNorm(e.name); return n.length>=4 && s.includes(n); });
  if(ep.length===1){ const act=/\b(entreg\w*)\b/.test(s)?'entregar':/\b(liber\w*|proxima onda|comec\w* a onda)\b/.test(s)?'liberar':/\b(verific\w*|confer\w*)\b/.test(s)?'verificar':/\b(comec\w*|inici\w*|roda\w*|bora)\b/.test(s)?'start':'';
    return act?{ k:'epico', id:ep[0].id, act }:{ k:'epico', id:ep[0].id }; }
  if(/\bepicos?\b/.test(s)) return { k:'epicos' };
  if(s.split(/\s+/).length>8 || /\b(acho|acredito|parece|poderia|sera que|nao reflet\w*|errado|estranho|mas)\b/.test(s)) return { k:'ia' };
  if(/\b(pausa|pausar|para|parar|pare|interromp\w*)\b.*\b(tudo|todos|todas|agentes|rodando)\b/.test(s)) return { k:'parar' };
  if(quer.provas) return { k:'provas' };
  { const tl=/\b(abr[ea]|abrir|vai|ir|leva|mostra|tela)\b/.test(s)?CMD_TELAS.find(x=>s.includes(x[0])):null; if(tl) return { k:'tela', tela:tl[1] }; }
  if(/\b(issues?|fila|backlog|painel|proxima(s)?|o que (tem|falta|ha) (pra|para) (fazer|pegar|comecar))\b/.test(s)) return { k:'fila' };
  if(/(esperando|precisa(m)? de mim|precisando de mim|pendente|perguntas? abertas?|minha vez|me esperando)/.test(s)) return { k:'espera' };
  if(/\b(erro|erros|falh\w*|travad\w*|parou|pararam|quebr\w*)\b/.test(s)) return { k:'erro' };
  if(/(como (esta|estao|anda|andam|vai|vao)|status|andamento|resumo|situacao|o que (esta|ta) (rodando|acontecendo)|agentes|tarefas abertas|tudo bem)/.test(s)) return { k:'status' };
  return { k:'ia' };
}
/** Frase CURTA e DIRETA (comando), que dá pra resolver sem IA. Conversa, negação, referência ("a última", "hoje",
 *  "não é essa") NUNCA é adivinhada por palavra: vai pra IA, que tem a lista das tarefas e o que foi dito antes. */
function cmdDireto(text){
  const s=cmdNorm(text).trim(); if(!s || s.split(/\s+/).length>8) return false;
  if((s.match(/\d{3,}/g)||[]).length>1 || /\b(e depois|depois|em seguida|tambem)\b/.test(s)) return false; // mais de uma tarefa ou mais de um passo = plano
  return !/\b(nao|mas|falo|falando|estou|sei|acho|acredito|parece|poderia|precisamos|preciso|queria|gostaria|sera|errad\w*|estranh\w*|outra|outro|ultim[ao]|hoje|ontem|aquela|aquele|sobre)\b/.test(s);
}
/** Ações que ESCREVEM no terminal de uma tarefa ou criam coisa: vindas da IA, viram PROPOSTA (a pessoa confirma). */
function cmdPrecisaOk(it){ return !!it && (['instruir','perguntar','continuar'].includes(it.k) || (it.k==='ambiente' && it.on!==false) || (it.k==='issue' && it.go)); }
/** A linha "ACAO: …" que a IA devolve quando o pedido é uma ação do app ('' = respondeu em texto). */
function cmdAcaoDe(text){ const m=/^\s*ACAO:\s*(.+?)\s*$/im.exec(String(text||'')); return m?m[1]:''; }
/** Plano da IA = o último TodoWrite da sessão. → [{ st:'ok'|'now'|'', tx }] */
function cmdPlan(items){
  for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i];
    if(it && it.k==='tool' && it.name==='Plano' && it.text) return String(it.text).split('\n').map(l=>{ const p=l.indexOf('\t'); const st=p<0?'':l.slice(0,p); return { st:st==='completed'?'ok':st==='in_progress'?'now':'', tx:p<0?l:l.slice(p+1) }; }).filter(x=>x.tx); }
  return [];
}
/** Decisões = cada pergunta da IA com a resposta dada. → [{ q, a, ts }] (a='' = ainda sem resposta) */
function cmdDecisions(items){
  return (items||[]).filter(it=>it && it.k==='ask' && it.text).map(it=>({ q:String(it.text), ts:it.ts||0,
    a:it.done&&!it.err?String(it.out||'').replace(/^User (has )?answered[^:]*:\s*/i,'').trim():'' }));
}
/** Arquivos que a IA mexeu (somando as edições). → [{ f, add, del }] do mais mexido pro menos */
function cmdFiles(items){
  const m=new Map();
  for(const it of (items||[])){ if(!it || it.k!=='edit' || !it.arg || it.err) continue; const r=m.get(it.arg)||{ f:it.arg, add:0, del:0, n:0 }; r.add+=it.add||0; r.del+=it.del||0; r.n++; m.set(it.arg, r); }
  return [...m.values()].sort((a,b)=>(b.add+b.del)-(a.add+a.del));
}
const CMD_VERBO={ Read:'leu', Bash:'rodou', Grep:'buscou', Glob:'buscou', WebSearch:'pesquisou', WebFetch:'abriu', Agent:'delegou', Plano:'planejou', mcp:'usou', Update:'editou', Write:'criou' };
/** O caminho, em linhas legíveis (as últimas `max`). Leituras seguidas viram uma linha só. → [{ ts, k, v, tx, err }] */
function cmdPath(items, max){
  const out=[];
  for(const it of (items||[])){ if(!it) continue;
    if(it.k==='you') out.push({ ts:it.ts, k:'you', v:'você', tx:cmdUma(it.text) });
    else if(it.k==='ask') out.push({ ts:it.ts, k:'ask', v:'perguntou', tx:cmdUma(it.text) });
    else if(it.k==='edit') out.push({ ts:it.ts, k:'edit', v:CMD_VERBO[it.name]||'editou', tx:it.arg+(it.add?' +'+it.add:'')+(it.del?' −'+it.del:''), err:!!it.err });
    else if(it.k==='tool'){
      if(it.name==='Plano'){ out.push({ ts:it.ts, k:'plan', v:'planejou', tx:it.arg }); continue; }
      const last=out[out.length-1], v=CMD_VERBO[it.name]||'usou';
      if(it.name==='Read' && last && last.k==='read'){ last.n++; last.tx=last.n+' arquivos'; continue; }
      out.push({ ts:it.ts, k:it.name==='Read'?'read':'tool', n:1, v, tx:cmdUma(it.arg)+(it.err?' — '+(cmdUma(it.out)||'falhou'):''), err:!!it.err });
    }
    else if(it.k==='sys') out.push({ ts:it.ts, k:'sys', v:'sistema', tx:cmdUma(it.text) });
  }
  return out.slice(-(max||30));
}
function cmdUma(s){ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>150?s.slice(0,149)+'…':s; }
/** A última coisa que a IA DISSE (resumo do ponto em que está). */
function cmdLastSay(items){ let cru=''; for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i]; if(it && it.k==='say' && it.text){ if(cmdFalaUtil(it.text)) return String(it.text); if(!cru) cru=String(it.text); } } return cru; }
/** O último erro de ferramenta (pra "por que parou?"). */
function cmdLastErr(items){ for(let i=(items||[]).length-1;i>=0;i--){ const it=items[i]; if(it && it.err) return { name:it.name||'', arg:it.arg||'', out:it.out||'' }; } return null; }
/** O estado inteiro em texto + o catálogo de ações, pra IA responder pergunta livre OU devolver a ação certa.
 *  `rows`: [{ code, title, st, branch, q }] · `epics`: [{ name, done, total }] */
function cmdSnapshot(rows, proj, epics, foco){
  const L=(rows||[]).map(r=>`- ${r.code?r.code+' ':''}"${r.title}" — ${r.st}${r.criada?' · criada '+r.criada:''}${r.mexida?' · mexida '+r.mexida:''}${r.branch?' · branch '+r.branch:''}${r.q?' · pergunta aberta: '+cmdUma(r.q):''}${r.foco?' · [ABERTA AO LADO]':''}`);
  const E=(epics||[]).map(e=>`- épico "${e.name}" — ${e.done} de ${e.total} tarefas entregues`);
  return `[ESTADO DO STARFORK AGORA${proj?' · projeto '+proj:''}]\n${L.length?L.join('\n'):'(nenhuma tarefa aberta)'}${E.length?'\n'+E.join('\n'):''}\n[FIM DO ESTADO]\n${foco?'[TAREFA EM FOCO — a que está aberta ao lado; "a task", "ela", "o agente" falam dela]\n'+foco+'\n[FIM DA TAREFA EM FOCO]\n':''}`
    +`Você é o Comando do Starfork. Se o pedido da pessoa for uma AÇÃO do app, responda SOMENTE com uma linha "ACAO: <frase>" usando uma destas frases (troque o que está entre <>):\n`
    +`status · esperando · erro · fila de issues · epicos · epico <nome> · comecar epico <nome> · liberar onda epico <nome> · verificar epico <nome> · entregar epico <nome> · tarefa <código> · por que <código> parou · provas <código> · link <código> · abrir <código> · parar <código> · parar tudo rodando · comecar <código da issue> · <código>: <instrução pra IA da tarefa> · perguntar <código>: <pergunta pro agente da tarefa> · o que foi feito <código> · subir ambiente <código> · desligar ambiente <código> · continuar <código> · encerrar <código> · abrir tela <issues|central|entregas|semana|aprovar|meu trabalho|projetos|nova demanda>\n`
    +`Se for uma pergunta (sobre o código ou sobre as tarefas), responda em português, curto e direto, citando as tarefas pelo código. Nunca invente código de tarefa. QUAL TAREFA: a pessoa pode estar falando de outra que não a aberta ao lado — se ela descrever ("a última que abrimos hoje", "a do NCM", "não é essa"), ache na lista pelo título e pela data de criação e use o código DELA; se ficar em dúvida entre duas, pergunte qual em vez de escolher. Em "<código>: <instrução>" e em "perguntar", escreva SÓ o que a pessoa pediu, com as palavras dela — não acrescente passos, comandos nem decisões que ela não disse. "Continuar rodando" = continuar <código>. O selo de estado ("pronta pra revisar" etc.) é só o rótulo do app: pra dizer como a tarefa está de verdade, use os requisitos com prova, o plano, os últimos passos e a última fala do agente da TAREFA EM FOCO — e, se a pessoa duvidar do estado ou quiser a palavra do agente, use "perguntar <código>: …".`;
}
/** O que PEDE CONVERSA agora. `rows`: [{ id, st, ask }] (ask = chave da pergunta aberta). → [{ id, tipo:'ask'|'bad'|'rev', key }] na ordem de urgência */
function cmdNeeds(rows){
  const out=[];
  for(const r of (rows||[])){ if(!r||!r.id) continue;
    if(['asking','needs-you','plan-review'].includes(r.st)) out.push({ id:r.id, tipo:'ask', key:'ask:'+r.id+':'+(r.ask||r.st) });
    else if(['error','conflict','mudanca-pedida'].includes(r.st)) out.push({ id:r.id, tipo:'bad', key:'bad:'+r.id+':'+r.st });
    else if(['review','delivered','falta-prova','para-aprovar'].includes(r.st)) out.push({ id:r.id, tipo:'rev', key:'rev:'+r.id }); }
  const o={ ask:0, bad:1, rev:2 }; return out.sort((a,b)=>o[a.tipo]-o[b.tipo]);
}
/** Dos que pedem conversa, quais são NOVOS (ainda não avisados). `seen` = chaves já avisadas; null = 1ª vez (nada é novo:
 *  o resumo de abertura já cobre). Devolve { novos, seen } — seen novo = só as chaves que continuam valendo (o que se
 *  resolveu sai, e avisa de novo se voltar). */
function cmdNovos(needs, seen){
  const keys=(needs||[]).map(n=>n.key);
  if(!Array.isArray(seen)) return { novos:[], seen:keys };
  const had=new Set(seen); return { novos:(needs||[]).filter(n=>!had.has(n.key)), seen:keys };
}
/** A sugestão que a IA devolve: "SUGESTAO: …" e, se couber, "INSTRUCAO: …" (o texto pra mandar ao agente). */
function cmdSugestaoDe(text){
  const t=String(text||''), s=/SUGEST[AÃ]O:\s*([\s\S]*?)(?=\n\s*INSTRU[CÇ][AÃ]O:|$)/i.exec(t), i=/INSTRU[CÇ][AÃ]O:\s*([\s\S]*)$/i.exec(t);
  const ins=i?i[1].trim().replace(/^["“]|["”]$/g,''):'';
  return { sug:(s?s[1]:t).trim(), ins:/^(vazio|nenhuma|-|—|n\/a)?\.?$/i.test(ins)?'':ins };
}
const CMD_TIPO={ ask:'tem uma pergunta pra você', bad:'parou com erro', rev:'terminou e espera a sua revisão' };
/** Fala do agente que NÃO responde nada ("No response requested.", "ok", vazia): não conta como resposta. */
function cmdFalaUtil(s){ s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>=25 && !/^(no response requested|nenhuma resposta (foi )?solicitada|ok|entendido|certo|feito)[.!]?$/i.test(s) && !/^(api error|error:|request (timed out|failed)|overloaded)/i.test(s); }
// ===== PLANO: o pedido da pessoa vira uma lista de passos, cada um com sua ação e suas tarefas =====
const CMD_ACOES={
  status:'mostrar como estão todos os agentes', abertas:'mostrar só as tarefas abertas', esperando:'mostrar o que espera a pessoa', erros:'mostrar as que pararam com erro',
  fila_issues:'mostrar as issues do painel que não viraram tarefa', epicos:'listar os épicos', epico:'mostrar um épico (alvo = nome)', epico_acao:'agir no épico (alvo = nome; texto = comecar | liberar | verificar | entregar)',
  tarefa:'mostrar o estado real de tarefas', porque:'dizer por que tarefas pararam', feito:'mostrar o que foi feito em tarefas', provas:'mostrar as provas/prints de tarefas', link:'pegar links (issue, PR, branch) de tarefas', abrir:'abrir a tela de UMA tarefa',
  parar:'parar tarefas que estão rodando (tarefas = ["todas"] pra todas)', continuar:'mandar tarefas paradas continuarem', encerrar:'encerrar tarefas sem entregar', ambiente_subir:'subir o ambiente/prévia de tarefas', ambiente_desligar:'desligar o ambiente de tarefas',
  instruir:'mandar uma instrução pro agente de tarefas (texto = a instrução, com as palavras da pessoa)', perguntar_agente:'perguntar ao PORTA-VOZ de tarefas — o segundo agente de cada tarefa, que só lê a sessão e o código da branch e responde sem interromper o agente que trabalha (texto = a pergunta ou o que conferir)',
  comecar_issue:'criar e iniciar a tarefa de uma issue do painel (alvo = código da issue)', tela:'abrir uma tela (alvo = issues | central | entregas | semana | aprovar | meu trabalho | projetos | nova demanda)',
  ler_codigo:'responder uma pergunta que exige LER O CÓDIGO do projeto (texto = a pergunta)' };
const CMD_MUTA=new Set(['parar','continuar','encerrar','ambiente_subir','instruir','comecar_issue','epico_acao']);
const CMD_ACAO_TX={ status:'Mostrar como estão os agentes', abertas:'Mostrar as tarefas abertas', esperando:'Mostrar o que espera você', erros:'Mostrar as que pararam', fila_issues:'Mostrar a fila de issues', epicos:'Mostrar os épicos', epico:'Mostrar o épico', epico_acao:'No épico',
  tarefa:'Mostrar o estado de', porque:'Ver por que parou', feito:'Mostrar o que foi feito em', provas:'Mostrar as provas de', link:'Pegar os links de', abrir:'Abrir', parar:'Parar', continuar:'Mandar continuar', encerrar:'Encerrar sem entregar',
  ambiente_subir:'Subir o ambiente de', ambiente_desligar:'Desligar o ambiente de', instruir:'Mandar instrução pro agente de', perguntar_agente:'Perguntar ao porta-voz de', comecar_issue:'Começar a issue', tela:'Abrir a tela', ler_codigo:'Ler o código pra responder' };
/** Acha a tarefa que a pessoa (ou a IA) citou. `refs`: [{ id, ref, code, title }]. Aceita "FND-1168", "fnd 1168", "1168", o ref ("T3") ou um pedaço do título. null = não achou ou ficou ambíguo. */
function cmdRefTask(q, refs){
  const s=cmdNorm(q).replace(/[\s_]+/g,' ').trim(); if(!s) return null; const L=refs||[];
  const cod=x=>cmdNorm(x.code||'').replace(/[\s-]+/g,''), sc=s.replace(/[\s-]+/g,'');
  let m=L.filter(x=>(x.ref&&cmdNorm(x.ref)===s) || (x.code&&cod(x)===sc)); if(m.length===1) return m[0];
  if(/^\d{2,}$/.test(sc)){ m=L.filter(x=>x.code && new RegExp('(^|\\D)'+sc+'$').test(cmdNorm(x.code))); if(m.length===1) return m[0]; }
  if(s.length>=5){ m=L.filter(x=>cmdNorm(x.title).includes(s)); if(m.length===1) return m[0]; }
  return null;
}
/** O JSON do plano que a IA devolveu → { fala, duvida, passos:[{ acao, tarefas:[texto], texto, alvo }] } (só ações conhecidas). null = não veio JSON. */
function cmdPlanParse(text){
  const t=String(text||''), i=t.indexOf('{'), j=t.lastIndexOf('}'); if(i<0 || j<=i) return null;
  let o; try{ o=JSON.parse(t.slice(i, j+1)); }catch(_){ return null; }
  if(!o || typeof o!=='object') return null;
  const passos=(Array.isArray(o.passos)?o.passos:[]).map(p=>{ if(!p || typeof p!=='object') return null; const acao=String(p.acao||'').trim().toLowerCase(); if(!CMD_ACOES[acao]) return null;
    const tarefas=(Array.isArray(p.tarefas)?p.tarefas:(p.tarefas?[p.tarefas]:[])).map(x=>String(x||'').trim()).filter(Boolean);
    return { acao, tarefas, texto:String(p.texto||'').trim(), alvo:String(p.alvo||'').trim() }; }).filter(Boolean);
  return { fala:String(o.fala||'').trim(), duvida:String(o.duvida||'').trim(), passos };
}
/** O pedido pra IA planejar. o: { proj, refs:[{ ref, code, title, st, criada, mexida, proj, foco, q }], epics:[{ name, done, total }], foco, conversa:[texto], pedido } */
function cmdPlanPrompt(o){
  const T=(o.refs||[]).map(r=>`- ${r.ref}${r.code&&r.code!==r.ref?' ('+r.code+')':''} "${r.title}" — ${r.st}${r.proj?' · projeto '+r.proj:''}${r.criada?' · criada '+r.criada:''}${r.mexida?' · mexida '+r.mexida:''}${r.fatos?' · FATOS: '+r.fatos:''}${r.q?' · pergunta aberta: '+cmdUma(r.q):''}${r.foco?' · [ABERTA AO LADO]':''}`);
  const E=(o.epics||[]).map(e=>`- épico "${e.name}" — ${e.done} de ${e.total} tarefas entregues`);
  return `Você é o Comando do Starfork: o assistente de quem coordena várias tarefas tocadas por agentes de IA. Transforme o pedido da pessoa num PLANO de ações do app.

AÇÕES (use exatamente estes nomes):
${Object.keys(CMD_ACOES).map(k=>'- '+k+': '+CMD_ACOES[k]).join('\n')}

TAREFAS${o.proj?' (projeto aberto: '+o.proj+')':''}:
${T.length?T.join('\n'):'(nenhuma tarefa aberta)'}
${E.length?'\nÉPICOS:\n'+E.join('\n')+'\n':''}${o.foco?'\nTAREFA ABERTA AO LADO, em detalhe:\n'+o.foco+'\n':''}${(o.conversa||[]).length?'\nCONVERSA ATÉ AQUI:\n'+o.conversa.join('\n')+'\n':''}
PEDIDO DA PESSOA: ${o.pedido}

Responda SOMENTE com um objeto JSON, sem texto antes ou depois:
{"fala":"...","passos":[{"acao":"...","tarefas":["..."],"texto":"...","alvo":"..."}],"duvida":""}

REGRAS:
- Um pedido pode ter VÁRIOS passos ("faça X e depois Y") e VÁRIAS tarefas no mesmo passo ("encerre a 1168, a 1195 e a 1173" = um passo "encerrar" com as três). Ponha os passos na ordem pedida.
- Em "tarefas" use o identificador do começo da linha da tarefa (ex.: FND-1168). A pessoa pode escrever só o número ("a 1195"), sem hífen ("FND 1168") ou descrever ("a última que abrimos hoje", "a do NCM"): ache na lista pelo código, título, projeto e data. Se não achar ou ficar entre duas, NÃO escolha: deixe "passos" sem esse passo e pergunte em "duvida".
- A tarefa aberta ao lado só vale quando a pessoa disser "essa", "ela", "a task" sem dar outra pista. Se ela disser que não é essa, não use.
- O SELO ("pronta pra revisar") é só o rótulo do app. O estado de verdade está nos FATOS da tarefa (requisitos com prova, PR, plano, última fala). Se os fatos já respondem — ex.: "0 de 26 requisitos com prova", "sem PR" — DIGA ISSO em "fala", com os números, em vez de devolver só uma pergunta pro agente.
- Quando a pessoa DITA o texto de uma instrução ou pergunta, use as palavras dela, sem acrescentar passos. Quando é VOCÊ que propõe o próximo passo (ela pediu pra conferir, resolver, ou você viu que falta algo), escreva a instrução ou a pergunta de forma específica, citando o que os fatos mostram que falta (ex.: "Nenhum dos 26 requisitos tem prova registrada e não há PR. Registre a prova de cada requisito e abra o PR; se algum não estiver implementado, diga qual."). A pessoa confirma antes de qualquer envio.
- Cada tarefa tem DOIS agentes: o executor (trabalha) e o porta-voz (só lê e responde). "perguntar_agente" fala com o porta-voz: não interrompe o executor e não precisa de confirmação. Use quando a pessoa duvidar do estado, pedir pra conferir, ou perguntar algo sobre o que foi feito que os FATOS não respondem; em "texto" ponha a pergunta, de forma específica.
- Pra MOSTRAR tarefas (quais estão abertas, o que espera a pessoa, como está tal tarefa) use um passo ("abertas", "status", "esperando", "erros", "tarefa"…): o app desenha a lista. NUNCA liste tarefas em texto corrido dentro de "fala".
- "fala" tem no máximo 2 frases curtas. Se precisar enumerar algo que não é tarefa, use lista markdown (uma linha "- item" por item). Nunca escreva os identificadores T1, T2… em "fala" ou "duvida": cite o título.
- "fala" é o que você diz pra pessoa, curto, em português. Se o pedido for uma pergunta sobre as tarefas que dá pra responder com o que está acima, responda em "fala" e deixe "passos" vazio. Se exigir ler o código, use "ler_codigo".
- Nunca invente tarefa, código ou fato.`;
}
/** Troca os identificadores internos (T1, T2…) pelo título, no texto que a IA escreveu. `refs`: [{ ref, code, title }] */
function cmdSemRefs(text, refs){ return String(text||'').replace(/\bT(\d{1,3})\b/g, (m)=>{ const r=(refs||[]).find(x=>x.ref===m && !x.code); return r?'“'+(r.title.length>40?r.title.slice(0,39)+'…':r.title)+'”':m; }); }
/** No HTML já formatado, cada código de tarefa conhecido vira um atalho clicável (fora das tags). `ids`: { CODE: id } */
function cmdLinkCodes(html, ids){
  return String(html||'').split(/(<[^>]+>)/).map(seg=>seg.startsWith('<')?seg:seg.replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, (m)=>ids&&ids[m]?`<button type="button" class="cmdchipc" data-cmdsel="${ids[m]}">${m}</button>`:m)).join('');
}
// @comando-puro-fim

const CMD={ msgs:{}, sel:'', hist:{}, busy:false, stopping:false, starting:'', asking:'', sugerindo:'', spoken:0, unread:0, outrosAt:0, logHtml:'', sideHtml:'', mounted:false };
function cmdRepo(){ return (typeof state!=='undefined'&&state.repo)||''; }
function cmdMsgs(){ return CMD.all||(CMD.all=[]); } // UMA conversa, mesmo quando um passo troca de projeto
function cmdTasks(){ let l=[]; try{ l=flowLiveTasks(); }catch(_){ l=((typeof state!=='undefined'&&state.tasks)||[]).filter(t=>!taskEncerrada(t)); }
  return l.slice().sort((a,b)=>{ const oa=CMD_ORDEM[taskSt(a)]??5, ob=CMD_ORDEM[taskSt(b)]??5; return oa-ob || (b.updatedAt||0)-(a.updatedAt||0); }); }
function cmdCode(t){ return t.issueCode||(typeof issueCodeOf==='function'&&issueCodeOf(t))||''; }
function cmdTask(id){ return ((typeof state!=='undefined'&&state.tasks)||[]).find(t=>t.id===id)||null; }
// todas as que o app enxerga (as abertas, inclusive de outros projetos na Central integrada)
function cmdTaskAny(id){ return cmdTask(id)||cmdTasks().find(t=>t.id===id)||null; }
function cmdAsk(t){ try{ return tlAskGroup(pendingOf(t.id)); }catch(_){ return null; } }
function cmdAskTitle(t){ const g=cmdAsk(t); if(!g||!g.rows||!g.rows.length) return ''; const p=g.rows[0];
  let ti=''; try{ ti=tlAskSplit(p.prompt||'', p.header, p.q).title; }catch(_){ ti=String(p.prompt||''); } return (g.rows.length>1?g.rows.length+' perguntas · ':'')+ti; }
function cmdIsRun(t){ return ['running','thinking','integrando'].includes(taskSt(t)); }
function cmdIsBad(t){ const s=taskSt(t); return stIsBad(s)||s==='mudanca-pedida'; }
function cmdIsAsk(t){ return ['asking','needs-you','plan-review'].includes(taskSt(t)); }

// ---------- issues do painel: ver a fila e COMEÇAR daqui (mesma criação da Nova demanda, com os padrões da pessoa) ----------
function cmdTrkOn(){ try{ return typeof trkReady==='function' && trkReady(); }catch(_){ return false; } }
async function cmdIssuesEnsure(){
  if(typeof trkLoad!=='function') return false;
  try{ if(!cmdTrkOn()) await trkLoad(); if(!cmdTrkOn()) return false;
    if(!trkIssues.length || Date.now()-trkIssuesAt>120000){ await trkFetchIssues(); trkIdxMemo=null; } return true; }
  catch(e){ console.warn('comando issues', e); return cmdTrkOn(); }
}
function cmdIssue(code){ try{ return (trkIssues||[]).find(i=>String(i.code).toLowerCase()===String(code).toLowerCase())||null; }catch(_){ return null; } }
function cmdIssueTask(code){ try{ return trkTasksFor(code).find(t=>!taskEncerrada(t))||null; }catch(_){ return null; } }
// issues que ainda não viraram tarefa e não estão concluídas no painel
function cmdFila(){ try{ const sts=(trk.connector||{}).statuses||[]; return trkTriFila(trkRowsNow()).map(r=>r.i).filter(i=>trkKindOfStatus(sts, i.status)!=='done'); }catch(_){ return []; } }
function cmdIssueCard(i){ const busy=CMD.starting===i.code;
  return `<div class="cmdiss"><div class="cmdiss-h"><span class="cmdcode">${esc(i.code)}</span><b>${esc(i.title)}</b></div><div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdstart="${escA(i.code)}"${CMD.starting?' disabled':''}>${busy?'começando…':'Começar agora'}</button><button type="button" class="btn sm quiet" data-cmdform="${escA(i.code)}">Ajustar antes</button></div></div>`; }
async function cmdStartIssue(code){
  const i=cmdIssue(code); if(!i){ toast('Não achei a '+code+' no painel de issues','warn'); return; }
  if(CMD.starting) return;
  const ja=cmdIssueTask(code); if(ja){ CMD.sel=ja.id; cmdHistLoad(ja.id); return cmdPaint(); }
  const sp=trkIssueSpec(i), reqs=[...new Set(sp.reqs)], pol=(typeof ntPolicy!=='undefined'&&ntPolicy)||{};
  // a política do time pede requisitos e a issue não tem: completa no formulário (já preenchido), não cria pela metade
  if(reqs.length<(+pol.minRequirements||0)){ cmdMsgs().push({ r:'bot', k:'txt', text:`A ${i.code} tem menos requisitos do que o time exige. Abri o formulário já preenchido pra você completar.` }); cmdPaint(true); return trkIssueToTask(i, 'run'); }
  CMD.starting=i.code; cmdPaint();
  try{
    const d=aiDefaults(), cr=ndKindCreate(sp.bug?'fix':'build');
    const payload={ start:true, title:String(sp.title||i.code).slice(0,90), workflow:null, agents:null, engine:defaultAiEngine(), model:d.model||null, advisor:d.advisor, approval:'auto',
      owns:cr.owns||null, off:null, objective:sp.objective||sp.title, deliverables:sp.goal?[sp.goal]:[], requirements:reqs, doc:cr.doc||null,
      proof:true, tests:!!pol.testsRequired, autoPr:cr.autoPr, prBase:null, planApproval:'auto', refs:[], branchType:cr.branchType, issue:i.code, issueUrl:i.url||undefined };
    const nid=await invoke('new_task', await trkBeforeNewTask(payload, { ask:true }));
    if(typeof budgetApply==='function') await budgetApply(nid);
    try{ lastSig=''; }catch(_){ } await refresh(); trkIdxMemo=null;
    CMD.sel=nid; cmdMsgs().push({ r:'bot', k:'txt', text:`Comecei a ${i.code}. A IA já está trabalhando; a tarefa está aberta ao lado.` });
  }catch(e){ if(!(e&&e.shown)) showErr(e, 'Não consegui começar a '+i.code); cmdMsgs().push({ r:'sys', text:'a '+i.code+' não foi iniciada' }); }
  CMD.starting=''; cmdPaint(true);
}

// ---------- o estado REAL da tarefa (além do selo): requisitos com prova, portões, plano, última ação ----------
function cmdHa(ts){ if(!ts) return ''; const m=Math.round((Date.now()-ts)/60000); return m<1?'agora':m<60?'há '+m+' min':m<1440?'há '+Math.round(m/60)+' h':'há '+Math.round(m/1440)+' d'; }
function cmdReqs(t){ try{ if(typeof reqRows==='function') return reqRows(t).filter(r=>r.status!=='deferred').map(r=>({ tx:r.text, ok:r.st==='ok' })); }catch(_){ }
  return (Array.isArray(t.requirements)?t.requirements:[]).map(r=>typeof r==='string'?{ tx:r, ok:false }:{ tx:r.text||r.title||'', ok:r.status==='done' }).filter(r=>r.tx); }
function cmdFacts(t){
  const out=[], rq=cmdReqs(t), h=CMD.hist[t.id], it=(h&&h.items)||[], st=TERM&&TERM[t.id];
  if(rq.length) out.push(`${rq.filter(r=>r.ok).length} de ${nPl(rq.length,'requisito','requisitos')} com prova`); else out.push('sem requisitos cadastrados');
  try{ if(typeof apVm==='function' && ['review','delivered','pr-open','falta-prova','para-aprovar','mudanca-pedida'].includes(taskSt(t))){ const v=apVm(t); const ruins=(v.chips||[]).filter(c=>c.st!=='ok').map(c=>c.tx); if(ruins.length) out.push('portões pendentes: '+ruins.join(', ')); else if((v.chips||[]).length) out.push('todos os portões ok'); if(v.rev) out.push('revisor: '+(v.rev.verdict==='aprova'?'aprovou':'pediu mudança')); } }catch(_){ }
  out.push(t.prUrl?'PR aberto':'sem PR');
  const pl=cmdPlan(it); if(pl.length) out.push(`plano: ${pl.filter(x=>x.st==='ok').length} de ${pl.length} passos feitos`+(pl.find(x=>x.st==='now')?` (em “${pl.find(x=>x.st==='now').tx}”)`:''));
  const fs=cmdFiles(it); if(fs.length) out.push(nPl(fs.length,'arquivo mexido','arquivos mexidos')+' nesta sessão');
  const last=it.length?it[it.length-1].ts:0; if(last) out.push('última ação da IA '+cmdHa(last));
  out.push(cmdIsRun(t)?'a IA está trabalhando agora':(st&&st.alive)?'terminal aberto, IA parada':'IA parada');
  return out;
}
function cmdTaskContext(t){
  const h=CMD.hist[t.id], it=(h&&h.items)||[], rq=cmdReqs(t), pl=cmdPlan(it), dec=cmdDecisions(it), say=cmdLastSay(it);
  const obj=String(t.objective||'').split('[PLANO DO ORQUESTRADOR')[0].trim();
  return [`${cmdCode(t)||''} "${mdTitle(t.title||'')}" — selo: ${stLabel(taskSt(t))}`, t.branch?'branch: '+t.branch:'', t.worktree?'pasta: '+t.worktree:'',
    'fatos: '+cmdFacts(t).join('; '),
    obj?'pedido: '+obj.slice(0,700):'',
    rq.length?'requisitos:\n'+rq.map(r=>`  [${r.ok?'provado':'sem prova'}] ${cmdUma(r.tx)}`).join('\n'):'',
    pl.length?'plano da IA:\n'+pl.map(x=>`  [${x.st==='ok'?'feito':x.st==='now'?'agora':'a fazer'}] ${x.tx}`).join('\n'):'',
    dec.length?'decisões:\n'+dec.slice(-6).map(d=>`  P: ${cmdUma(d.q)} → ${d.a?cmdUma(d.a):'(sem resposta)'}`).join('\n'):'',
    it.length?'últimos passos:\n'+cmdPath(it, 12).map(x=>`  ${x.v}: ${x.tx}`).join('\n'):'(sessão ainda não lida)',
    say?'última fala do agente:\n'+say.slice(0,1400):''].filter(Boolean).join('\n');
}
// PERGUNTAR AO AGENTE da tarefa: manda a pergunta pro terminal dela e traz a resposta pra conversa
function cmdHistFetch(id){ return invokeQuiet('term_history',{ taskId:id, since:null }).then(r=>{ const items=(r&&Array.isArray(r.items))?r.items:null; if(items){ const cur=CMD.hist[id]||(CMD.hist[id]={}); cur.items=items; cur.stamp=r.stamp||''; cur.at=Date.now(); } return items||((CMD.hist[id]||{}).items)||[]; }).catch(()=>((CMD.hist[id]||{}).items)||[]); }
function cmdDia(ts){ if(!ts) return ''; const d=new Date(ts), h=new Date(), hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  const dias=Math.round((new Date(h.getFullYear(),h.getMonth(),h.getDate())-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/86400000);
  return dias===0?'hoje '+hm:dias===1?'ontem '+hm:String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0'); }
// PROPOSTA: o que a IA entendeu de um pedido que mexe numa tarefa — a pessoa vê a tarefa e o texto e confirma
function cmdPropostaHtml(m){ const it=m.it||{}, t=it.id?cmdTask(it.id):null, i=cmdMsgs().indexOf(m);
  const alvo=t?`<b>${esc(cmdCode(t)||'')}</b> ${esc(mdTitle(t.title||''))}`:it.code?`a issue <b>${esc(it.code)}</b>`:'';
  const oque=it.k==='instruir'?'Mandar esta instrução pro agente da':it.k==='perguntar'?'Perguntar ao agente da':it.k==='continuar'?'Mandar continuar a':it.k==='ambiente'?'Subir o ambiente da':it.k==='issue'?'Começar':'Fazer na';
  const corpo=(it.k==='instruir'||it.k==='perguntar')&&it.text?`<div class="cmdins"><p>${esc(it.text)}</p></div>`:'';
  const pe=m.done==='sim'?'<span class="cmdhint">feito</span>':m.done==='nao'?'<span class="cmdhint">não fiz — me diga de outro jeito qual tarefa e o quê</span>'
    :`<button type="button" class="btn sm primary" data-cmdprop="${i}" data-ok="1">Sim, fazer</button><button type="button" class="btn sm quiet" data-cmdprop="${i}" data-ok="">Não é isso</button>`;
  return `<div class="cmdqa${m.done?'':' wait'}"><div class="cmdqa-h"><span class="cmdqa-who"><b>Entendi assim — confirma?</b></span></div><div class="cmdqa-w">${oque} ${alvo}${corpo?':':'.'}</div>${corpo?`<div style="margin:0 12px 12px">${corpo}</div>`:''}<div class="cmdiss-a">${pe}</div></div>`; }
function cmdDur(ms){ const sg=Math.max(0, Math.round(ms/1000)); return Math.floor(sg/60)+':'+String(sg%60).padStart(2,'0'); }
/** PORTA-VOZ: o segundo agente da tarefa. Só lê (sessão do executor, arquivos, git), tem sessão própria (lembra do que
 *  já conversou sobre a tarefa) e só roda quando o Comando precisa. Nada é escrito no terminal do executor. */
function cmdPvKey(id){ return 'pvsid:'+cmdRepo()+':'+id; }
async function cmdConferir(id, texto, o){
  const t=cmdTask(id), ms=cmdMsgs(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  if(!t) return say('Essa tarefa não está nesta máquina.');
  if(CMD.asking) return say('O porta-voz já está respondendo outra pergunta.');
  texto=String(texto||'').replace(/\s+/g,' ').trim()||'Como esta tarefa está de verdade agora?';
  CMD.sel=id; const m={ r:'bot', k:'pergunta', modo:'conferir', id, q:texto, state:'wait', t0:Date.now(), t1:0, text:'', agora:'' };
  CMD.asking=id; CMD.pv=m; ms.push(m); cmdPaint(true);
  const tick=setInterval(()=>{ m.t1=Date.now(); if(cmdAtiva()) cmdPaint(); }, 2000);
  try{
    await cmdHistFetch(id); try{ if(typeof reqProofCache!=='undefined' && reqProofCache[id]===undefined && typeof loadReqProofs==='function') await Promise.race([loadReqProofs(id), new Promise(r=>setTimeout(r, 2500))]); }catch(_){ }
    const key=cmdPvKey(id), pr=`[O QUE O APP SABE AGORA${t.base?' · base: '+t.base:''}]\n${cmdTaskContext(t)}\n[FIM]\n\nPERGUNTA DE QUEM COORDENA: ${texto}`;
    const r=await aiCallResumeSafe((p2,sid)=>invoke('comando_portavoz',{ taskId:id, prompt:p2, sessionId:sid||'', model:aiClaudeModel() }), lsGet(key)||'', pr, []);
    aiKeepSid(r, x=>lsSet(key, x));
    m.text=String((r&&r.text)||'').trim(); m.state=cmdFalaUtil(m.text)?'ok':'timeout'; if(m.state!=='ok') m.text='';
  }catch(e){ const msg=String((e&&e.message)||e||''); m.state='timeout'; m.erro=/PORTAVOZ_STOPPED/.test(msg)?'Parado.':((humanErr(msg)||{}).msg||msg.slice(0,200)); }
  clearInterval(tick); CMD.asking=''; CMD.pv=null; m.t1=Date.now(); cmdPaint(true); if(m.text && CMDV.on) cmdSpeak(cmdFrase1(m.text));
  if(m.text && !(o&&o.semLeitura)) await cmdPlanejar('', { interno:`O porta-voz da ${cmdCode(t)||'tarefa'} respondeu à pergunta «${texto}»:\n«${m.text.slice(0,2500)}»\nNão repita a pergunta. Em "fala", diga só a conclusão em UMA frase. Se faltar algo que o executor deve fazer, proponha o passo "instruir" com um texto específico baseado nessa resposta.`, semPerguntar:true });
}
// o que o porta-voz está fazendo agora ("lendo X", "git diff…") — evento do Rust
try{ window.__TAURI__.event.listen('portavoz-activity', ev=>{ const m=CMD.pv; if(!m) return; const l=String((ev&&ev.payload&&ev.payload.line)||'').trim(); if(!l) return; m.agora=l; if(cmdAtiva()) cmdPaint(); }); }catch(_){ }
async function cmdAskAgent(id, texto, o){
  const t=cmdTask(id), ms=cmdMsgs(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  if(!t) return say('Essa tarefa não está nesta máquina.');
  if(CMD.asking) return say('Já tem uma pergunta esperando o agente responder.');
  texto=String(texto||'').replace(/\s+/g,' ').trim();
  CMD.sel=id; const antes=(await cmdHistFetch(id)).length;
  // UMA linha só: quebra de linha no terminal envia a mensagem pela metade (foi o "No response requested." de 12/11)
  const pedido=`Pergunta de quem coordena esta tarefa (responda em texto, em português, sem alterar nenhum arquivo): ${texto} — Responda com o estado real: o que está feito, o que falta e o que impede de entregar.`;
  let ok=false; try{ ok=(await tiSend(id, pedido))!==false; }catch(e){ showErr(e, 'Não consegui falar com o agente'); }
  if(!ok) return say('Não consegui mandar a pergunta pro agente desta tarefa.');
  const m={ r:'bot', k:'pergunta', id, q:texto, state:'wait', t0:Date.now(), t1:0, text:'', agora:'' };
  CMD.asking=id; ms.push(m); cmdPaint(true);
  let visto=-1, parado=0, falas=[];
  while(Date.now()-m.t0<240000){
    await new Promise(r=>setTimeout(r, 3000));
    const it=await cmdHistFetch(id), novo=it.slice(antes); falas=novo.filter(x=>x && x.k==='say' && cmdFalaUtil(x.text)).map(x=>x.text);
    const ult=cmdPath(novo.filter(x=>x && x.k!=='you'), 1)[0]; m.agora=ult?ult.v+' '+ult.tx:'';
    const cur=cmdTask(id); if(it.length===visto) parado++; else { parado=0; visto=it.length; }
    if(falas.length && ((cur && !cmdIsRun(cur) && parado>=1) || parado>=3)) break;
    if(!falas.length && novo.length && cur && !cmdIsRun(cur) && parado>=6) break; // o turno acabou sem dizer nada útil
    m.t1=Date.now(); if(cmdAtiva()) cmdPaint();
  }
  CMD.asking=''; m.t1=Date.now(); m.state=falas.length?'ok':'timeout'; m.text=falas.join('\n\n');
  cmdPaint(true); if(m.text && CMDV.on) cmdSpeak(cmdFrase1(m.text));
  // o assistente LÊ a resposta junto com os fatos da tarefa e diz o que isso significa e o próximo passo
  if(!(o&&o.semLeitura)) await cmdPlanejar('', { interno:(m.text?`O agente da ${cmdCode(t)||'tarefa'} respondeu à pergunta «${texto}»:\n«${m.text.slice(0,2500)}»\n`:`O agente da ${cmdCode(t)||'tarefa'} NÃO deu resposta útil à pergunta «${texto}».\n`)
    +'Com isso e com os FATOS da tarefa aberta ao lado, diga a conclusão em até 2 frases (com os números) e proponha o próximo passo como plano. Não use perguntar_agente de novo.', semPerguntar:true });
}
function cmdPerguntaHtml(m){ const t=cmdTask(m.id), el=cmdDur((m.t1||Date.now())-m.t0), id=escA(m.id), conf=m.modo==='conferir';
  const st=m.state==='wait'?`<span class="cmdqa-st wait"><span class="pltyping"><i></i><i></i><i></i></span>${conf?'porta-voz lendo':'aguardando'} · ${el}</span>`:m.state==='ok'?`<span class="cmdqa-st ok">respondeu em ${el}</span>`:`<span class="cmdqa-st to">${conf?'sem resposta':'sem resposta em '+el}</span>`;
  const direto=`<button type="button" class="btn sm quiet" data-cmddo="perguntar-direto" data-id="${id}" title="Escreve a pergunta no terminal do executor. Se ele estiver trabalhando, ela entra na fila dele.">Perguntar direto ao executor</button>`;
  const corpo=m.state==='wait'?`<div class="cmdqa-w">${conf?(m.agora?'Agora: <span class="mono">'+esc(m.agora)+'</span>':'Lendo a sessão do executor e o código da branch. O executor não é interrompido.'):m.agora?'O agente agora: <span class="mono">'+esc(m.agora)+'</span>':'A pergunta chegou no terminal da tarefa. Ele responde sem alterar arquivos.'}</div>`
    :m.state==='ok'?`<div class="cmdqa-a cmdmd">${mdToHtml(m.text||'')}</div><div class="cmdiss-a"><button type="button" class="btn sm" data-cmdsug="${id}">O que você sugere?</button>${conf?direto:`<button type="button" class="btn sm quiet" data-cmddo="perguntar" data-id="${id}">Perguntar ao porta-voz</button>`}<button type="button" class="btn sm quiet" data-cmdsel="${id}">Ver a tarefa</button></div>`
    :`<div class="cmdqa-w">${conf?esc(m.erro||'O porta-voz não devolveu uma resposta.'):'O agente não deu uma resposta útil. Se ele estava trabalhando, a pergunta entrou na fila dele.'}</div><div class="cmdiss-a">${conf?direto:`<button type="button" class="btn sm" data-cmddo="perguntar" data-id="${id}">Perguntar ao porta-voz</button>`}<button type="button" class="btn sm quiet" data-cmdopen="${id}">Abrir a tarefa</button></div>`;
  return `<div class="cmdqa ${m.state}"><div class="cmdqa-h"><span class="cmdqa-who">${IC.stAsk||''}<b>${conf?'Porta-voz da tarefa':'Pergunta direta ao executor'}</b>${t?' · '+esc(cmdCode(t)||mdTitle(t.title||'').slice(0,30)):''}</span>${st}</div><div class="cmdqa-q">${esc(m.q||'')}</div>${corpo}</div>`; }

// ---------- ambiente da tarefa (a mesma Prévia: env_up/env_down) e encerrar ----------
function cmdEnvHtml(m){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>';
  const s=(typeof envSt==='function')?envSt(m.id):null, v=s&&s.view, id=escA(m.id), nome=esc(cmdCode(t)||mdTitle(t.title||'').slice(0,30));
  if(!s) return '<p>A prévia não está disponível nesta versão.</p>';
  if(v && v.fail) return `<div class="cmdqa to"><div class="cmdqa-h"><span class="cmdqa-who"><b>Ambiente</b> · ${nome}</span><span class="cmdqa-st to">não subiu</span></div><div class="cmdqa-w">${esc((v.fail&&v.fail.msg)||v.msg||'O site não ligou.')}</div><div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmddo="ambiente" data-on="1" data-id="${id}">Tentar de novo</button><button type="button" class="btn sm quiet" data-cmdopen="${id}">Abrir a tarefa</button></div></div>`;
  if(v && v.ready && v.url) return `<div class="cmdqa ok"><div class="cmdqa-h"><span class="cmdqa-who"><b>Ambiente</b> · ${nome}</span><span class="cmdqa-st ok">no ar</span></div><div class="cmdlks">${cmdLinkRow(['Endereço', v.url])}</div><div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdopen="${id}">Ver na Prévia da tarefa</button><button type="button" class="btn sm quiet" data-cmddo="ambiente" data-on="" data-id="${id}">Desligar</button></div></div>`;
  if(s.busy || (v && v.running)){ const st=(v&&Array.isArray(v.steps)&&v.steps.length)?v.steps[v.steps.length-1]:null;
    return `<div class="cmdqa wait"><div class="cmdqa-h"><span class="cmdqa-who"><b>Ambiente</b> · ${nome}</span><span class="cmdqa-st wait"><span class="pltyping"><i></i><i></i><i></i></span>subindo</span></div><div class="cmdqa-w">${st?esc(String(st.label||st.step||st.msg||'preparando')):'Ligando o site desta tarefa numa porta só dela.'}</div></div>`; }
  return `<div class="cmdqa"><div class="cmdqa-h"><span class="cmdqa-who"><b>Ambiente</b> · ${nome}</span><span class="cmdqa-st">desligado</span></div><div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmddo="ambiente" data-on="1" data-id="${id}">Subir o ambiente</button></div></div>`; }
function cmdFeitoHtml(m){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>';
  const h=CMD.hist[t.id], it=(h&&h.items)||null, id=escA(t.id); if(!it) return '<p class="cmdhint">lendo o que a IA fez…</p>';
  const fs=cmdFiles(it), pl=cmdPlan(it), dec=cmdDecisions(it).filter(d=>d.a), say=cmdLastSay(it), rq=cmdReqs(t);
  const sec=(tt, body)=>body?`<span class="cmdeye">${tt}</span>${body}`:'';
  return `<p>O que foi feito na <b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b>${fs.length?': '+nPl(fs.length,'arquivo mexido','arquivos mexidos')+', +'+fs.reduce((a,f)=>a+f.add,0)+' −'+fs.reduce((a,f)=>a+f.del,0):''}.</p>`
    +sec('Passos concluídos', pl.filter(x=>x.st==='ok').length?`<div class="cmdcks">${pl.map(x=>`<div class="cmdck${x.st==='ok'?' ok':x.st==='now'?' now':''}"><i>${x.st==='ok'?'✓':''}</i><span>${esc(x.tx)}</span></div>`).join('')}</div>`:'')
    +sec('Arquivos', fs.length?`<div class="cmdfiles">${fs.slice(0,10).map(f=>`<span class="f">${esc(f.f)}</span><span class="a">+${f.add}</span><span class="d">−${f.del}</span>`).join('')}</div>${fs.length>10?`<p class="cmdhint">e mais ${fs.length-10}</p>`:''}`:'<p class="cmdmuted">Nenhum arquivo mudou nesta sessão.</p>')
    +sec('Decisões tomadas com você', dec.length?dec.slice(-5).map(d=>`<div class="cmddec"><span>${esc(d.q)}</span><small>você respondeu: ${esc(d.a)}</small></div>`).join(''):'')
    +sec('Requisitos', rq.length?`<p class="cmdhint">${rq.filter(r=>r.ok).length} de ${rq.length} com prova.</p>`:'')
    +sec('Nas palavras do agente', say?`<div class="cmdquote">${mdToHtml(say.length>1500?say.slice(0,1500)+'…':say)}</div>`:'')
    +`<div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdia="Explique em detalhe o que foi feito nesta tarefa e por quê, arquivo por arquivo, e diga se algo parece incompleto." data-id="${id}">Explicar em detalhe</button><button type="button" class="btn sm quiet" data-cmddo="provas" data-id="${id}">Provas</button><button type="button" class="btn sm quiet" data-cmdopen="${id}">Abrir a tarefa</button></div>`; }

// ---------- épicos, links e provas ----------
function cmdAllTasks(){ return ((typeof state!=='undefined'&&state.tasks)||[]); }
function cmdEpics(){ const out=[], seen=new Set();
  try{ ((typeof teamEpics!=='undefined'&&teamEpics)||[]).forEach(e=>{ if(e && e.id && e.status!=='archived' && !seen.has(e.id)){ seen.add(e.id); out.push({ id:e.id, name:e.name||'Épico', status:e.status||'open' }); } }); }catch(_){ }
  cmdAllTasks().forEach(t=>{ const id=t.epic&&t.epic.epicId; if(id && !seen.has(id)){ seen.add(id); out.push({ id, name:(typeof epNameOf==='function'&&epNameOf(id))||'Épico', status:'open' }); } });
  return out; }
// as tarefas do épico: a MESMA lista da fila dos épicos (nuvem + local); sem nuvem, só as locais
function cmdEpicItems(eid){
  try{ if(typeof epqEpicTasks==='function'){ const l=epqEpicTasks(eid); if(l.length) return l; } }catch(_){ }
  return cmdAllTasks().filter(t=>t.epic&&t.epic.epicId===eid).map(t=>({ title:mdTitle(t.title||''), st:taskSt(t), b:['merged','done'].includes(t.status)?'ok':'run', wave:Math.max(1, parseInt(t.epic.wave,10)||1), local:t.id, code:cmdCode(t) })); }
function cmdEpicStat(eid){ const l=cmdEpicItems(eid); return { total:l.length, done:l.filter(x=>x.b==='ok').length, ask:l.filter(x=>x.b==='ask').length, run:l.filter(x=>x.b==='run').length, bad:l.filter(x=>x.b==='bad').length, rev:l.filter(x=>x.b==='rev'||x.b==='pr').length, l }; }
function cmdEpicCard(e){ const c=cmdEpicStat(e.id), p=[]; if(c.ask) p.push(nPl(c.ask,'espera você','esperam você')); if(c.bad) p.push(c.bad+' com erro'); if(c.run) p.push(c.run+' rodando'); if(c.rev) p.push(c.rev+' pra revisar');
  return `<div class="cmdiss"><div class="cmdiss-h"><b>${esc(e.name)}</b><span class="cmdhint">${e.status==='done'?'entregue':c.total?`${c.done} de ${c.total} entregues`:'sem tarefas ainda'}${p.length?' · '+esc(p.join(', ')):''}</span></div><div class="cmdiss-a"><button type="button" class="btn sm" data-cmdepic="${escA(e.id)}">Ver as tarefas</button><button type="button" class="btn sm quiet" data-cmdepopen="${escA(e.id)}">Abrir o épico</button></div></div>`; }
function cmdEpicHtml(eid){ const e=cmdEpics().find(x=>x.id===eid); if(!e) return '<p>Não achei esse épico.</p>';
  const c=cmdEpicStat(eid), row=x=>{ const t=x.local?cmdTask(x.local):null; if(t) return cmdRow(t);
    return `<div class="cmdrow off"><span class="cmddot" style="background:${stColor(x.st)}"></span><span class="cmdcode">${esc(x.code||'')}</span><span class="cmdtt">${esc(x.title)}<small>${x.who&&typeof personName==='function'?'com '+esc(personName(x.who,{ noYou:true })):'no time — não está nesta máquina'}</small></span><span class="cmdst" style="color:${stColor(x.st)}">${esc(stShort(x.st))}</span></div>`; };
  const ondas=[...new Set(c.l.map(x=>x.wave||1))].sort((a,b)=>a-b);
  return `<p><b>${esc(e.name)}</b>: ${c.total?`${c.done} de ${nPl(c.total,'tarefa entregue','tarefas entregues')}`:'ainda sem tarefas'}.</p>`
    +ondas.map(w=>`${ondas.length>1?`<span class="cmdeye">Onda ${w}</span>`:''}<div class="cmdrows">${c.l.filter(x=>(x.wave||1)===w).map(row).join('')}</div>`).join('')
    +cmdEpicAgoraHtml(eid); }
// o "agora" do épico: a MESMA frase e a MESMA ação da aba do épico (81-epico-aba: epaModelOf), lidas da nuvem na hora
const CMDE={};
const CMD_EPACT={ start:'Começar o épico', liberar:'Liberar a onda', verificar:'Rodar a verificação final', entregar:'Entregar o épico' };
async function cmdEpicLoad(eid){
  try{ if(typeof epicPageLoad!=='function' || typeof epaModelOf!=='function') return null;
    const c=await epicPageLoad(eid), ep=c.ep||((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===eid); if(!ep) return null;
    const locOnly=(typeof epStartItems==='function'?epStartItems(eid):[]).filter(x=>x.kind==='local' && !(c.tasks||[]).some(ct=>ct.local_id===x.id || ((typeof tmap==='function')&&tmap()[x.id]===ct.id)))
      .map(x=>({ ...x.t, _local:x.id, spec:{ wave:x.wave, verify:(x.t.epic||{}).verify, covers:(x.t.epic||{}).covers } }));
    const tasks=(c.tasks||[]).concat(locOnly);
    return (CMDE[eid]={ ep, c, tasks, R:epaModelOf(ep, c, tasks) }); }
  catch(e){ console.warn('comando épico', e); return null; }
}
function cmdEpicAgoraHtml(eid){ const L=CMDE[eid]; if(!L) return '<p class="cmdhint">lendo o épico…</p>';
  const a=L.R.m.agora||{}, act=a.act&&CMD_EPACT[a.act.k]?a.act:null;
  return `<div class="cmdagora"><b>Agora:</b> ${esc(a.s||'')}${a.m?`<small>${esc(a.m)}</small>`:''}</div>`
    +`<div class="cmdiss-a">${act?`<button type="button" class="btn sm primary" data-cmdepact="${escA(act.k)}" data-id="${escA(eid)}"${act.wave?` data-wave="${act.wave}"`:''}>${esc(act.label||CMD_EPACT[act.k])}</button>`:''}<button type="button" class="btn sm${act?' quiet':''}" data-cmdepopen="${escA(eid)}">Abrir o épico</button></div>`; }
/** Executa a ação DO MOMENTO do épico (só a que a aba dele ofereceria agora), com confirmação. */
async function cmdEpicAct(eid, k, wave, sem){
  const L=await cmdEpicLoad(eid), ms=cmdMsgs(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  if(!L) return say('Não consegui ler esse épico agora.');
  const a=L.R.m.agora||{}, act=a.act||null, nome=L.ep.name||'épico';
  if(!act || act.k!==k) return say(`Agora não dá pra ${String(CMD_EPACT[k]||k).toLowerCase()} em “${nome}”. ${a.s||''}`);
  const w=+wave||act.wave||1;
  if(!sem && !await askYes(`${act.label||CMD_EPACT[k]} — “${nome}”?\n\n${a.s||''}${k==='entregar'?'\n\nFecha o épico, gera o relatório e avisa quem pediu.':k==='start'?'\n\nAs tarefas da primeira onda começam a rodar.':''}`, CMD_EPACT[k])){ ms.push({ r:'sys', text:'cancelado — o épico ficou como estava' }); return cmdPaint(true); }
  try{ EPA.last=L; EPA.eid=eid;
    if(k==='start') await epaStart(L.ep, null); else if(k==='liberar') await epaRelease(L.ep, w); else if(k==='verificar') await epFinalRun(eid, { manual:true }); else if(k==='entregar') await epEntregar(L.ep, null);
  }catch(e){ showErr(e, 'Não consegui '+String(CMD_EPACT[k]||k).toLowerCase()); }
  try{ lastSig=''; }catch(_){ } try{ await refresh(); }catch(_){ }
  await cmdEpicLoad(eid); ms.push({ r:'bot', k:'epico', id:eid }); cmdPaint(true);
}
function cmdLinks(t){ const code=cmdCode(t), iss=code?cmdIssue(code):null; const out=[];
  const iu=t.issueUrl||(iss&&iss.url)||''; if(iu) out.push(['Issue'+(code?' '+code:''), iu]);
  if(t.prUrl) out.push(['Pull request', t.prUrl]);
  if(t.branch) out.push(['Branch', t.branch, true]);
  return out; }
function cmdLinkRow(l){ return `<div class="cmdlk"><span class="cmdlk-l">${esc(l[0])}</span><span class="cmdlk-v mono">${esc(l[1])}</span>${l[2]?'':`<button type="button" class="btn sm quiet" data-cmdlk="${escA(l[1])}">abrir ↗</button>`}<button type="button" class="btn sm quiet" data-cmdcopy="${escA(l[1])}">copiar</button></div>`; }
function cmdLinksHtml(l){ return l.length?`<div class="cmdlks">${l.map(cmdLinkRow).join('')}</div>`:''; }

// ---------- peças ----------
function cmdRow(t){ const st=taskSt(t), q=cmdIsAsk(t)?cmdAskTitle(t):'';
  return `<button type="button" class="cmdrow${CMD.sel===t.id?' on':''}" data-cmdsel="${escA(t.id)}"><span class="cmddot" style="background:${stColor(st)}"></span><span class="cmdcode">${esc(cmdCode(t))}</span><span class="cmdtt">${esc(mdTitle(t.title||''))}${q?`<small>${esc(q)}</small>`:''}</span><span class="cmdst" style="color:${stColor(st)}">${esc(stShort(st))}</span></button>`; }
function cmdRows(l){ return l.length?`<div class="cmdrows">${l.map(cmdRow).join('')}</div>`:''; }
function cmdCounts(l){ const n=f=>l.filter(f).length; return { all:l.length, ask:n(cmdIsAsk), bad:n(cmdIsBad), run:n(cmdIsRun), rev:n(t=>(CMD_ORDEM[taskSt(t)]??5)===2), pr:n(t=>taskSt(t)==='pr-open') }; }
function cmdResumo(c){ if(!c.all) return 'Nenhuma tarefa aberta neste projeto.';
  const p=[]; if(c.ask) p.push(`<b>${nPl(c.ask,'espera','esperam')} você</b>`); if(c.bad) p.push(`<b>${nPl(c.bad,'parou','pararam')} com erro</b>`); if(c.run) p.push(nPl(c.run,'rodando','rodando')); if(c.rev) p.push(nPl(c.rev,'pronta pra revisar','prontas pra revisar')); if(c.pr) p.push(nPl(c.pr,'com PR aberto','com PR aberto'));
  return `${nPl(c.all,'tarefa aberta','tarefas abertas')}${p.length?': '+p.join(', '):''}.`; }

// ---------- ASSISTENTE: vigia as tarefas e ABRE a conversa quando precisa de você ----------
function cmdNeedsNow(){ return cmdNeeds(cmdTasks().map(t=>{ let ask=''; try{ const g=cmdAsk(t); ask=(g&&g.key)||''; }catch(_){ } return { id:t.id, st:taskSt(t), ask }; })); }
function cmdSeenKey(){ return 'cmdseen:'+cmdRepo(); }
function cmdWatch(){
  if(!cmdRepo() || typeof state==='undefined' || !Array.isArray(state.tasks)) return;
  let seen=null; try{ const v=lsGet(cmdSeenKey()); seen=v?JSON.parse(v):null; }catch(_){ seen=null; }
  const needs=cmdNeedsNow(), r=cmdNovos(needs, seen);
  if(!Array.isArray(seen) || r.seen.length!==seen.length || r.novos.length || r.seen.some((k,i)=>k!==seen[i])) lsSet(cmdSeenKey(), JSON.stringify(r.seen.slice(0,400)));
  if(!r.novos.length) return;
  cmdMsgs().push({ r:'bot', k:'aviso', ids:r.novos.map(n=>n.id), tipos:r.novos.map(n=>n.tipo) });
  r.novos.slice(0,5).forEach(n=>cmdHistFetch(n.id).then(()=>{ if(cmdAtiva()) cmdPaint(); }).catch(()=>{})); // o resumo do aviso sai do que a IA fez
  if(!cmdAtiva()){ CMD.unread+=r.novos.length; cmdBadge(); }
  else if(!CMD.sel && r.novos.length===1){ CMD.sel=r.novos[0].id; cmdHistLoad(CMD.sel); } // uma só e o painel livre: já abre ela ao lado
}
// OUTROS PROJETOS: a mesma vigia sobre a lista de todos os projetos (a da Central). Aviso na conversa + notificação do
// macOS (o projeto aberto já notifica pelo detectNotifs; aqui só o que está fora dele).
function cmdWatchOutros(){
  if(Date.now()-CMD.outrosAt<20000) return; CMD.outrosAt=Date.now();
  Promise.resolve(typeof loadAllTasks==='function'?loadAllTasks():null).then(()=>{
    const repo=cmdRepo(), L=((typeof allTasksCache!=='undefined'&&allTasksCache)||[]).filter(t=>t && t.repo && t.repo!==repo && !taskEncerrada(t) && t.flag!=='blocked');
    const needs=cmdNeeds(L.map(t=>({ id:t.repo+'::'+t.id, st:t.status, ask:'' })));
    let seen=null; try{ const v=lsGet('cmdseen:outros'); seen=v?JSON.parse(v):null; }catch(_){ seen=null; }
    const r=cmdNovos(needs, seen); lsSet('cmdseen:outros', JSON.stringify(r.seen.slice(0,600)));
    if(!r.novos.length) return;
    const its=r.novos.map(n=>{ const t=L.find(x=>x.repo+'::'+x.id===n.id); return t?{ repo:t.repo, id:t.id, title:mdTitle(t.title||''), code:(typeof issueCodeOf==='function'&&issueCodeOf(t))||'', tipo:n.tipo, st:t.status }:null; }).filter(Boolean);
    if(!its.length) return;
    cmdMsgs().push({ r:'bot', k:'aviso-outros', its });
    if(!cmdAtiva()){ CMD.unread+=its.length; cmdBadge(); } else cmdPaint(true);
    try{ const a=its[0]; pushNotif(its.length===1?'Precisamos conversar · '+pathBase(a.repo):'Precisamos conversar sobre '+its.length+' tarefas', its.length===1?(a.code?a.code+' ':'')+a.title+' — '+CMD_TIPO[a.tipo]:its.slice(0,3).map(x=>(x.code||x.title.slice(0,24))+' ('+pathBase(x.repo)+')').join(', '), null); }catch(_){ }
  }).catch(()=>{});
}
function cmdAvisoOutrosHtml(m){ const its=m.its||[];
  return `<p>Em outros projetos, precisamos conversar sobre <b>${nPl(its.length,'tarefa','tarefas')}</b>.</p><div class="cmdrows">${its.map(x=>`<button type="button" class="cmdrow" data-cmdcross="${escA(x.repo)}" data-id="${escA(x.id)}"><span class="cmddot" style="background:${stColor(x.st)}"></span><span class="cmdcode">${esc(x.code)}</span><span class="cmdtt">${esc(x.title)}<small>${esc(pathBase(x.repo))} · ${CMD_TIPO[x.tipo]}</small></span><span class="cmdst" style="color:${stColor(x.st)}">${esc(stShort(x.st))}</span></button>`).join('')}</div><p class="cmdhint">Clicar troca pro projeto e abre a tarefa.</p>`; }
// o RESUMO do aviso: o que aconteceu, lido da tarefa (sem IA) — e o que dá pra fazer agora
function cmdFrase1(s){ s=String(s||'').replace(/[*_`#>]/g,'').replace(/\s+/g,' ').trim(); const m=/^(.{20,260}?[.!?])(\s|$)/.exec(s); return m?m[1]:(s.length>260?s.slice(0,259)+'…':s); }
function cmdAvisoResumo(t, tipo){
  const h=CMD.hist[t.id], it=(h&&h.items)||null, out=[], acts=[], id=escA(t.id);
  if(tipo==='ask'){ const g=cmdAsk(t), p=g&&g.rows&&g.rows[0]; const q=cmdAskTitle(t);
    if(q) out.push('Ela pergunta: “'+q+'”'+(p&&p.options&&p.options.length?' Opções: '+p.options.slice(0,4).join(' · ')+'.':''));
    acts.push(`<button type="button" class="btn sm primary" data-cmdsel="${id}">Responder ao lado</button>`); }
  else if(tipo==='bad'){ const er=it?cmdLastErr(it):null;
    if(er) out.push(`Parou em ${er.name} ${cmdUma(er.arg)}${er.out?': '+er.out:''}.`);
    acts.push(`<button type="button" class="btn sm primary" data-cmdsug="${id}">O que você sugere?</button>`, `<button type="button" class="btn sm quiet" data-cmddo="perguntar" data-id="${id}">Perguntar ao porta-voz</button>`); }
  else { const rq=cmdReqs(t), ok=rq.filter(r=>r.ok).length;
    out.push(rq.length?`${ok} de ${nPl(rq.length,'requisito','requisitos')} com prova${ok<rq.length?' — faltam '+(rq.length-ok):''}.`:'Sem requisitos cadastrados.'); out.push(t.prUrl?'PR aberto.':'Ainda sem PR.');
    acts.push(`<button type="button" class="btn sm primary" data-cmddo="provas" data-id="${id}">Ver as provas</button>`, `<button type="button" class="btn sm quiet" data-cmdsug="${id}">O que você sugere?</button>`); }
  const say=it?cmdLastSay(it):''; if(say) out.push('O agente disse: “'+cmdFrase1(say)+'”');
  if(!it) out.push('lendo o que a IA fez…');
  return `<div class="cmdresumo"><div class="cmdresumo-h"><b>${esc(cmdCode(t)||mdTitle(t.title||'').slice(0,40))}</b><span style="color:${stColor(taskSt(t))}">${CMD_TIPO[tipo]}</span></div>${out.map(x=>`<p>${esc(x)}</p>`).join('')}<div class="cmdiss-a">${acts.join('')}<button type="button" class="btn sm quiet" data-cmdsel="${id}">Ver a tarefa</button></div></div>`;
}
// SUGESTÃO sob demanda: a IA lê a tarefa em foco e propõe UMA coisa; se for instrução pro agente, vem pronta pra mandar
async function cmdSuggest(id){
  const t=cmdTask(id), ms=cmdMsgs(); if(!t) return;
  if(CMD.busy || CMD.sugerindo){ toast('espere a resposta — ou pare','warn'); return; }
  if(typeof pcBusy!=='undefined' && pcBusy){ ms.push({ r:'sys', text:'o Chat do projeto está respondendo outra pergunta — espere terminar' }); return cmdPaint(true); }
  CMD.sel=id; CMD.sugerindo=id; CMD.busy=true; CMD.stopping=false; cmdPaint(true);
  const repo=cmdRepo(), out=CMD.msgs[repo]||ms;
  try{ await cmdHistFetch(id);
    const pr=`[TAREFA]\n${cmdTaskContext(t)}\n[FIM DA TAREFA]\nVocê é o assistente de quem coordena esta tarefa no Starfork. Leia o que aconteceu (pode abrir os arquivos da pasta da tarefa pra conferir) e proponha UMA próxima ação concreta. Responda EXATAMENTE neste formato, em português:\nSUGESTAO: <uma ou duas frases: o que está acontecendo de verdade e o que você faria>\nINSTRUCAO: <o texto pronto pra mandar ao agente da tarefa executar isso — ou "vazio" se a ação é da pessoa (aprovar, responder, decidir)>`;
    const r=await invoke('project_chat',{ prompt:pr, sessionId:'', model:aiClaudeModel() });
    const g=cmdSugestaoDe((r&&r.text)||''); out.push({ r:'bot', k:'sugestao', id, text:g.sug||'(sem sugestão)', ins:g.ins });
  }catch(e){ const msg=String((e&&e.message)||e||'');
    if(CMD.stopping||/PROJECT_CHAT_STOPPED/.test(msg)) out.push({ r:'sys', text:'parado' });
    else { const h=humanErr(msg); out.push({ r:'sys', text:'Não consegui sugerir: '+(h&&h.msg?h.msg:msg.slice(0,240)) }); } }
  CMD.busy=false; CMD.sugerindo=''; CMD.stopping=false; cmdPaint(true);
}
function cmdBadge(){ const c=$id('comandoCnt'); if(!c) return; c.hidden=!CMD.unread; c.textContent=CMD.unread>9?'9+':String(CMD.unread||''); c.title=CMD.unread?nPl(CMD.unread,'tarefa quer','tarefas querem')+' conversar com você':''; }
function cmdAvisoHtml(m){
  const its=(m.ids||[]).map((id,i)=>({ t:cmdTask(id), tipo:(m.tipos||[])[i]||'ask' })).filter(x=>x.t);
  if(!its.length) return '<p class="cmdhint">Um aviso antigo: a tarefa não está mais aberta.</p>';
  const frase=its.length===1?`Precisamos conversar sobre a <b>${esc(cmdCode(its[0].t)||mdTitle(its[0].t.title||''))}</b>.`:`Precisamos conversar sobre <b>${its.length} tarefas</b>.`;
  return `<p>${frase}</p>${its.slice(0,5).map(x=>cmdAvisoResumo(x.t, x.tipo)).join('')}${its.length>5?cmdRows(its.slice(5).map(x=>x.t)):''}`;
}
// a abertura da conversa: o que precisa de você AGORA, em ordem de urgência (e não só uma contagem)
function cmdAberturaHtml(){
  const L=cmdTasks(), needs=cmdNeedsNow(), c=cmdCounts(L);
  if(!L.length) return '<p>Nenhuma tarefa aberta neste projeto ainda. Diga o que quer fazer ou peça a fila de issues.</p>';
  if(!needs.length) return `<p>Nada precisa de você agora. ${cmdResumo(c)}</p><p class="cmdhint">Eu aviso aqui quando uma tarefa perguntar algo, parar ou terminar.</p>`;
  const por=k=>needs.filter(n=>n.tipo===k).map(n=>cmdTask(n.id)).filter(Boolean), blk=(k, tx)=>{ const l=por(k); return l.length?`<span class="cmdeye">${tx} · ${l.length}</span>${cmdRows(l.slice(0,6))}${l.length>6?`<p class="cmdhint">e mais ${l.length-6}</p>`:''}`:''; };
  return `<p>Precisamos conversar sobre <b>${nPl(needs.length,'tarefa','tarefas')}</b>.${c.run?' '+nPl(c.run,'agente segue','agentes seguem')+' trabalhando.':''}</p>${blk('ask','Perguntaram algo')}${blk('bad','Pararam com erro')}${blk('rev','Terminaram e esperam revisão')}<p class="cmdhint">Eu aviso aqui quando aparecer mais alguma.</p>`;
}

function cmdMd(text){ const ids={}; cmdTasks().forEach(t=>{ const c=cmdCode(t); if(c && cmdTask(t.id)) ids[c]=escA(t.id); }); return `<div class="cmdmd">${cmdLinkCodes(mdToHtml(text||''), ids)}</div>`; }
// RESULTADO de um passo em lote: uma lista só (em vez de uma fala por tarefa)
function cmdResultadoHtml(m){ const ok=m.itens.filter(x=>x.ok).length;
  return `<div class="cmdqa ${ok===m.itens.length?'ok':'to'}"><div class="cmdqa-h"><span class="cmdqa-who"><b>${esc(m.titulo)}</b></span><span class="cmdqa-st ${ok===m.itens.length?'ok':'to'}">${ok} de ${m.itens.length}</span></div><div class="cmdres">${m.itens.map(x=>`<div class="${x.ok?'ok':'no'}"><i>${x.ok?'✓':'✕'}</i><span class="cmdcode">${esc(x.code)}</span><span class="cmdtt">${esc(x.title)}${x.nota?`<small>${esc(x.nota)}</small>`:''}</span></div>`).join('')}</div></div>`; }
// ---------- respostas (montadas dos dados na hora de pintar: a lista da conversa acompanha o estado) ----------
function cmdBotHtml(m){
  const L=cmdTasks();
  if(m.k==='status') return `<p>${cmdResumo(cmdCounts(L))}</p>${cmdRows(L)}${L.length?'<p class="cmdhint">Clique numa tarefa pra ver ela inteira ao lado.</p>':''}`;
  if(m.k==='espera'){ const l=L.filter(cmdIsAsk); return l.length?`<p>${nPl(l.length,'tarefa parada esperando','tarefas paradas esperando')} você. Clique pra responder ao lado, sem abrir a tarefa.</p>${cmdRows(l)}`:'<p>Nada esperando por você agora.</p>'; }
  if(m.k==='erro'){ const l=L.filter(cmdIsBad); return l.length?`<p>${nPl(l.length,'tarefa parou','tarefas pararam')} com erro. Clique pra ver o que aconteceu.</p>${cmdRows(l)}`:'<p>Nenhuma tarefa parada com erro.</p>'; }
  if(m.k==='tarefa'||m.k==='porque'){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está mais aberta.</p>';
    const h=CMD.hist[t.id], it=(h&&h.items)||[], st=taskSt(t), say=cmdLastSay(it), er=cmdLastErr(it), q=cmdAskTitle(t);
    const partes=[`<p><b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b> está marcada como <b style="color:${stColor(st)}">${esc(stLabel(st))}</b>.${q?' Pergunta aberta: '+esc(q):''}</p>`];
    if(!h || !h.items) partes.push('<p class="cmdhint">lendo o que a IA fez…</p>');
    else {
      if(m.k==='porque' && er) partes.push(`<p>O último erro foi em <span class="mono">${esc(er.name)} ${esc(cmdUma(er.arg))}</span>${er.out?': '+esc(er.out):''}.</p>`);
      else if(m.k==='porque' && !er && !q) partes.push('<p>Não achei erro de ferramenta na sessão; veja o caminho ao lado.</p>');
      partes.push(`<ul class="cmdfacts">${cmdFacts(t).map(f=>`<li>${esc(f)}</li>`).join('')}</ul>`);
      if(say) partes.push(`<span class="cmdeye">Última fala do agente</span><div class="cmdquote">${mdToHtml(say.length>1200?say.slice(0,1200)+'…':say)}</div>`);
    }
    return partes.join('')+`<div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmddo="perguntar" data-id="${escA(t.id)}">Perguntar ao porta-voz como está de verdade</button><button type="button" class="btn sm quiet" data-cmddo="provas" data-id="${escA(t.id)}">Provas</button><button type="button" class="btn sm quiet" data-cmdopen="${escA(t.id)}">Abrir a tarefa</button></div>`; }
  if(m.k==='plano') return cmdPlanoHtml(m);
  if(m.k==='proposta') return cmdPropostaHtml(m);
  if(m.k==='pergunta') return cmdPerguntaHtml(m);
  if(m.k==='ambiente') return cmdEnvHtml(m);
  if(m.k==='feito') return cmdFeitoHtml(m);
  if(m.k==='resposta'){ const t=cmdTask(m.id); return `<span class="cmdeye">Resposta do agente${t?' · '+esc(cmdCode(t)||''):''}</span><div class="cmdquote">${mdToHtml(m.text||'')}</div>`; }
  if(m.k==='issue'){ const t=cmdIssueTask(m.code); if(t) return `<p><b>${esc(m.code)}</b> já é uma tarefa aberta.</p>${cmdRows([t])}`;
    const i=cmdIssue(m.code); if(!i) return `<p>Não achei a <b>${esc(m.code)}</b> nas tarefas nem no painel de issues.</p>`;
    return `<p>A <b>${esc(m.code)}</b> está no painel e ainda não virou tarefa. Começo com a sua IA padrão, numa branch nova?</p>${cmdIssueCard(i)}`; }
  if(m.k==='fila'){ if(!cmdTrkOn()) return `<p>O painel de issues ainda não está conectado neste projeto.</p><div><button type="button" class="btn sm" data-cmdgo="issues">Conectar em Issues</button></div>`;
    const f=cmdFila(); return f.length?`<p>${nPl(f.length,'issue do painel ainda não virou tarefa','issues do painel ainda não viraram tarefa')}.${f.length>8?' As 8 mais recentes:':''}</p><div class="cmdisss">${f.slice(0,8).map(cmdIssueCard).join('')}</div>`:'<p>Nenhuma issue do painel esperando pra começar.</p>'; }
  if(m.k==='epicos'){ const E=cmdEpics(); return E.length?`<p>${nPl(E.length,'épico','épicos')} neste espaço.</p><div class="cmdisss">${E.map(cmdEpicCard).join('')}</div>`:'<p>Nenhum épico aberto. Um épico nasce em Nova demanda › Montar com IA, ou no quadro do time.</p>'; }
  if(m.k==='epico') return cmdEpicHtml(m.id);
  if(m.k==='link'){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>'; const l=cmdLinks(t);
    return l.length?`<p>Links da <b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b>:</p>${cmdLinksHtml(l)}`:'<p>Essa tarefa ainda não tem issue ligada nem PR aberto.</p>'; }
  if(m.k==='isslink'){ const i=cmdIssue(m.code); return i&&i.url?`<p>Link da <b>${esc(m.code)}</b>:</p>${cmdLinksHtml([['Issue '+m.code, i.url]])}`:`<p>O painel não devolveu um link pra <b>${esc(m.code)}</b>.</p>`; }
  if(m.k==='provas'){ if(m.id){ const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>';
      return typeof proofPanel==='function'?`<p>Provas da <b>${esc(cmdCode(t)||mdTitle(t.title||''))}</b>. Clique num print pra ampliar.</p><div class="cmdproof">${proofPanel(t.id, 'compact')}</div>`:'<p>O painel de provas não está disponível.</p>'; }
    let f=[]; try{ f=apFila(); }catch(_){ } return f.length?`<p>${nPl(f.length,'tarefa terminou','tarefas terminaram')} com provas pra ver. Clique numa e peça "provas", ou abra Para aprovar.</p>${cmdRows(f)}<div class="cmdiss-a"><button type="button" class="btn sm" data-cmdgo="aprovar">Abrir Para aprovar</button></div>`:'<p>Nenhuma tarefa com provas esperando agora.</p>'; }
  if(m.k==='aviso') return cmdAvisoHtml(m);
  if(m.k==='aviso-outros') return cmdAvisoOutrosHtml(m);
  if(m.k==='sugestao'){ const t=cmdTask(m.id); return `<span class="cmdeye">Sugestão${t?' · '+esc(cmdCode(t)||''):''}</span><div class="cmdquote">${mdToHtml(m.text||'')}</div>`
    +(m.ins?`<div class="cmdins"><span class="cmdhint">Pra mandar ao agente:</span><p>${esc(m.ins)}</p></div><div class="cmdiss-a">${m.sent?'<span class="cmdhint">enviada ao agente</span>':`<button type="button" class="btn sm primary" data-cmdmandar="${cmdMsgs().indexOf(m)}">Mandar pro agente</button>`}<button type="button" class="btn sm quiet" data-cmdsug="${escA(m.id)}">Outra ideia</button></div>`:`<div class="cmdiss-a"><button type="button" class="btn sm quiet" data-cmdsel="${escA(m.id)}">Ver a tarefa</button></div>`); }
  if(m.k==='resultado') return cmdResultadoHtml(m);
  if(m.k==='md') return cmdMd(m.text||'');
  return `<p>${esc(m.text||'')}</p>`;
}
function cmdLogHtml(){
  const ms=cmdMsgs();
  const oi=`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub">${cmdAberturaHtml()}</div></div>`;
  return oi+ms.map(m=>m.r==='you'?`<div class="cmdmsg you"><div class="cmdbub">${esc(m.text)}</div></div>`
    :m.r==='sys'?`<div class="cmdmsg sys">${esc(m.text)}</div>`
    :`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub">${cmdBotHtml(m)}</div></div>`).join('')
    +(CMD.busy?`<div class="cmdmsg bot"><span class="cmdav">${IC.starfork||''}</span><div class="cmdbub"><span class="pltyping"><i></i><i></i><i></i></span> <span class="cmdhint">lendo o projeto…</span></div></div>`:'');
}

// ---------- painel: todos os agentes → visão geral da tarefa ----------
function cmdHora(ts){ if(!ts) return ''; const d=new Date(ts); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function cmdSec(t, body, extra){ return `<section class="cmdsec"><h3>${esc(t)}${extra||''}</h3>${body}</section>`; }
function cmdFleetHtml(){ const L=cmdTasks(), c=cmdCounts(L), proj=pathBase(cmdRepo());
  const n=(v,l,cor)=>`<span class="cmdn"><b${cor&&v?` style="color:${cor}"`:''}>${v}</b>${l}</span>`;
  return `<div class="cmdside-h"><span class="cmdeye">Agora${proj?' · '+esc(proj):''}</span><h2>Todos os agentes</h2><div class="cmdns">${n(c.run,'rodando','var(--st-run)')}${n(c.ask,'esperando você','var(--st-ask)')}${n(c.bad,'com erro','var(--st-err)')}${n(c.rev+c.pr,'pra revisar','var(--st-review)')}</div></div>`
    +(L.length?cmdRows(L):emptyHtml({ icon:'inbox', title:'Nenhuma tarefa aberta', help:'Crie uma demanda ou puxe uma issue do painel.' }))
    +`<div class="cmdside-f"><button type="button" class="btn sm" data-cmdgo="nova">${semIc('plus')}Nova demanda</button><button type="button" class="btn sm quiet" data-cmdgo="issues">Issues</button><button type="button" class="btn sm quiet" data-cmdgo="central">Central</button></div>`; }
function cmdTaskHtml(t){
  const st=taskSt(t), h=CMD.hist[t.id], it=(h&&h.items)||[], ask=cmdAsk(t);
  const obj=String(t.objective||'').split('[PLANO DO ORQUESTRADOR')[0].trim();
  const reqs=(Array.isArray(t.requirements)?t.requirements:[]).map(r=>typeof r==='string'?{ text:r }:r).filter(r=>r&&(r.text||r.title));
  const ck=(ok,now,tx,sub)=>`<div class="cmdck${ok?' ok':now?' now':''}"><i>${ok?'✓':''}</i><span>${esc(tx)}${sub?`<small>${esc(sub)}</small>`:''}</span></div>`;
  const pl=cmdPlan(it), dec=cmdDecisions(it), fs=cmdFiles(it), path=cmdPath(it, 30);
  const carregando='<p class="cmdmuted">lendo a sessão…</p>';
  return `<button type="button" class="cmdback" data-cmdsel="">${semIc('arrowR','rev')}todos os agentes</button>
    <div class="cmdside-h"><div class="cmdpills">${cmdCode(t)?`<span class="cmdpill mono">${esc(cmdCode(t))}</span>`:''}${stBadge(st)}${t.branch?`<span class="cmdpill mono" title="branch">${esc(t.branch)}</span>`:''}</div><h2>${esc(mdTitle(t.title||''))}</h2>
      <div class="cmdacts"><button type="button" class="btn sm primary" data-cmdopen="${escA(t.id)}">Abrir a tarefa ${semIc('arrowR')}</button>${cmdIsRun(t)?`<button type="button" class="btn sm" data-cmdstop="${escA(t.id)}">Parar</button>`:''}<button type="button" class="btn sm quiet" data-cmddo="provas" data-id="${escA(t.id)}">Provas</button><button type="button" class="btn sm quiet" data-cmddo="feito" data-id="${escA(t.id)}">O que foi feito</button><button type="button" class="btn sm quiet" data-cmddo="ambiente" data-on="1" data-id="${escA(t.id)}">Subir ambiente</button><button type="button" class="btn sm quiet cmddanger" data-cmddo="encerrar" data-id="${escA(t.id)}">Encerrar…</button>${cmdLinks(t).filter(l=>!l[2]).map(l=>`<button type="button" class="btn sm quiet" data-cmdlk="${escA(l[1])}">${esc(l[0])} ↗</button>`).join('')}</div></div>
    <div class="cmdduo"><span><i class="cmddot" style="background:${stColor(st)}"></i><b>Executor</b> ${esc(stShort(st))}</span><span><i class="cmddot" style="background:${CMD.asking===t.id?'var(--st-ask)':'var(--muted)'}"></i><b>Porta-voz</b> ${CMD.asking===t.id?'respondendo':'só responde quando você pergunta'}</span><button type="button" class="btn sm quiet" data-cmddo="perguntar" data-id="${escA(t.id)}">Perguntar ao porta-voz</button></div>
    ${ask?cmdSec('Precisa de você', `<div class="cmdask" data-tlinline="${escA(t.id)}"></div>`):''}
    ${cmdSec('Pedido', (obj?`<div class="cmdobj">${mdToHtml(obj.length>900?obj.slice(0,900)+'…':obj)}</div>`:'<p class="cmdmuted">Esta tarefa não tem descrição além do título.</p>')
      +(reqs.length?`<div class="cmdcks">${reqs.map(r=>ck(r.status==='done', false, r.text||r.title, r.status==='done'?'':'sem prova ainda')).join('')}</div>`:''))}
    ${cmdSec('Plano da IA', !h?carregando:pl.length?`<div class="cmdcks">${pl.map(p=>ck(p.st==='ok', p.st==='now', p.tx, p.st==='now'?'agora':'')).join('')}</div>`:'<p class="cmdmuted">A IA não declarou um plano nesta sessão.</p>', pl.length?`<span>${pl.filter(p=>p.st==='ok').length} de ${pl.length}</span>`:'')}
    ${cmdSec('Decisões', !h?carregando:dec.length?dec.map(d=>`<div class="cmddec${d.a?'':' open'}"><span>${esc(d.q)}</span><small>${d.a?'você respondeu: '+esc(d.a):'esperando sua resposta'}</small></div>`).join(''):'<p class="cmdmuted">A IA não perguntou nada até aqui.</p>')}
    ${cmdSec('Caminho', !h?carregando:path.length?`<div class="cmdtl">${path.map(p=>`<div class="k-${p.k}${p.err?' err':''}"><time>${cmdHora(p.ts)}</time><em>${esc(p.v)}</em><span>${esc(p.tx)}</span></div>`).join('')}</div>`:'<p class="cmdmuted">Nada registrado nesta sessão ainda.</p>', it.length>path.length?'<span>últimos passos</span>':'')}
    ${cmdSec('Arquivos mexidos', !h?carregando:fs.length?`<div class="cmdfiles">${fs.slice(0,14).map(f=>`<span class="f">${esc(f.f)}</span><span class="a">+${f.add}</span><span class="d">−${f.del}</span>`).join('')}</div>`:'<p class="cmdmuted">Nenhum arquivo mudou ainda.</p>', fs.length?`<span>${fs.length}</span>`:'')}
    <form class="cmdinst" data-cmdinst="${escA(t.id)}"><input class="in" id="cmdInst" placeholder="Diga à IA o que mudar nesta tarefa" autocomplete="off" aria-label="instrução para esta tarefa"><button class="btn primary sm">enviar</button></form>`;
}
function cmdSideHtml(){ const t=CMD.sel?cmdTask(CMD.sel):null; if(CMD.sel && !t) CMD.sel=''; return t?cmdTaskHtml(t):cmdFleetHtml(); }

// ---------- histórico da sessão (o MESMO term_history do terminal; incremental) ----------
function cmdHistLoad(id){ const h=CMD.hist[id]; if(h && h.busy) return; const at=h&&h.at||0; if(h && Date.now()-at<4000) return;
  const cur=h||(CMD.hist[id]={ items:null, stamp:'' }); cur.busy=true;
  invokeQuiet('term_history',{ taskId:id, since:(cur.items&&cur.stamp)||null }).then(r=>{ cur.busy=false; cur.at=Date.now();
    if(r && !r.unchanged){ cur.items=Array.isArray(r.items)?r.items:[]; cur.stamp=r.stamp||''; } else if(!cur.items) cur.items=[];
    CMD.hist[id]=cur; cmdPaint(); }).catch(()=>{ cur.busy=false; cur.at=Date.now(); if(!cur.items) cur.items=[]; cmdPaint(); }); }
// a "visão" só conta como carregada depois da 1ª leitura
function cmdHistReady(id){ const h=CMD.hist[id]; return !!(h && h.items); }

// ---------- voz: conversa falada (você fala, eu respondo em voz alta e volto a ouvir) ----------
// Ouvir = reconhecimento de fala do sistema (quando o WebView oferece); falar = speechSynthesis. Sem reconhecimento,
// o modo ainda LÊ as respostas e a pessoa dita pelo ditado do macOS.
const CMDV={ on:false, rec:null, live:false, speaking:false };
const CMD_MIC='<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2"/></svg>';
function cmdVoiceApi(){ return window.SpeechRecognition||window.webkitSpeechRecognition||null; }
function cmdVoicePaint(){ const b=$id('cmdMic'); if(!b) return; b.classList.toggle('on', CMDV.on); b.setAttribute('aria-pressed', String(CMDV.on));
  b.innerHTML=CMD_MIC+(CMDV.on?`<span>${CMDV.speaking?'falando…':CMDV.live?'ouvindo…':'voz ligada'}</span>`:''); b.title=CMDV.on?'Desligar a conversa por voz':'Conversar por voz: você fala, eu respondo em voz alta'; }
function cmdVoiceListen(on){
  const R=cmdVoiceApi(); if(!R) return;
  if(!on){ CMDV.live=false; try{ if(CMDV.rec) CMDV.rec.abort(); }catch(_){ } CMDV.rec=null; return cmdVoicePaint(); }
  if(CMDV.live || !CMDV.on || CMDV.speaking || CMD.busy) return;
  const r=new R(); r.lang='pt-BR'; r.interimResults=true; r.continuous=false; r.maxAlternatives=1;
  r.onresult=(e)=>{ let fin='', mid=''; for(let k=e.resultIndex;k<e.results.length;k++){ const x=e.results[k]; if(x.isFinal) fin+=x[0].transcript; else mid+=x[0].transcript; }
    const q=$id('cmdQ'); if(q){ q.value=(fin||mid).trim(); cmdGrow(); } if(fin.trim()){ if(q){ q.value=''; cmdGrow(); } cmdSay(fin.trim()); } };
  r.onerror=(e)=>{ CMDV.live=false; const k=String(e&&e.error||'');
    if(k==='not-allowed'||k==='service-not-allowed'||k==='audio-capture'){ CMDV.on=false; toast('O macOS não liberou o microfone pro Starfork. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone e Reconhecimento de Fala.','warn'); } cmdVoicePaint(); };
  r.onend=()=>{ CMDV.live=false; if(CMDV.rec===r) CMDV.rec=null; cmdVoicePaint(); if(CMDV.on && !CMDV.speaking && !CMD.busy) setTimeout(()=>cmdVoiceListen(true), 300); };
  CMDV.rec=r; try{ r.start(); CMDV.live=true; }catch(_){ CMDV.rec=null; } cmdVoicePaint();
}
function cmdSpeak(text){
  text=String(text||'').replace(/\s+/g,' ').trim(); if(!CMDV.on) return;
  if(!text || !window.speechSynthesis){ cmdVoiceListen(true); return; }
  try{ speechSynthesis.cancel(); cmdVoiceListen(false);
    const u=new SpeechSynthesisUtterance(text.length>500?text.slice(0,500):text); u.lang='pt-BR'; u.rate=1.05;
    const v=speechSynthesis.getVoices().find(x=>/^pt[-_]BR/i.test(x.lang)); if(v) u.voice=v;
    CMDV.speaking=true; const fim=()=>{ if(!CMDV.speaking) return; CMDV.speaking=false; cmdVoicePaint(); if(CMDV.on) cmdVoiceListen(true); };
    u.onend=fim; u.onerror=fim; speechSynthesis.speak(u); cmdVoicePaint();
  }catch(_){ CMDV.speaking=false; cmdVoiceListen(true); }
}
function cmdVoiceToggle(){
  CMDV.on=!CMDV.on;
  if(!CMDV.on){ CMDV.speaking=false; cmdVoiceListen(false); try{ speechSynthesis.cancel(); }catch(_){ } return cmdVoicePaint(); }
  CMD.spoken=cmdMsgs().length; // só fala o que vier a partir de agora
  if(cmdVoiceApi()) cmdVoiceListen(true);
  else toast('Vou ler as respostas em voz alta. Pra falar, use o ditado do macOS neste campo (tecla do microfone, ou Fn duas vezes).','info');
  cmdVoicePaint();
}
// a fala de uma resposta = os parágrafos dela (listas e botões ficam na tela)
function cmdSpeakNew(log){
  const ms=cmdMsgs(); if(!CMDV.on || CMD.busy || ms.length<=CMD.spoken) return; const m=ms[ms.length-1]; CMD.spoken=ms.length; if(!m || m.r!=='bot'){ if(m && m.r==='sys') cmdVoiceListen(true); return; }
  const bubs=log.querySelectorAll('.cmdmsg.bot .cmdbub'), bub=bubs[bubs.length-1]; if(!bub) return;
  const ps=[...bub.querySelectorAll(':scope > p:not(.cmdhint), :scope > .cmdquote')].map(n=>n.textContent).join(' ');
  cmdSpeak(ps||bub.textContent);
}

// ---------- página ----------
const CMD_CHIPS=['Como estão os agentes?','O que está me esperando?','Alguma tarefa parou?','O que tem na fila de issues?','Como estão os épicos?'];
function cmdMount(){
  const pg=$id('comandoPage'); if(!pg || CMD.mounted) return; CMD.mounted=true;
  pg.innerHTML=`<div class="cmdpg"><section class="cmdchat" aria-label="Comando">
      <div class="cmdlog" id="cmdLog" aria-live="polite"></div>
      <div class="cmdcomp"><div class="cmdchips">${CMD_CHIPS.map(c=>`<button type="button" class="cmdchip" data-cmdchip="${escA(c)}">${esc(c)}</button>`).join('')}</div>
        <form class="cmdbar" id="cmdForm"><textarea class="in" id="cmdQ" rows="1" placeholder="Pergunte ou mande fazer — ex.: como estão os agentes?" autocomplete="off" spellcheck="false" aria-label="comando"></textarea><button type="button" class="btn sm cmdmic" id="cmdMic" aria-pressed="false"></button><button type="button" class="btn sm" id="cmdStop" style="display:none">${IC.stop||''} parar</button><button class="btn primary sm" id="cmdSend">enviar</button></form></div>
    </section><aside class="cmdside" id="cmdSide" aria-label="painel dos agentes"></aside></div>`;
  // a caixa cresce com a mensagem (até ~8 linhas, depois rola): Enter envia, Shift+Enter quebra linha
  const cmdEnvia=()=>{ const q=$id('cmdQ'); const v=q.value; q.value=''; cmdGrow(); cmdSay(v); };
  $id('cmdForm').addEventListener('submit', e=>{ e.preventDefault(); cmdEnvia(); });
  { const q=$id('cmdQ'); q.addEventListener('input', cmdGrow); q.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); cmdEnvia(); } }); }
  $id('cmdStop').onclick=()=>{ if(CMD.asking && CMD.pv){ invoke('comando_portavoz_stop').catch(()=>{}); return; } if(!CMD.busy) return; CMD.stopping=true; invoke('project_chat_stop').catch(()=>{}); };
  $id('cmdMic').onclick=cmdVoiceToggle; cmdVoicePaint();
  pg.addEventListener('click', cmdClick);
  pg.addEventListener('submit', e=>{ const f=e.target.closest&&e.target.closest('[data-cmdinst]'); if(!f) return; e.preventDefault(); const i=f.querySelector('input'), v=i.value.trim(); if(!v) return;
    const id=f.dataset.cmdinst; i.value=''; Promise.resolve(typeof tiSend==='function'?tiSend(id, v):false).then(ok=>{ if(ok!==false){ toast('instrução enviada — a IA continua','ok'); const h=CMD.hist[id]; if(h) h.at=0; cmdHistLoad(id); } else i.value=v; }).catch(e2=>{ i.value=v; showErr(e2,'Não consegui enviar a instrução'); }); });
}
function cmdGrow(){ const q=$id('cmdQ'); if(!q) return; q.style.height='auto'; const h=Math.min(q.scrollHeight+2, 200); q.style.height=h+'px'; q.style.overflowY=q.scrollHeight>200?'auto':'hidden'; }
function cmdClick(e){
  const b=e.target.closest('[data-cmdsel],[data-cmdchip],[data-cmdopen],[data-cmdstop],[data-cmdgo],[data-cmdstart],[data-cmdform],[data-cmdlk],[data-cmdcopy],[data-cmdepic],[data-cmdepopen],[data-cmddo],[data-cmdepact],[data-cmdsug],[data-cmdmandar],[data-cmdcross],[data-cmdia],[data-cmdprop],[data-cmdplano]'); if(!b) return;
  if(b.dataset.cmdplano){ const m=cmdMsgs()[+b.dataset.cmdplano]; if(!m||m.done) return; if(!b.dataset.ok){ m.done='nao'; return cmdPaint(true); } m.done='run'; cmdPaint(true); return cmdRunPlan(m.plan).then(()=>{ m.done='sim'; cmdPaint(true); }); }
  if(b.dataset.cmdprop){ const m=cmdMsgs()[+b.dataset.cmdprop]; if(!m||m.done) return; m.done=b.dataset.ok?'sim':'nao'; cmdPaint(true); if(m.done==='sim') cmdDo(m.it); return; }
  if(b.dataset.cmdia){ CMD.sel=b.dataset.id||CMD.sel; return cmdSay(b.dataset.cmdia, true); }
  if(b.dataset.cmdsug) return cmdSuggest(b.dataset.cmdsug);
  if(b.dataset.cmdcross) return (typeof switchToProjectTask==='function')?switchToProjectTask(b.dataset.cmdcross, b.dataset.id):undefined;
  if(b.dataset.cmdmandar){ const m=cmdMsgs()[+b.dataset.cmdmandar]; if(!m||!m.ins||m.sent) return; b.disabled=true;
    return Promise.resolve(tiSend(m.id, m.ins)).then(ok=>{ if(ok!==false){ m.sent=true; toast('enviado ao agente — ele continua','ok'); const h=CMD.hist[m.id]; if(h) h.at=0; cmdHistLoad(m.id); } cmdPaint(true); }).catch(e=>{ showErr(e,'Não consegui mandar pro agente'); cmdPaint(true); }); }
  if(b.dataset.cmdepact) return cmdEpicAct(b.dataset.id, b.dataset.cmdepact, b.dataset.wave);
  if(b.dataset.cmdlk) return openExternal(b.dataset.cmdlk);
  if(b.dataset.cmdcopy){ try{ navigator.clipboard.writeText(b.dataset.cmdcopy); toast('copiado','ok'); }catch(_){ toast('não consegui copiar','warn'); } return; }
  if(b.dataset.cmdepic) return cmdDo({ k:'epico', id:b.dataset.cmdepic });
  if(b.dataset.cmdepopen) return (typeof epOpenById==='function')?epOpenById(b.dataset.cmdepopen):undefined;
  if(b.dataset.cmddo) return cmdDo(b.dataset.cmddo==='ambiente'?{ k:'ambiente', id:b.dataset.id, on:!!b.dataset.on }:{ k:b.dataset.cmddo, id:b.dataset.id||'' });
  if(b.dataset.cmdstart) return cmdStartIssue(b.dataset.cmdstart);
  if(b.dataset.cmdform){ const i=cmdIssue(b.dataset.cmdform); return i?trkIssueToTask(i, 'run'):undefined; }
  if(b.dataset.cmdchip!==undefined) return cmdSay(b.dataset.cmdchip);
  if(b.dataset.cmdsel!==undefined){ CMD.sel=b.dataset.cmdsel; if(CMD.sel) cmdHistLoad(CMD.sel); cmdPaint(); const s=$id('cmdSide'); if(s) s.scrollTop=0; return; }
  if(b.dataset.cmdopen) return openTaskById(b.dataset.cmdopen);
  if(b.dataset.cmdstop) return cmdStopTasks([b.dataset.cmdstop]);
  if(b.dataset.cmdgo){ const k=b.dataset.cmdgo; return cmdTela(k==='central'?'flow':k); }
}
async function cmdStopTasks(ids, sem){
  const ts=ids.map(cmdTask).filter(Boolean); if(!ts.length) return false;
  if(!sem && !await askYes(`Parar ${nPl(ts.length,'agente','agentes')}?\n\n${ts.map(t=>'• '+(cmdCode(t)?cmdCode(t)+' ':'')+mdTitle(t.title||'')).join('\n')}\n\nO que já foi feito fica salvo na branch. Dá pra retomar depois.`, 'Parar')) return false;
  for(const t of ts){ try{ await stopTask(t.id); }catch(_){ } }
  cmdMsgs().push({ r:'bot', k:'txt', text:`Parei ${nPl(ts.length,'agente','agentes')}. O trabalho feito está salvo na branch de cada tarefa.` }); cmdPaint(true); return true;
}
function cmdTela(k){ if(k==='flow'||k==='aprovar') return openTab(k); return (typeof semIr==='function' && ['meu','semana','entregas','issues','projetos','nova'].includes(k))?semIr(k):openTab(k); }
function cmdResolve(text){ const all=cmdTasks().concat(cmdAllTasks().filter(taskEncerrada)); // abertas primeiro; as entregues ainda respondem por provas e links
  return cmdIntent(text, all.map(t=>({ id:t.id, code:cmdCode(t), title:mdTitle(t.title||'') })), cmdEpics(), CMD.sel||''); }
/** Executa UMA ação (vinda da frase da pessoa, de um botão ou da linha "ACAO:" da IA). true = tratou. */
async function cmdDo(it){
  const ms=cmdMsgs(), L=cmdTasks(), say=(text)=>{ if(it.quiet){ it.out=text; return true; } ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); return true; };
  switch(it.k){
    case 'status': case 'espera': case 'erro': case 'epicos': ms.push({ r:'bot', k:it.k }); cmdPaint(true); return true;
    case 'epico': if(it.act){ cmdPaint(true); await cmdEpicAct(it.id, it.act, 0, it.sem); return true; }
      ms.push({ r:'bot', k:'epico', id:it.id }); cmdPaint(true); cmdEpicLoad(it.id).then(()=>cmdPaint()); return true;
    case 'tarefa': case 'porque': CMD.sel=it.id; cmdHistLoad(it.id); ms.push({ r:'bot', k:it.k, id:it.id }); cmdPaint(true); return true;
    case 'link': ms.push({ r:'bot', k:'link', id:it.id }); cmdPaint(true); return true;
    case 'feito': CMD.sel=it.id; ms.push({ r:'bot', k:'feito', id:it.id }); cmdPaint(true); cmdHistFetch(it.id).then(()=>cmdPaint()); return true;
    case 'encerrar': { const t=cmdTask(it.id); if(!t) return say('Essa tarefa não está nesta máquina.'); if(typeof encerrarTarefa!=='function') return say('Encerrar não está disponível nesta versão.');
      cmdPaint(true); if(taskEncerrada(t)) return say(`A ${cmdCode(t)||'tarefa'} já estava encerrada.`);
      const ok=await encerrarTarefa(it.id, it.motivo!=null?{ motivo:it.motivo }:{ anchor:$id('cmdQ') }); // a folha do app confirma, pede o motivo e dá 4 s pra desfazer
      it.ok=!!ok; if(ok){ if(CMD.sel===it.id) CMD.sel=''; return say(`Encerrei a ${cmdCode(t)||'tarefa'} sem entregar.`); } if(it.quiet){ it.out='ficou como estava'; return true; } ms.push({ r:'sys', text:'a tarefa ficou como estava' }); cmdPaint(true); return true; }
    case 'ambiente': { const t=cmdTask(it.id); if(!t) return say('Essa tarefa não está nesta máquina.'); if(typeof envUp!=='function') return say('A prévia não está disponível nesta versão.');
      if(it.on===false){ await envDown(it.id); return say(`Desliguei o ambiente da ${cmdCode(t)||'tarefa'}.`); }
      CMD.sel=it.id; ms.push({ r:'bot', k:'ambiente', id:it.id }); cmdPaint(true);
      { const tick=setInterval(()=>{ if(cmdAtiva()) cmdPaint(); }, 1500); envUp(it.id).catch(()=>{}).finally(()=>{ clearInterval(tick); cmdPaint(true); }); } return true; }
    case 'continuar': { const t=cmdTask(it.id); if(!t) return say('Essa tarefa não está nesta máquina.'); if(cmdIsRun(t)) return say(`A ${cmdCode(t)||'tarefa'} já está rodando.`);
      let ok=false; try{ ok=(await tiSend(it.id, 'Continue de onde parou.'))!==false; }catch(e){ showErr(e, 'Não consegui retomar a tarefa'); }
      if(ok){ CMD.sel=it.id; const h=CMD.hist[it.id]; if(h) h.at=0; cmdHistLoad(it.id); } return say(ok?`Mandei a ${cmdCode(t)||'tarefa'} continuar de onde parou.`:'Não consegui retomar a tarefa.'); }
    case 'perguntar': cmdConferir(it.id, it.text); return true;
    case 'perguntar-direto': cmdAskAgent(it.id, it.text||'Como esta tarefa está de verdade agora?'); return true;
    case 'provas': { const t=it.id?cmdTask(it.id):null; if(t){ CMD.sel=t.id; cmdHistLoad(t.id); try{ apEnsure(t); }catch(_){ } } ms.push({ r:'bot', k:'provas', id:it.id||'' }); cmdPaint(true); return true; }
    case 'abrir': say('Abrindo a tarefa.'); openTaskById(it.id); return true;
    case 'tela': say('Abrindo.'); cmdTela(it.tela); return true;
    case 'instruir': { const t=cmdTask(it.id); if(!t) return say('Essa tarefa não está nesta máquina.');
      it.text=String(it.text||'').replace(/\s+/g,' ').trim(); // uma linha só: quebra de linha no terminal envia pela metade
      let ok=false; try{ ok=(await tiSend(it.id, it.text))!==false; }catch(e){ showErr(e, 'Não consegui enviar a instrução'); }
      if(ok){ CMD.sel=it.id; const h=CMD.hist[it.id]; if(h) h.at=0; cmdHistLoad(it.id); }
      return say(ok?`Mandei pra IA da ${cmdCode(t)||'tarefa'}: “${it.text}”.`:'A instrução não foi enviada.'); }
    case 'parar': { const alvo=it.id?[it.id]:L.filter(cmdIsRun).map(t=>t.id);
      if(!alvo.length || (it.id && !cmdIsRun(cmdTask(it.id)))) return say(it.id?'Essa tarefa não está rodando agora.':'Nenhum agente rodando agora.');
      if(it.quiet){ if(it.id && cmdIsRun(cmdTask(it.id))) try{ await stopTask(it.id); }catch(_){ } return true; }
      if(!await cmdStopTasks(alvo, it.sem)){ ms.push({ r:'sys', text:'cancelado — nada foi parado' }); cmdPaint(true); } return true; }
    case 'fila': case 'issue': { cmdPaint(true); await cmdIssuesEnsure();
      // "EAN-13", "UTF-8"… parecem código mas não são issue: sem pedido de começar e sem achar no painel, é pergunta livre
      if(it.k==='issue' && !it.go && !cmdIssue(it.code) && !cmdIssueTask(it.code)) return false;
      ms.push(it.k==='fila'?{ r:'bot', k:'fila' }:(it.link && cmdIssue(it.code) && !cmdIssueTask(it.code))?{ r:'bot', k:'isslink', code:it.code }:{ r:'bot', k:'issue', code:it.code }); cmdPaint(true); return true; }
  }
  return false;
}
// as tarefas que a IA pode citar, cada uma com um identificador estável (o código, ou T1, T2… quando não tem)
function cmdRefs(){ let n=0; const home=cmdRepo(); return cmdTasks().map(t=>{ const code=cmdCode(t); return { id:t.id, ref:code||('T'+(++n)), code, title:mdTitle(t.title||''), st:stLabel(taskSt(t)),
  proj:(t.repo&&t.repo!==home)?pathBase(t.repo):'', repo:t.repo||home, criada:cmdDia(t.createdAt||t.created_at), mexida:cmdHa(t.updatedAt), foco:t.id===CMD.sel, q:(!t._cross&&cmdIsAsk(t))?cmdAskTitle(t):'', fatos:cmdFatosCurtos(t) }; }); }
function cmdFatosCurtos(t){ if(t._cross || !cmdTask(t.id)) return ''; const out=[]; try{ if(typeof reqProofCache!=='undefined' && reqProofCache[t.id]!==undefined){ const rq=cmdReqs(t); if(rq.length) out.push(`${rq.filter(r=>r.ok).length} de ${rq.length} requisitos com prova`); } else if(typeof apEnsure==='function') apEnsure(t); }catch(_){ } out.push(t.prUrl?'PR aberto':'sem PR'); return out.join(', '); }
function cmdConversa(tudo){ return cmdMsgs().slice(-9, tudo?undefined:-1).map(m=>m.r==='you'?'Pessoa: '+cmdUma(m.text):m.r==='sys'?'':(m.k==='md'||m.k==='txt')?'Comando: '+cmdUma(m.text)
  :m.k==='plano'?'Comando propôs: '+(m.plan.passos||[]).map(p=>p.acao+(p.tarefas.length?' '+p.tarefas.join(', '):'')).join(' → ')+(m.done==='sim'?' (feito)':m.done==='nao'?' (a pessoa disse que não era isso)':'')
  :m.k==='pergunta'&&m.text?'Agente da tarefa respondeu: '+cmdUma(m.text):m.k==='aviso'?'':'[Comando mostrou: '+m.k+(m.id&&cmdTaskAny(m.id)?' de '+(cmdCode(cmdTaskAny(m.id))||''):'')+']').filter(Boolean); }
async function cmdProjeto(repo){ if(!repo || repo===cmdRepo()) return true; if(!window.switchProject) return false; try{ await window.switchProject(repo); }catch(_){ return false; } return cmdRepo()===repo; }
function cmdPlanoHtml(m){ const P=m.plan, i=cmdMsgs().indexOf(m);
  const linha=(p, n)=>{ const ts=(p.alvos||[]).map(x=>`<b>${esc(x.code||x.ref)}</b> ${esc(x.title.length>46?x.title.slice(0,45)+'…':x.title)}${x.proj?` <span class="cmdhint">(${esc(x.proj)})</span>`:''}`);
    const falta=(p.faltam||[]).length?`<span class="cmdplan-x">não achei: ${esc(p.faltam.join(', '))}</span>`:'';
    return `<li><span class="cmdplan-a${CMD_MUTA.has(p.acao)?' m':''}">${esc(CMD_ACAO_TX[p.acao]||p.acao)}${p.alvo?' '+esc(p.alvo):''}${p.acao==='epico_acao'&&p.texto?': '+esc(p.texto):''}</span>${ts.length?`<div class="cmdplan-t">${ts.join('<br>')}</div>`:''}${(p.acao==='instruir'||p.acao==='perguntar_agente'||p.acao==='ler_codigo')&&p.texto?`<div class="cmdins"><p>${esc(p.texto)}</p></div>`:''}${falta}</li>`; };
  const pe=m.done==='sim'?'<span class="cmdhint">feito</span>':m.done==='run'?'<span class="cmdhint"><span class="pltyping"><i></i><i></i><i></i></span> fazendo…</span>':m.done==='nao'?'<span class="cmdhint">não fiz — me diga o que mudar</span>'
    :`<button type="button" class="btn sm primary" data-cmdplano="${i}" data-ok="1">Sim, fazer${P.passos.length>1?' tudo':''}</button><button type="button" class="btn sm quiet" data-cmdplano="${i}" data-ok="">Não é isso</button>`;
  return `<div class="cmdqa${m.done?'':' wait'}"><div class="cmdqa-h"><span class="cmdqa-who"><b>Entendi assim — confirma?</b></span></div><ol class="cmdplan">${P.passos.map(linha).join('')}</ol><div class="cmdiss-a">${pe}</div></div>`; }
/** Executa o plano, passo a passo, tarefa a tarefa (trocando de projeto quando a tarefa é de outro; volta no fim). */
async function cmdRunPlan(P){
  const ms=cmdMsgs(), home=cmdRepo(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  const MAP={ status:'status', abertas:'status', esperando:'espera', erros:'erro', fila_issues:'fila', epicos:'epicos', tarefa:'tarefa', porque:'porque', feito:'feito', provas:'provas', link:'link', abrir:'abrir', continuar:'continuar', encerrar:'encerrar', instruir:'instruir' };
  for(const p of P.passos){
    try{
      if(p.acao==='tela'){ const tl=CMD_TELAS.find(x=>cmdNorm(p.alvo).includes(x[0])); if(tl) cmdTela(tl[1]); else say('Não conheço a tela “'+p.alvo+'”.'); continue; }
      if(p.acao==='ler_codigo'){ await cmdCodigo(p.texto||P.pedido||''); continue; }
      if(p.acao==='comecar_issue'){ await cmdIssuesEnsure(); const c=String(p.alvo||p.tarefas[0]||'').toUpperCase().replace(/\s+/g,'-'); if(cmdIssue(c)) await cmdStartIssue(c); else say('Não achei a issue '+c+' no painel.'); continue; }
      if(p.acao==='epico' || p.acao==='epico_acao'){ const E=cmdEpics(), e=E.find(x=>cmdNorm(x.name)===cmdNorm(p.alvo))||E.find(x=>cmdNorm(x.name).includes(cmdNorm(p.alvo))&&p.alvo.length>=3);
        if(!e){ say('Não achei o épico “'+p.alvo+'”.'); continue; }
        const act=p.acao==='epico_acao'?({ comecar:'start', liberar:'liberar', verificar:'verificar', entregar:'entregar' })[cmdNorm(p.texto)]:''; await cmdDo(act?{ k:'epico', id:e.id, act, sem:true }:{ k:'epico', id:e.id }); continue; }
      if(p.acao==='parar' && (!p.alvos.length) && p.tarefas.some(x=>/todas|tudo/i.test(x))){ await cmdDo({ k:'parar', sem:true }); continue; }
      if(!p.alvos || !p.alvos.length){ if(MAP[p.acao] && !['tarefa','porque','feito','provas','link','abrir','continuar','encerrar','instruir'].includes(p.acao)) await cmdDo({ k:MAP[p.acao] }); else if(p.acao==='provas') await cmdDo({ k:'provas' }); continue; }
      const LOTE={ encerrar:'Encerradas sem entregar', continuar:'Mandadas continuar', instruir:'Instrução enviada', parar:'Paradas', ambiente_desligar:'Ambientes desligados' };
      const res=LOTE[p.acao]?{ r:'bot', k:'resultado', titulo:LOTE[p.acao], itens:[] }:null; if(res){ ms.push(res); cmdPaint(true); }
      for(const x of p.alvos){
        const tit=x.title.length>52?x.title.slice(0,51)+'…':x.title;
        if(!await cmdProjeto(x.repo) || !cmdTask(x.id)){ if(res){ res.itens.push({ code:x.code||x.ref, title:tit, ok:false, nota:'não consegui abrir o projeto dela' }); cmdPaint(true); } else say(`Não consegui abrir o projeto da ${x.code||x.ref} pra agir nela.`); continue; }
        if(res){ const it={ quiet:true, id:x.id, k:p.acao==='ambiente_desligar'?'ambiente':p.acao, on:false, sem:true, motivo:'', text:p.texto };
          const estava=p.acao==='parar'?cmdIsRun(cmdTask(x.id)):true; await cmdDo(it);
          const ok=p.acao==='encerrar'?!!it.ok:p.acao==='parar'?estava:!/^(N[aã]o|Essa|A instru)/.test(String(it.out||''));
          res.itens.push({ code:x.code||x.ref, title:tit, ok, nota:ok?'':(p.acao==='parar'&&!estava?'não estava rodando':String(it.out||'').replace(/\.$/,'')) }); cmdPaint(true); continue; }
        if(p.acao==='perguntar_agente') await cmdConferir(x.id, p.texto);
        else if(p.acao==='parar') await cmdDo({ k:'parar', id:x.id, sem:true });
        else if(p.acao==='ambiente_subir') await cmdDo({ k:'ambiente', id:x.id, on:true });
        else if(p.acao==='ambiente_desligar') await cmdDo({ k:'ambiente', id:x.id, on:false });
        else if(p.acao==='encerrar') await cmdDo({ k:'encerrar', id:x.id, motivo:'' });
        else if(p.acao==='instruir') await cmdDo({ k:'instruir', id:x.id, text:p.texto });
        else if(MAP[p.acao]) await cmdDo({ k:MAP[p.acao], id:x.id });
      }
    }catch(e){ console.error('comando plano', e); say('Um passo falhou: '+String((e&&e.message)||e).slice(0,160)); }
  }
  if(cmdRepo()!==home) await cmdProjeto(home);
  cmdPaint(true);
}
/** ENTENDER: a IA lê o estado inteiro e devolve o plano; ler roda direto, o que mexe em algo espera o "Sim, fazer". */
async function cmdPlanejar(text, o){
  const ms=cmdMsgs(); CMD.busy=true; CMD.stopping=false; cmdPaint(true);
  let P=null, raw='';
  try{
    { const ft=CMD.sel?cmdTask(CMD.sel):null; if(ft && typeof reqProofCache!=='undefined' && reqProofCache[ft.id]===undefined && typeof loadReqProofs==='function') try{ await Promise.race([loadReqProofs(ft.id), new Promise(r=>setTimeout(r, 2500))]); }catch(_){ } } // os fatos da tarefa em foco, de verdade
    const refs=cmdRefs(); let foco=''; { const ft=CMD.sel?cmdTask(CMD.sel):null; if(ft){ if(!cmdHistReady(ft.id)) await cmdHistFetch(ft.id); try{ foco=cmdTaskContext(ft); }catch(_){ } } }
    raw=await invoke('comando_plan',{ prompt:cmdPlanPrompt({ proj:pathBase(cmdRepo()), refs, epics:cmdEpics().map(e=>{ const c=cmdEpicStat(e.id); return { name:e.name, done:c.done, total:c.total }; }), foco, conversa:cmdConversa(!!(o&&o.interno)), pedido:(o&&o.interno)||text }) });
    P=cmdPlanParse(raw);
    if(P && o && o.semPerguntar) P.passos=P.passos.filter(p=>p.acao!=='perguntar_agente');
    if(P){ P.pedido=text; P.refs=refs.map(r=>({ ref:r.ref, code:r.code, title:r.title })); P.passos.forEach(p=>{ p.alvos=[]; p.faltam=[]; if(['comecar_issue','epico','epico_acao','tela','ler_codigo'].includes(p.acao)) return;
      p.tarefas.forEach(q=>{ if(/^(todas|tudo)$/i.test(q)) return; const r=cmdRefTask(q, refs); if(r && !p.alvos.some(a=>a.id===r.id)) p.alvos.push(r); else if(!r) p.faltam.push(q); }); }); }
  }catch(e){ const msg=String((e&&e.message)||e||''); const h=humanErr(msg); ms.push({ r:'sys', text:'Não consegui entender agora: '+(h&&h.msg?h.msg:msg.slice(0,240)) }); if(h&&h.action) showErr(e); CMD.busy=false; return cmdPaint(true); }
  CMD.busy=false;
  if(!P){ ms.push({ r:'bot', k:'md', text:String(raw||'').trim()||'Não entendi. Pode dizer de outro jeito?' }); return cmdPaint(true); }
  if(P.fala) ms.push({ r:'bot', k:'md', text:cmdSemRefs(P.fala, P.refs) });
  if(P.duvida) ms.push({ r:'bot', k:'md', text:cmdSemRefs(P.duvida, P.refs) });
  const uteis=P.passos.filter(p=>!(['tarefa','porque','feito','provas','link','abrir','continuar','encerrar','instruir','perguntar_agente','ambiente_subir','ambiente_desligar'].includes(p.acao) && !p.alvos.length && p.acao!=='provas'));
  const semAlvo=P.passos.filter(p=>p.faltam&&p.faltam.length);
  if(semAlvo.length && !P.duvida) ms.push({ r:'bot', k:'txt', text:'Não achei estas tarefas: '+semAlvo.flatMap(p=>p.faltam).join(', ')+'. Me diga o código ou parte do título.' });
  P.passos=uteis;
  if(!P.passos.length){ if(!P.fala && !P.duvida && !semAlvo.length) ms.push({ r:'bot', k:'txt', text:'Não entendi o que fazer. Pode dizer de outro jeito?' }); return cmdPaint(true); }
  if(P.passos.some(p=>CMD_MUTA.has(p.acao))){ ms.push({ r:'bot', k:'plano', plan:P }); return cmdPaint(true); } // mexe em algo: mostra o plano e espera o sim
  await cmdRunPlan(P);
}
/** Pergunta que exige LER O CÓDIGO: a IA do chat do projeto (lê os arquivos de verdade), com a tarefa em foco junto. */
async function cmdCodigo(text){
  const ms=cmdMsgs();
  if(typeof pcBusy!=='undefined' && pcBusy){ ms.push({ r:'sys', text:'o Chat do projeto está respondendo outra pergunta — espere terminar' }); return cmdPaint(true); }
  CMD.busy=true; CMD.stopping=false; cmdPaint(true);
  const repo=cmdRepo(), sidKey='cmdsid:'+repo;
  let foco=''; { const ft=CMD.sel?cmdTask(CMD.sel):null; if(ft){ if(!cmdHistReady(ft.id)) await cmdHistFetch(ft.id); try{ foco=cmdTaskContext(ft); }catch(_){ } } }
  try{
    const r=await aiCallResumeSafe((pr,sid)=>invoke('project_chat',{ prompt:pr, sessionId:sid||'', model:aiClaudeModel() }), lsGet(sidKey)||'', (foco?'[TAREFA EM FOCO]\n'+foco+'\n[FIM]\n\n':'')+text+'\n\nResponda em português, curto e direto.', []);
    aiKeepSid(r, x=>lsSet(sidKey, x)); ms.push({ r:'bot', k:'md', text:(r&&r.text)||'(sem resposta)' });
  }catch(e){ const msg=String((e&&e.message)||e||'');
    if(CMD.stopping||/PROJECT_CHAT_STOPPED/.test(msg)) ms.push({ r:'sys', text:'parado' });
    else { const h=humanErr(msg); ms.push({ r:'sys', text:'Não consegui responder: '+(h&&h.msg?h.msg:msg.slice(0,240)) }); if(h&&h.action) showErr(e); } }
  CMD.busy=false; CMD.stopping=false; cmdPaint(true);
}
async function cmdSay(text, soIA){
  text=String(text||'').trim(); if(!text) return; if(CMD.busy){ toast('espere a resposta — ou pare','warn'); return; }
  cmdMsgs().push({ r:'you', text }); cmdPaint(true);
  if(soIA) return cmdCodigo(text);
  // atalho sem IA: só comando curto, direto e de UMA coisa (os botões de sugestão, "encerra a LW-47"…)
  if(cmdDireto(text)){ const it=cmdResolve(text); if(it.k && it.k!=='ia' && await cmdDo(it)) return; }
  return cmdPlanejar(text);
}
function cmdPaint(down){
  const pg=$id('comandoPage'); if(!pg) return; cmdMount();
  const log=$id('cmdLog'), side=$id('cmdSide'); if(!log||!side) return;
  let a='', b='';
  try{ a=cmdLogHtml(); b=cmdSideHtml(); }catch(e){ console.error('comando', e); b=emptyHtml({ icon:'alert', title:'Não consegui montar esta tela', help:String(e&&e.message||e) }); }
  if(CMD.logHtml!==a){ const fim=down || log.scrollHeight-log.scrollTop-log.clientHeight<60; CMD.logHtml=a; log.innerHTML=a; if(fim) log.scrollTop=log.scrollHeight; cmdSpeakNew(log); }
  if(CMD.sideHtml!==b){ const i=$id('cmdInst'), keep=i?{ v:i.value, f:document.activeElement===i, a:i.selectionStart }:null, sc=side.scrollTop;
    CMD.sideHtml=b; side.innerHTML=b; side.scrollTop=sc;
    const n=$id('cmdInst'); if(n && keep){ n.value=keep.v; if(keep.f){ try{ n.focus({ preventScroll:true }); n.setSelectionRange(keep.a, keep.a); }catch(_){ } } } }
  const st=$id('cmdStop'), sd=$id('cmdSend'); if(st) st.style.display=(CMD.busy||(CMD.asking&&CMD.pv))?'':'none'; if(sd) sd.disabled=CMD.busy;
  // a pergunta aberta da tarefa selecionada: a MESMA folha do terminal, encaixada no painel
  const slot=side.querySelector('[data-tlinline]'); if(slot && typeof tlAskPaint==='function'){ const t=cmdTask(slot.dataset.tlinline); if(t) try{ tlAskPaint(t); }catch(e){ console.warn('comando ask', e); } }
}
function cmdOpen(){ cmdMount(); CMD.unread=0; cmdBadge(); CMD.logHtml=''; CMD.sideHtml=''; cmdPaint(true); if(typeof ovShow==='function') ovShow('comandoOverlay'); if(CMD.sel) cmdHistLoad(CMD.sel); setTimeout(()=>{ const q=$id('cmdQ'); if(q) q.focus(); }, 60); }
function cmdAtiva(){ const t=(typeof tabById==='function')?tabById(activeTab):null; return !!(t && t.kind==='comando'); }

// ---------- registro: aba, lateral, atalho ⌘J, repintura a cada refresh ----------
if(typeof VIEW_META!=='undefined'){ VIEW_META.comando={ title:'Comando', icon:(typeof SEM_IC!=='undefined'&&SEM_IC.spark)||'' }; VIEW_OVERLAY.comando='comandoOverlay'; }
if(typeof viewOpen==='function' && !viewOpen.__cmd){ const vo=viewOpen; viewOpen=function(kind){ if(kind==='comando') return cmdOpen(); return vo.apply(this, arguments); }; viewOpen.__cmd=true; }
if(typeof SEM_NAV!=='undefined') SEM_NAV.comando='comandoBtn';
bindClick('comandoBtn', ()=>openTab('comando'));
if(typeof render==='function' && !render.__cmd){ const r0=render; render=function(){ const out=r0.apply(this, arguments); try{ cmdWatch(); cmdWatchOutros(); if(cmdAtiva()){ if(CMD.unread){ CMD.unread=0; cmdBadge(); } if(CMD.sel) cmdHistLoad(CMD.sel); cmdPaint(); } else if(CMDV.on) cmdVoiceToggle(); }catch(e){ console.warn('comando render', e); } return out; }; render.__cmd=true; }
document.addEventListener('keydown', e=>{ if((e.metaKey||e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase()==='j'){ e.preventDefault(); openTab('comando'); } });
window.cmdOpen=cmdOpen;
