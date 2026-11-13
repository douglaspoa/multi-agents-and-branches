// Starfork — 89-comando-poderes: o que o Comando MOSTRA além da lista de agentes.
//  · CONVERSA: a pergunta ao agente vira uma conversa visível (Comando ↔ porta-voz), no chat e ao lado; dá pra continuar
//    a mesma conversa e perguntar a VÁRIAS tarefas de uma vez (um cartão só, uma leitura só no fim).
//  · ARQUIVOS: "mostra os arquivos editados" → a lista no chat e o diff (estilo git) ao lado, arquivo por arquivo.
//  · APROVAR: "o que está pronto pra aprovar?" → os cartões no chat e as PROVAS ao lado (o mesmo proofPanel da tela
//    Para aprovar: aprovar, pedir alteração e desfazer são os dele).
//  · RADAR: "alguém mexe no mesmo arquivo?" → quem mexe em quê, se é o mesmo trecho, as versões lado a lado e a
//    conversa que o Comando conduz entre os porta-vozes pra chegar num combinado (que a pessoa confirma).
// Fontes únicas: task_files / file_diff (os mesmos da Revisão), diffHunks / diffViewHtml (o renderer único do diff),
// apFila / apVm / proofPanel / aprovarTarefa (80-aprovar), comando_portavoz (o porta-voz, só leitura).

// @poderes-puro-inicio (testado em app/tests/comando-poderes.test.mjs)
/** Quem mexe em quê. `L`: [{ id, code, title, files:[{ path, add, del }] }] → { rows, conf, nTar, nArq }.
 *  rows: [{ path, quem:[{ id, code, title, add, del }] }] — primeiro os arquivos com 2+ tarefas (conf), depois o resto. */
function cmdRadarCalc(L){
  const m=new Map(); let nTar=0;
  for(const t of (L||[])){ if(!t || !Array.isArray(t.files)) continue; nTar++;
    for(const f of t.files){ if(!f || !f.path || /^\.cardume\//.test(f.path)) continue; // artefatos da tarefa não são código do projeto
      const r=m.get(f.path)||{ path:f.path, quem:[] }; if(!r.quem.some(q=>q.id===t.id)) r.quem.push({ id:t.id, code:t.code||'', title:t.title||'', add:+f.add||0, del:+f.del||0 }); m.set(f.path, r); } }
  const peso=r=>r.quem.reduce((a,q)=>a+q.add+q.del, 0);
  const rows=[...m.values()].sort((a,b)=>(b.quem.length-a.quem.length) || (peso(b)-peso(a)) || a.path.localeCompare(b.path));
  return { rows, conf:rows.filter(r=>r.quem.length>1), nTar, nArq:rows.length };
}
/** As faixas de linhas DA BASE que um diff toca. `d` = diffHunks(texto) → [[a, b]]. Arquivo novo = o arquivo inteiro. */
function cmdFaixas(d){
  if(!d || !Array.isArray(d.hunks) || !d.hunks.length) return [];
  if(d.isNew) return [[0, Infinity]];
  return d.hunks.map(h=>{ let pos=(h.o||1)-1, a=Infinity, b=-Infinity;
    for(const r of (h.rows||[])){ if(r.t==='ctx'){ pos=r.o; continue; } const p=r.t==='del'?(pos=r.o):pos+0.5; if(p<a) a=p; if(p>b) b=p; }
    return a<=b?[a,b]:null; }).filter(Boolean);
}
/** Dois diffs do MESMO arquivo batem no mesmo trecho? (com folga de linhas: o git conflita em vizinhança colada) */
function cmdTrechoBate(da, db, folga){
  const A=cmdFaixas(da), B=cmdFaixas(db), g=folga==null?2:folga;
  return A.some(x=>B.some(y=>x[0]-g<=y[1] && y[0]-g<=x[1]));
}
/** A situação de um arquivo do radar, em palavras. `tr`: 'mesmo' | 'diferente' | '' (ainda conferindo) */
function cmdRadarSit(n, tr){ return n<2?{ k:'so', tx:'só uma tarefa' }:tr==='mesmo'?{ k:'hot', tx:'conflito provável: mesmo trecho' }:tr==='diferente'?{ k:'ok', tx:'trechos diferentes, risco baixo' }:{ k:'chk', tx:'mesmo arquivo — conferindo o trecho' }; }
/** O que o Comando pergunta a cada porta-voz na conversa sobre um arquivo em comum. `i` = a vez (0 = o primeiro). */
function cmdMediarPergunta(path, eu, outros, i, antes){
  const quem=outros.map(o=>o.code||('“'+o.title+'”')).join(' e ');
  if(!i) return `A ${quem} também alterou ${path}. O que a sua tarefa mudou nesse arquivo e por quê? As mudanças batem no mesmo trecho? Diga, em até 6 linhas, como as duas podem conviver: qual versão fica, ou como juntar.`;
  return `A ${quem} também alterou ${path}. O porta-voz dela disse: «${String(antes||'').replace(/```[a-z]*/g,' ').replace(/[*_`#>]/g,'').replace(/\s+/g,' ').trim().slice(0,900)}». Você concorda? Diga, em até 6 linhas, o que a sua tarefa precisa manter nesse arquivo e como fica o trecho combinado.`;
}
/** O pedido que o Comando lê no fim de uma conversa em grupo, pra dizer a conclusão e propor os passos. */
function cmdGrupoLeitura(m){
  const R=(m.partes||[]).map(p=>`- ${p.code||p.title}: ${p.text?'«'+String(p.text).slice(0,1400)+'»':'(sem resposta)'}`).join('\n');
  if(m.modo==='mediar') return `Você conduziu uma conversa entre os porta-vozes das tarefas que alteraram o mesmo arquivo (${m.path}):\n${R}\nEm "fala", diga em até 2 frases o COMBINADO (qual versão fica ou como juntar). Depois proponha os passos "instruir", um por tarefa, com o texto específico do que cada agente deve fazer nesse arquivo pra chegar no combinado. Se as respostas não fecham um acordo, diga em "duvida" o que a pessoa precisa decidir. Não use perguntar_agente.`;
  return `Você perguntou a ${(m.partes||[]).length} tarefas: «${m.q}». As respostas dos porta-vozes:\n${R}\nEm "fala", consolide em até 3 frases, citando cada tarefa pelo código. Se alguma precisar de ação do executor, proponha o passo "instruir" dela com um texto específico. Não use perguntar_agente.`;
}
// @poderes-puro-fim

// ============================================================ CONVERSA (os dois falando)
function cmdTurnoHora(ts){ return ts?cmdHora(ts):''; }
/** Os turnos de uma conversa: Comando (pergunta) e agente (resposta, em tinta de terminal). `vivo` = quem está respondendo agora. */
function cmdTurnosHtml(m, o){
  o=o||{}; const turns=(m.turns&&m.turns.length)?m.turns:(m.q?[{ w:'cmd', tx:m.q, ts:m.t0 }]:[]);
  const um=(x)=>{
    if(x.w==='cmd') return `<div class="cmdturn c"><span class="cmdturn-i">${IC.starfork||''}</span><div class="cmdturn-b"><span class="cmdturn-w"><b>Comando</b>${x.para?` <span class="cmdturn-p">→ ${esc(x.para)}</span>`:''}</span><p>${esc(x.tx||'')}</p></div><time>${cmdTurnoHora(x.ts)}</time></div>`;
    if(x.w==='x') return `<div class="cmdturn x"><span class="cmdturn-i">!</span><div class="cmdturn-b"><span class="cmdturn-w"><b>${esc(x.de||'agente')}</b></span><p>${esc(x.tx||'sem resposta')}</p></div><time>${cmdTurnoHora(x.ts)}</time></div>`;
    const tx=String(x.tx||''), corta=o.curto && tx.length>700;
    return `<div class="cmdturn a"><span class="cmdturn-i">›</span><div class="cmdturn-b"><span class="cmdturn-w"><b>${esc(x.de||'porta-voz')}</b></span><div class="cmdmd">${mdToHtml(corta?tx.slice(0,700)+'…':tx)}</div></div><time>${cmdTurnoHora(x.ts)}</time></div>`; };
  const v=o.vivo, acts=(v&&v.acts)||[];
  const vivo=v?`<div class="cmdturn a live"><span class="cmdturn-i">›</span><div class="cmdturn-b"><span class="cmdturn-w"><b>${esc(v.de||'porta-voz')}</b> <span class="pltyping"><i></i><i></i><i></i></span></span>${acts.length?`<div class="cmdacts-l">${acts.slice(-3).map(a=>`<span>${esc(cmdUma(a))}</span>`).join('')}</div>`:`<p class="cmdturn-d">${esc(v.dica||'lendo a sessão do executor e o código da branch')}</p>`}</div><time>${cmdDur(Date.now()-(v.t0||Date.now()))}</time></div>`:'';
  return `<div class="cmdturns">${turns.map(um).join('')}${vivo}</div>`;
}
// a última conversa com o agente desta tarefa (a do cartão do chat): aparece também ao lado, e dá pra continuar dali
function cmdThreadDe(id){ const ms=cmdMsgs(); for(let i=ms.length-1;i>=0;i--){ const m=ms[i]; if(m && m.k==='pergunta' && m.id===id) return m; } return null; }
/** INSTRUÇÃO ao executor: a conversa abre no chat e acompanha o terminal dele — o que está fazendo agora e cada fala,
 *  até o turno acabar ou ele perguntar algo. Não trava o Comando (dá pra seguir conversando) e não gasta IA. */
async function cmdAcompanhar(id, texto, antes){
  const t=cmdTask(id); if(!t) return;
  const ms=cmdMsgs(), m={ r:'bot', k:'pergunta', modo:'instruir', id, q:texto, state:'wait', t0:Date.now(), t1:0, text:'', agora:'', fim:'', acts:[], turns:[{ w:'cmd', tx:texto, ts:Date.now() }] };
  CMD.view=''; ms.push(m); cmdPaint(true);
  let visto=-1, parado=0, nSay=0, perguntou=false; const falas=[];
  while(Date.now()-m.t0<1500000 && cmdMsgs().includes(m)){
    await new Promise(r=>setTimeout(r, 3000));
    const it=await cmdHistFetch(id), novo=it.slice(antes||0).filter(x=>x && x.k!=='you'), says=novo.filter(x=>x.k==='say' && cmdFalaUtil(x.text));
    for(const s of says.slice(nSay)){ m.turns.push({ w:'ag', de:'executor', tx:String(s.text), ts:s.ts||Date.now() }); falas.push(String(s.text)); } nSay=says.length;
    const ult=cmdPath(novo.filter(x=>x.k!=='say'), 1)[0], agora=ult?ult.v+' '+ult.tx:''; if(agora && m.acts[m.acts.length-1]!==agora){ m.acts.push(agora); if(m.acts.length>4) m.acts.shift(); }
    const cur=cmdTask(id); if(!cur) break;
    if(it.length===visto) parado++; else { parado=0; visto=it.length; }
    if(cmdIsAsk(cur) && novo.length){ perguntou=true; break; } // a pergunta entra logo abaixo, no aviso (um lugar só)
    if(!cmdIsRun(cur) && parado>=2 && (novo.length || Date.now()-m.t0>45000)) break;
    m.t1=Date.now(); if(cmdAtiva()) cmdPaint();
  }
  const cur=cmdTask(id), roda=!!(cur && cmdIsRun(cur)); m.t1=Date.now(); m.text=falas.join('\n\n');
  m.state=(falas.length||perguntou)?'ok':'timeout';
  m.fim=perguntou?'parou pra perguntar (veja abaixo) · '+cmdDur(m.t1-m.t0):roda?'segue trabalhando · '+cmdDur(m.t1-m.t0):falas.length?'terminou em '+cmdDur(m.t1-m.t0):'sem fala em '+cmdDur(m.t1-m.t0);
  if(perguntou) try{ cmdWatch(); }catch(_){ }
  if(cmdMsgs().includes(m)){ cmdPaint(true); if(m.text && CMDV.on) cmdSpeak(cmdFrase1(falas[falas.length-1])); }
}
/** O porta-voz de UMA tarefa responde UMA pergunta (só leitura). `alvo` recebe o andamento (agora/acts). → { text, erro, parado } */
async function cmdPvCore(id, texto, alvo, extra){
  const t=cmdTask(id); if(!t) return { text:'', erro:'essa tarefa não está nesta máquina' };
  try{ await cmdHistFetch(id); }catch(_){ }
  const mem=cmdPvMem(id), pr=`[O QUE O APP SABE AGORA${t.base?' · base: '+t.base:''}]\n${cmdTaskContext(t)}\n[FIM]\n${extra?'\n'+extra+'\n':''}${mem.length?'\n[O QUE VOCÊ JÁ RESPONDEU SOBRE ESTA TAREFA]\n'+mem.map(x=>'P: '+x.q+'\nR: '+x.a).join('\n')+'\n[FIM]\n':''}\nPERGUNTA DE QUEM COORDENA: ${texto}`;
  CMD.asking=id; CMD.pv=alvo;
  try{ const r=await invoke('comando_portavoz',{ taskId:id, prompt:pr, sessionId:'', model:'claude-sonnet-5' }); const tx=String((r&&r.text)||'').trim();
    if(!cmdFalaUtil(tx)) return { text:'', erro:'o porta-voz não devolveu uma resposta' };
    mem.push({ q:texto, a:tx.slice(0,900) }); lsSet(cmdPvKey(id), JSON.stringify(mem.slice(-3))); return { text:tx, erro:'' };
  }catch(e){ const msg=String((e&&e.message)||e||''), parado=/PORTAVOZ_STOPPED/.test(msg); return { text:'', parado, erro:parado?'parado':((humanErr(msg)||{}).msg||msg.slice(0,200)) }; }
  finally{ CMD.asking=''; CMD.pv=null; }
}
/** CONVERSA EM GRUPO: o Comando fala com o porta-voz de cada tarefa, um por vez, num cartão só — e lê tudo no fim.
 *  modo 'varios' = a mesma pergunta pra todas · 'mediar' = duas (ou mais) tarefas que alteraram o mesmo arquivo. */
async function cmdGrupo(o){
  const ms=cmdMsgs(), say=(text)=>{ ms.push({ r:'bot', k:'txt', text }); cmdPaint(true); };
  if(CMD.asking) return say('O porta-voz já está respondendo outra pergunta.');
  const partes=(o.alvos||[]).map(x=>{ const t=cmdTask(x.id); return t?{ id:t.id, code:cmdCode(t)||x.code||'', title:mdTitle(t.title||''), state:'fila', text:'', erro:'', agora:'', acts:[], t0:0, t1:0 }:null; }).filter(Boolean);
  if(partes.length<2){ if(partes.length===1 && o.modo!=='mediar') return cmdConferir(partes[0].id, o.texto); return say(o.modo==='mediar'?'Pra combinar, as duas tarefas precisam estar nesta máquina.':'Não achei essas tarefas nesta máquina.'); }
  const m={ r:'bot', k:'grupo', modo:o.modo||'varios', q:String(o.texto||'').replace(/\s+/g,' ').trim()||'Como esta tarefa está de verdade agora?', path:o.path||'', partes, turns:[], state:'wait', t0:Date.now(), t1:0 };
  ms.push(m); cmdPaint(true);
  const tick=setInterval(()=>{ if(cmdAtiva()) cmdPaint(); }, 2000);
  let antes='';
  for(let i=0;i<partes.length;i++){ const p=partes[i], outros=partes.filter(x=>x!==p);
    let texto=m.q, extra='';
    if(m.modo==='mediar'){ texto=cmdMediarPergunta(m.path, p, outros, i, antes);
      const dif=[]; for(const q of outros){ const d=await cmdDifFetch(q.id, m.path); if(typeof d==='string' && d.trim()) dif.push(`${q.code||q.title} — diff dela em ${m.path}:\n${d.slice(0,3500)}`); }
      if(dif.length) extra=`[OUTRA TAREFA MEXENDO NO MESMO ARQUIVO]\n${dif.join('\n\n')}\n[FIM]`; }
    p.state='wait'; p.t0=Date.now(); m.turns.push({ w:'cmd', para:p.code||p.title, tx:texto, ts:Date.now() }); cmdPaint(true);
    const r=await cmdPvCore(p.id, texto, p, extra);
    p.t1=Date.now(); p.text=r.text; p.erro=r.erro; p.state=r.text?'ok':'timeout';
    m.turns.push(r.text?{ w:'ag', de:'porta-voz · '+(p.code||p.title), tx:r.text, ts:Date.now() }:{ w:'x', de:'porta-voz · '+(p.code||p.title), tx:r.erro||'sem resposta', ts:Date.now() });
    if(r.text) antes=r.text; cmdPaint(true);
    if(r.parado){ partes.slice(i+1).forEach(x=>{ x.state='timeout'; x.erro='não perguntei: você parou a conversa'; }); break; }
  }
  clearInterval(tick); m.state='ok'; m.t1=Date.now(); cmdPaint(true);
  if(partes.some(p=>p.text)) await cmdPlanejar('', { interno:cmdGrupoLeitura(m), semPerguntar:true });
}
function cmdGrupoHtml(m){
  const ok=m.partes.filter(p=>p.state==='ok').length, n=m.partes.length, vivoP=m.partes.find(p=>p.state==='wait'), med=m.modo==='mediar';
  const st=m.state==='wait'?`<span class="cmdqa-st wait"><span class="pltyping"><i></i><i></i><i></i></span>${ok} de ${n} responderam · ${cmdDur(Date.now()-m.t0)}</span>`:`<span class="cmdqa-st ${ok===n?'ok':'to'}">${ok} de ${n} responderam em ${cmdDur((m.t1||Date.now())-m.t0)}</span>`;
  const quem=`<div class="cmdgrp">${m.partes.map(p=>`<button type="button" class="cmdgrp-p ${p.state}" data-cmdsel="${escA(p.id)}" title="${escA(p.title)}"><i></i><span class="cmdcode">${esc(p.code||p.title.slice(0,18))}</span><small>${p.state==='ok'?'respondeu':p.state==='wait'?'respondendo':p.state==='fila'?'na fila':'sem resposta'}</small></button>`).join('')}</div>`;
  const vivo=vivoP?{ de:'porta-voz · '+(vivoP.code||vivoP.title), acts:vivoP.acts, t0:vivoP.t0 }:null;
  return `<div class="cmdqa ${m.state==='wait'?'wait':ok===n?'ok':'to'}"><div class="cmdqa-h"><span class="cmdqa-who">${IC.stAsk||''}<b>${med?'Conversa entre agentes':'Pergunta a '+n+' agentes'}</b>${med?' · <span class="mono">'+esc(m.path)+'</span>':''}</span>${st}</div>${quem}${cmdTurnosHtml(m, { vivo, curto:true })}</div>`;
}

// ============================================================ ARQUIVOS (estilo git)
function cmdArq(id){ return (CMD.arq||(CMD.arq={}))[id]||null; }
function cmdDifKey(id, path){ return id+'\u0000'+path; }
function cmdDif(id, path){ return (CMD.dif||(CMD.dif={}))[cmdDifKey(id, path)]; }
/** O diff de um arquivo da tarefa (o mesmo file_diff da Revisão). string = texto · { err } = falhou */
function cmdDifFetch(id, path){
  const k=cmdDifKey(id, path), c=cmdDif(id, path); if(c && typeof c.then==='function') return c; if(c!==undefined && c!==null) return Promise.resolve(c);
  const p=invoke('file_diff',{ taskId:id, path }).then(d=>(CMD.dif[k]=String(d||''))).catch(e=>(CMD.dif[k]={ err:String((e&&e.message)||e||'').slice(0,200) })).then(v=>{ if(cmdAtiva()) cmdPaint(); return v; });
  CMD.dif[k]=p; return p;
}
async function cmdArqLoad(id, forca){
  const a=cmdArq(id); if(a && a.loading) return a; if(a && !forca && Date.now()-a.at<8000) return a;
  const cur=CMD.arq[id]=a||{ files:null, at:0, loading:false, err:'' }; cur.loading=true;
  try{ const f=await invoke('task_files',{ taskId:id }); const antes=JSON.stringify(cur.files||[]); cur.files=(Array.isArray(f)?f:[]).map(x=>({ path:String(x.path||''), add:+x.add||0, del:+x.del||0 })).filter(x=>x.path); cur.err='';
    if(antes!==JSON.stringify(cur.files)) Object.keys(CMD.dif||{}).forEach(k=>{ if(k.startsWith(id+'\u0000')) delete CMD.dif[k]; }); // o arquivo mudou: o diff guardado não vale mais
  }catch(e){ cur.err=String((e&&e.message)||e||'').slice(0,200); if(!cur.files) cur.files=[]; }
  cur.loading=false; cur.at=Date.now(); return cur;
}
async function cmdArquivos(id){
  const t=cmdTask(id), ms=cmdMsgs(); if(!t){ ms.push({ r:'bot', k:'txt', text:'Essa tarefa não está nesta máquina.' }); cmdPaint(true); return true; }
  CMD.sel=id; CMD.view='diff'; CMD.dpath=''; ms.push({ r:'bot', k:'arquivos', id }); cmdPaint(true);
  const a=await cmdArqLoad(id, true); if(CMD.sel===id && !CMD.dpath && a.files.length){ CMD.dpath=a.files[0].path; cmdDifFetch(id, CMD.dpath); } else if(!a.files.length && CMD.view==='diff') CMD.view='';
  cmdPaint(true); return true;
}
function cmdArquivosHtml(m){
  const t=cmdTask(m.id); if(!t) return '<p>Essa tarefa não está nesta máquina.</p>';
  const a=cmdArq(t.id), id=escA(t.id), nome=esc(cmdCode(t)||mdTitle(t.title||'').slice(0,40));
  if(!a || !a.files) return `<p class="cmdhint">lendo o que a ${nome} alterou…</p>`;
  if(a.err && !a.files.length) return `<p>Não consegui ler os arquivos da <b>${nome}</b>: ${esc(a.err)}</p>`;
  if(!a.files.length) return `<p>A <b>${nome}</b> ainda não alterou nenhum arquivo em relação à base.</p>`;
  const add=a.files.reduce((s,f)=>s+f.add,0), del=a.files.reduce((s,f)=>s+f.del,0), MAX=14, sel=CMD.sel===t.id && CMD.view==='diff'?CMD.dpath:'';
  return `<div class="cmdqa"><div class="cmdqa-h"><span class="cmdqa-who"><b>Arquivos editados</b> · ${nome}${t.branch?` <span class="mono cmdhint">${esc(t.branch)}</span>`:''}</span><span class="cmdqa-st"><span class="cmdadd">+${add}</span> <span class="cmddel">−${del}</span> · ${nPl(a.files.length,'arquivo','arquivos')}</span></div>`
    +`<div class="cmdarqs">${a.files.slice(0,MAX).map(f=>`<button type="button" class="cmdarq${sel===f.path?' on':''}" data-cmdx="arq" data-id="${id}" data-path="${escA(f.path)}"><span class="f">${esc(f.path)}</span><span class="cmdadd">+${f.add}</span><span class="cmddel">−${f.del}</span></button>`).join('')}</div>`
    +`${a.files.length>MAX?`<div class="cmdqa-w">e mais ${a.files.length-MAX} — todos ficam no painel ao lado</div>`:''}<div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdx="arq" data-id="${id}" data-path="${escA(sel||a.files[0].path)}">Ver o diff ao lado</button><button type="button" class="btn sm quiet" data-cmddo="provas" data-id="${id}">Provas</button><button type="button" class="btn sm quiet" data-cmdopen="${id}">Abrir a tarefa</button></div></div>`;
}
function cmdDifBody(id, path, max){
  const d=cmdDif(id, path);
  if(d===undefined){ cmdDifFetch(id, path); return '<p class="cmdmuted">lendo o diff…</p>'; }
  if(d && typeof d.then==='function') return '<p class="cmdmuted">lendo o diff…</p>';
  if(d && d.err) return `<p class="cmdmuted">Não consegui ler o diff deste arquivo: ${esc(d.err)}</p>`;
  if(!String(d||'').trim()) return '<p class="cmdmuted">Sem diferença em relação à base (ou é um arquivo binário).</p>';
  let h=''; try{ h=diffViewHtml(diffHunks(d), {}); }catch(e){ return `<pre class="cmddiff-raw">${esc(String(d).slice(0,20000))}</pre>`; }
  return `<div class="cmddiff"${max?` style="max-height:${max}px"`:''}>${h}</div>`;
}
function cmdDiffSideHtml(t){
  const a=cmdArq(t.id), fs=(a&&a.files)||[], i=Math.max(0, fs.findIndex(f=>f.path===CMD.dpath)), f=fs[i], id=escA(t.id);
  const volta=`<button type="button" class="cmdback" data-cmdx="view" data-v="">${semIc('arrowR','rev')}fechar</button>`;
  if(!f) return `${volta}<p class="cmdmuted">${a&&a.loading?'lendo os arquivos…':'Nenhum arquivo alterado.'}</p>`;
  return `${volta}<div class="cmdside-h"><span class="cmdeye">Arquivo ${i+1} de ${fs.length} · ${esc(cmdCode(t)||mdTitle(t.title||'').slice(0,30))}</span><h2 class="cmdpath">${esc(f.path)}</h2>
      <div class="cmdacts"><span class="cmdpill mono"><span class="cmdadd">+${f.add}</span>&nbsp;<span class="cmddel">−${f.del}</span></span>${t.branch?`<span class="cmdpill mono" title="branch">${esc(t.branch)}</span>`:''}<button type="button" class="btn sm" data-cmdx="arqnav" data-d="-1"${i<=0?' disabled':''}>Arquivo anterior</button><button type="button" class="btn sm" data-cmdx="arqnav" data-d="1"${i>=fs.length-1?' disabled':''}>Próximo arquivo</button></div></div>
    ${fs.length>1?`<div class="cmdarqs side">${fs.map(x=>`<button type="button" class="cmdarq${x.path===f.path?' on':''}" data-cmdx="arq" data-id="${id}" data-path="${escA(x.path)}"><span class="f">${esc(x.path)}</span><span class="cmdadd">+${x.add}</span><span class="cmddel">−${x.del}</span></button>`).join('')}</div>`:''}
    ${cmdDifBody(t.id, f.path)}
    <div class="cmdinst"><button type="button" class="btn primary sm" data-cmdpre="${escA('Peça ao executor: no arquivo '+f.path+', ')}" data-id="${id}">Pedir mudança neste arquivo</button><span class="cmdhint">a frase começa na caixa do chat</span></div>`;
}

// ============================================================ APROVAR (cartões no chat, provas ao lado)
function cmdProntas(){
  let L=[]; try{ L=apFila(); }catch(_){ }
  L.forEach(t=>{ try{ apEnsure(t); }catch(_){ } });
  if(L.length){ CMD.sel=L[0].id; CMD.view='provas'; cmdHistLoad(CMD.sel); }
  cmdMsgs().push({ r:'bot', k:'aprovacao' }); cmdPaint(true); return true;
}
function cmdApvCard(t){
  let v; try{ v=apVm(t); }catch(e){ return `<div class="cmdapv"><p class="cmdmuted">Não consegui montar as provas da ${esc(cmdCode(t)||'tarefa')}.</p></div>`; }
  const id=escA(t.id), on=CMD.sel===t.id && CMD.view==='provas';
  const meta=[v.code?`<span class="mono">${esc(v.code)}</span>`:'', t.branch?`<span class="mono">${esc(t.branch)}</span>`:'', v.pr?`<span>PR #${esc(String(v.pr))}</span>`:'<span>sem PR</span>', v.files?`<span><span class="cmdadd">+${v.add}</span> <span class="cmddel">−${v.del}</span> · ${nPl(v.files,'arquivo','arquivos')}</span>`:''].filter(Boolean).join('');
  const chips=(v.chips||[]).map(c=>`<span class="cmdgate ${c.st}">${c.st==='ok'?'✓':c.st==='run'?'•':'✕'} ${esc(c.tx)}</span>`).join(''); // os MESMOS selos do painel de provas
  const pend=(typeof AP!=='undefined'&&AP.pending&&AP.pending.id===t.id), busy=(typeof AP!=='undefined'&&AP.busy[t.id]), feito=(typeof AP!=='undefined'&&AP.ok[t.id])||t.status==='merged';
  const provas=`<button type="button" class="btn sm${on?' quiet':''}" data-cmdx="provas" data-id="${id}">${on?'Provas abertas ao lado':'Ver as provas'}</button>`, diff=`<button type="button" class="btn sm quiet" data-cmddo="arquivos" data-id="${id}">Ver o diff</button>`;
  let pe;
  if(feito) pe=`<span class="cmdstamp ok">Aprovado</span><span class="cmdhint">${esc(v.after||'integrada na main')}</span>`;
  else if(pend) pe=`<span class="cmdstamp ok">Aprovado</span><span class="cmdhint">integrando — dá pra desfazer ao lado por alguns segundos</span>${provas}`;
  else if(busy) pe=`<span class="cmdhint"><span class="pltyping"><i></i><i></i><i></i></span> ${esc(busy.tx||'aprovando…')}</span>${provas}`;
  else if(!v.pode) pe=`<span class="cmdhint">quem aprova: <b>${esc(typeof apWhoName==='function'?apWhoName(v.quem):'outra pessoa')}</b></span><button type="button" class="btn sm" data-cmdx="pedir" data-id="${id}">Pedir alteração</button>${provas}${diff}`;
  else if(v.dec && v.dec.kind==='ok') pe=`<button type="button" class="btn sm primary" data-cmdx="aprovar" data-id="${id}">Aprovar</button><button type="button" class="btn sm" data-cmdx="pedir" data-id="${id}">Pedir alteração</button>${provas}${diff}`;
  else pe=`<button type="button" class="btn sm primary" data-cmdx="provas" data-id="${id}">Ver as provas e decidir</button><button type="button" class="btn sm" data-cmdx="pedir" data-id="${id}">Pedir alteração</button>${diff}<span class="cmdhint">${esc((v.dec&&v.dec.why)||'ainda falta algo pra aprovar direto')}</span>`;
  return `<div class="cmdapv${on?' on':''}"><div class="cmdapv-h"><div class="cmdapv-t">${esc(v.title)}</div>${typeof stBadge==='function'?stBadge(v.st):''}</div><div class="cmdapv-m">${meta}</div>${v.frase?`<div class="cmdapv-s"><span class="cmdeye">O que mudou, em uma frase</span>${esc(v.frase)}</div>`:''}${chips?`<div class="cmdgates">${chips}</div>`:''}<div class="cmdiss-a">${pe}</div></div>`;
}
function cmdProntasHtml(m){
  let L=[]; try{ L=apFila(); }catch(_){ }
  // o que foi aprovado a partir deste cartão continua nele (com o carimbo), mesmo depois de sair da fila
  const vistos=(m.vistos||(m.vistos=[])); L.forEach(t=>{ if(!vistos.includes(t.id)) vistos.push(t.id); });
  const todos=vistos.map(cmdTask).filter(Boolean), abertas=todos.filter(t=>L.includes(t));
  if(!todos.length) return '<p>Nada pronto pra aprovar agora. Eu aviso aqui quando uma tarefa terminar.</p>';
  return `<p>${abertas.length?`<b>${nPl(abertas.length,'tarefa espera','tarefas esperam')}</b> a sua aprovação. As provas ficam ao lado; aprovar tem alguns segundos pra desfazer.`:'Tudo o que estava pronto já foi decidido.'}</p><div class="cmdapvs">${todos.slice(0,6).map(cmdApvCard).join('')}</div>${todos.length>6?`<p class="cmdhint">e mais ${todos.length-6} em Para aprovar</p>`:''}<div class="cmdiss-a"><button type="button" class="btn sm quiet" data-cmdgo="aprovar">Abrir Para aprovar</button></div>`;
}
function cmdProvasSideHtml(t){
  return `<button type="button" class="cmdback" data-cmdx="view" data-v="">${semIc('arrowR','rev')}fechar</button><span class="cmdeye">Provas · ${esc(cmdCode(t)||mdTitle(t.title||'').slice(0,30))}</span><div class="cmdproof cmdproof-side">${typeof proofPanel==='function'?proofPanel(t.id, 'compact'):'<p class="cmdmuted">O painel de provas não está disponível.</p>'}</div>`;
}

// ============================================================ RADAR DE CONFLITO
function cmdRadarTasks(){ return cmdTasks().filter(t=>!t._cross && cmdTask(t.id) && t.worktree); }
async function cmdRadarAbrir(){
  const ms=cmdMsgs(), R=CMD.radar={ at:0, loading:true, rows:[], conf:[], nTar:0, nArq:0, tr:{} };
  CMD.view='radar'; CMD.rpath=''; ms.push({ r:'bot', k:'radar' }); cmdPaint(true);
  const L=cmdRadarTasks(), out=await Promise.all(L.map(t=>cmdArqLoad(t.id, true).then(a=>({ id:t.id, code:cmdCode(t), title:mdTitle(t.title||''), files:a.files||[] })).catch(()=>({ id:t.id, code:cmdCode(t), title:mdTitle(t.title||''), files:[] }))));
  if(CMD.radar!==R) return true; // pediram o radar de novo no meio
  Object.assign(R, cmdRadarCalc(out), { loading:false, at:Date.now() });
  if(R.conf.length) CMD.rpath=R.conf[0].path;
  cmdPaint(true);
  // mesmo arquivo ≠ mesmo trecho: confere as faixas de linhas de cada versão (só dos arquivos em comum)
  for(const r of R.conf.slice(0,8)){ const ds=await Promise.all(r.quem.slice(0,4).map(q=>cmdDifFetch(q.id, r.path)));
    if(CMD.radar!==R) return true; const hs=ds.map(d=>typeof d==='string'?diffHunks(d):null).filter(Boolean); let bate=false;
    for(let i=0;i<hs.length;i++) for(let j=i+1;j<hs.length;j++) if(cmdTrechoBate(hs[i], hs[j])) bate=true;
    R.tr[r.path]=hs.length<2?'diferente':bate?'mesmo':'diferente'; cmdPaint(); }
  const quente=r=>R.tr[r.path]==='mesmo'?0:1; R.conf.sort((a,b)=>quente(a)-quente(b)); R.rows.sort((a,b)=>(b.quem.length>1)-(a.quem.length>1) || quente(a)-quente(b));
  if(!R.escolheu && R.conf.length) CMD.rpath=R.conf[0].path; cmdPaint();
  return true;
}
function cmdRadarHtml(){
  const R=CMD.radar; if(!R || R.loading) return '<p class="cmdhint">lendo o que cada tarefa alterou…</p>';
  if(R.nTar<2) return `<p>${R.nTar?'Só uma tarefa aberta tem código nesta máquina':'Nenhuma tarefa aberta tem código nesta máquina'}: não há com quem conflitar.</p>`;
  if(!R.conf.length) return `<p>Nenhum arquivo está sendo mexido por duas tarefas. Olhei ${nPl(R.nTar,'tarefa','tarefas')} e ${nPl(R.nArq,'arquivo','arquivos')}.</p><div class="cmdiss-a"><button type="button" class="btn sm quiet" data-cmdx="view" data-v="radar">Ver quem mexe em quê</button></div>`;
  const hot=R.conf.filter(r=>R.tr[r.path]==='mesmo').length;
  const card=r=>{ const s=cmdRadarSit(r.quem.length, R.tr[r.path]), p=escA(r.path), run=r.quem.map(q=>cmdTask(q.id)).filter(t=>t&&cmdIsRun(t)), seg=run.length?run[run.length-1]:null;
    return `<div class="cmdqa cmdconf ${s.k}"><div class="cmdqa-h"><span class="cmdqa-who"><b>${s.k==='hot'?'Conflito provável':'Mesmo arquivo'}</b></span><span class="cmdqa-st ${s.k==='hot'?'to':s.k==='ok'?'ok':'wait'}">${esc(s.tx)}</span></div><div class="cmdqa-q mono">${esc(r.path)}</div>`
      +`<div class="cmdres">${r.quem.map(q=>`<div><i>•</i><span class="cmdcode">${esc(q.code)}</span><span class="cmdtt">${esc(q.title)}</span><span class="cmdconf-n"><span class="cmdadd">+${q.add}</span> <span class="cmddel">−${q.del}</span></span></div>`).join('')}</div>`
      +`<div class="cmdiss-a">${s.k==='hot'?`<button type="button" class="btn sm primary" data-cmdx="mediar" data-path="${p}"${CMD.asking?' disabled':''}>Pedir pros agentes combinarem</button><button type="button" class="btn sm" data-cmdx="rpath" data-path="${p}">Ver as versões ao lado</button>`:`<button type="button" class="btn sm" data-cmdx="rpath" data-path="${p}">Ver as versões ao lado</button><button type="button" class="btn sm quiet" data-cmdx="mediar" data-path="${p}"${CMD.asking?' disabled':''}>Pedir pros agentes combinarem</button>`}${seg?`<button type="button" class="btn sm quiet" data-cmdstop="${escA(seg.id)}">Segurar a ${esc(cmdCode(seg)||'tarefa')}</button>`:''}</div></div>`; };
  return `<p><b>${nPl(R.conf.length,'arquivo está sendo mexido','arquivos estão sendo mexidos')}</b> por mais de uma tarefa${hot?` — ${nPl(hot,'no mesmo trecho','no mesmo trecho')}`:''}. Olhei ${nPl(R.nTar,'tarefa','tarefas')}.</p>${R.conf.slice(0,5).map(card).join('')}${R.conf.length>5?`<p class="cmdhint">e mais ${R.conf.length-5} — a lista inteira está ao lado</p>`:''}`;
}
function cmdRadarSideHtml(){
  const R=CMD.radar, proj=pathBase(cmdRepo()), volta=`<button type="button" class="cmdback" data-cmdx="view" data-v="">${semIc('arrowR','rev')}fechar</button>`;
  const cab=`<div class="cmdside-h"><span class="cmdeye">Radar${proj?' · '+esc(proj):''}</span><h2>Quem está mexendo em quê</h2>`;
  if(!R || R.loading) return `${volta}${cab}</div><p class="cmdmuted">lendo o que cada tarefa alterou…</p>`;
  const n=(v,l,cor)=>`<span class="cmdn"><b${cor&&v?` style="color:${cor}"`:''}>${v}</b>${l}</span>`, hot=R.conf.filter(r=>R.tr[r.path]==='mesmo').length;
  const linha=r=>{ const s=cmdRadarSit(r.quem.length, R.tr[r.path]), c=r.quem.length>1;
    return `<${c?'button type="button"':'div'} class="cmdrad-r ${s.k}${c&&CMD.rpath===r.path?' on':''}"${c?` data-cmdx="rpath" data-path="${escA(r.path)}"`:''}><span class="f mono">${esc(r.path)}</span><span class="q">${r.quem.map(q=>`<span class="cmdcode">${esc(q.code||q.title.slice(0,14))}</span>`).join('')}</span><span class="s">${esc(s.tx)}</span></${c?'button':'div'}>`; };
  const sel=R.conf.find(r=>r.path===CMD.rpath), MAX=40;
  const versoes=sel?cmdSec('Mesmo arquivo, '+(sel.quem.length===2?'duas':sel.quem.length)+' versões', `<p class="cmdmuted mono">${esc(sel.path)}</p>`+sel.quem.map(q=>`<div class="cmdver"><div class="cmdver-h"><button type="button" class="cmdchipc" data-cmdsel="${escA(q.id)}">${esc(q.code||'tarefa')}</button><span>${esc(q.title)}</span><span class="cmdconf-n"><span class="cmdadd">+${q.add}</span> <span class="cmddel">−${q.del}</span></span></div>${cmdDifBody(q.id, sel.path, 260)}</div>`).join('')
    +`<div class="cmdiss-a"><button type="button" class="btn sm primary" data-cmdx="mediar" data-path="${escA(sel.path)}"${CMD.asking?' disabled':''}>Pedir pros agentes combinarem</button></div>`):'';
  return `${volta}${cab}<div class="cmdns">${n(R.nTar,'tarefas')}${n(R.nArq,'arquivos')}${n(R.conf.length,'em comum','var(--st-review)')}${n(hot,'no mesmo trecho','var(--st-err)')}</div></div>
    ${R.rows.length?`<div class="cmdrad">${R.rows.slice(0,MAX).map(linha).join('')}</div>${R.rows.length>MAX?`<p class="cmdhint">e mais ${R.rows.length-MAX} arquivos de uma tarefa só</p>`:''}`:'<p class="cmdmuted">Nenhuma tarefa aberta alterou arquivo ainda.</p>'}
    ${versoes}<div class="cmdside-f"><button type="button" class="btn sm quiet" data-cmdx="radar">Atualizar o radar</button></div>`;
}
function cmdMediar(path){
  const R=CMD.radar, r=R&&R.conf.find(x=>x.path===path); if(!r) return;
  CMD.rpath=path; return cmdGrupo({ modo:'mediar', path, alvos:r.quem.slice(0,3).map(q=>({ id:q.id, code:q.code })), texto:'Como as mudanças em '+path+' podem conviver?' });
}

// ============================================================ ligação com o 89-comando (painel ao lado + cliques)
/** O que vai no painel da direita quando há uma visão aberta ('' = a tarefa / todos os agentes, do 89). */
function cmdSideExtra(t){
  const v=CMD.view||'';
  if(v==='radar') return cmdRadarSideHtml();
  if(!t){ if(v) CMD.view=''; return ''; }
  if(v==='diff') return cmdDiffSideHtml(t);
  if(v==='provas') return cmdProvasSideHtml(t);
  return '';
}
function cmdPoder(b){
  const k=b.dataset.cmdx, id=b.dataset.id||'', topo=()=>{ const s=$id('cmdSide'); if(s) s.scrollTop=0; };
  if(k==='view'){ CMD.view=b.dataset.v||''; cmdPaint(); return topo(); }
  if(k==='arq'){ CMD.sel=id; CMD.view='diff'; CMD.dpath=b.dataset.path||''; cmdDifFetch(id, CMD.dpath); if(!cmdArq(id)) cmdArqLoad(id).then(()=>cmdPaint()); cmdPaint(); return topo(); }
  if(k==='arqnav'){ const a=cmdArq(CMD.sel), fs=(a&&a.files)||[], i=fs.findIndex(f=>f.path===CMD.dpath), n=fs[Math.max(0, Math.min(fs.length-1, i+(+b.dataset.d||0)))]; if(n){ CMD.dpath=n.path; cmdDifFetch(CMD.sel, n.path); cmdPaint(); topo(); } return; }
  if(k==='provas'){ CMD.sel=id; CMD.view='provas'; const t=cmdTask(id); if(t){ try{ apEnsure(t); }catch(_){ } cmdHistLoad(id); } cmdPaint(); return topo(); }
  if(k==='pedir'){ CMD.sel=id; CMD.view='provas'; try{ if(typeof apPedirAbrir==='function') apPedirAbrir(id); else { AP.ui[id]={ mode:'ask' }; AP.focus=id; } }catch(_){ } cmdPaint(); return; }
  if(k==='aprovar'){ CMD.sel=id; CMD.view='provas'; cmdPaint(); const fim=()=>{ if(cmdAtiva()) cmdPaint(true); }; const tk=setInterval(fim, 1000);
    return Promise.resolve(aprovarTarefa(id)).catch(e=>{ showErr(e, 'Não consegui aprovar'); return false; }).then(ok=>{ clearInterval(tk); cmdLog({ via:'cartao', pedido:'aprovar', plano:[{ a:'aprovar', t:[cmdCode(cmdTaskAny(id)||{})] }], res:ok?'sim':'nao' }); fim(); }); }
  if(k==='radar') return cmdRadarAbrir();
  if(k==='rpath'){ CMD.view='radar'; CMD.rpath=b.dataset.path||''; if(CMD.radar) CMD.radar.escolheu=true; cmdPaint(); return; }
  if(k==='mediar') return cmdMediar(b.dataset.path||'');
}
