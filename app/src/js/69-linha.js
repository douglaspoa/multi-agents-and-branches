// Starfork — 69-linha: LINHA DO PROJETO (spec-linha-do-projeto; mock _bmad-output/gestor/mock-gestor.html §05)
// A linha do tempo dos épicos em linguagem de negócio: barra na JANELA que uma pessoa definiu, preenchida pelo
// "pronto quando" PROVADO (sem doneWhen: tarefas entregues), saúde posta por uma pessoa com uma frase, custo em
// US$ ≈ R$ e losango quando entregue. Mora em Projeto › Linha (épicos do projeto aberto) e Time › Linha (todos).
// Regras (mesa do gestor, vetos que valem):
//  - nenhuma data calculada nem prevista pelo app: sem janela = "sem data" (só uma pessoa define);
//  - saúde sem avaliação fica NEUTRA (nunca um verde automático); atenção/atrasado exigem a frase;
//  - janela e saúde moram em epics.spec (spec.window / spec.health), gravadas relendo o spec fresco e mesclando
//    só a chave mexida — doneWhen, description e o status do épico nunca são tocados;
//  - quem edita = a mesma regra de marcar o "pronto quando" (epCanCheck: quem criou o épico ou owner/admin);
//  - sem polling novo: pinta com o que o Time já busca (teamFetch/teamEpics/teamTasks), só quando está visível;
//  - nada de branch, PR ou cópia de trabalho na Linha.

if(typeof IC!=='undefined' && !IC.linha) IC.linha='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4.5h6M5 8h7.5M3.5 11.5h5" stroke-linecap="round"/><path d="M13 10.3l1.2 1.2-1.2 1.2-1.2-1.2z" stroke-linejoin="round"/></svg>';

// @puro-linha-inicio (testado em app/tests/linha.test.mjs)
const LN_MES=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const LN_SAUDE={ no_rumo:'no rumo', atencao:'atenção', atrasado:'atrasado' };
const LN_DIA=86400000;
function lnE(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// tarefa entregue = a regra única do épico (epDelivered, 46) quando existe; fora do app: mergeada/concluída/encerrada
function lnTaskOk(t){ if(typeof epDelivered==='function') return epDelivered(t); return !!t && (t.flag==='closed' || ['merged','done','closed'].includes(t.status)); }
// "AAAA-MM-DD" → Date local (meia-noite) ou null (malformada, dia que não existe)
function lnDia(s){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||'')); if(!m) return null;
  const d=new Date(+m[1], +m[2]-1, +m[3]);
  return (d.getFullYear()===+m[1] && d.getMonth()===+m[2]-1 && d.getDate()===+m[3]) ? d : null;
}
function lnIso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function lnDM(d){ return d?String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0'):''; }
// data digitada no formato do Brasil → "AAAA-MM-DD" ('' = vazio · null = inválida). Aceita d/m/aa, dd/mm/aaaa e AAAA-MM-DD.
function linhaDataBR(txt){
  const t=String(txt||'').trim(); if(!t) return '';
  if(lnDia(t)) return t;
  const m=/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(t); if(!m) return null;
  const y=m[3].length===2?2000+(+m[3]):+m[3];
  const iso=y+'-'+String(+m[2]).padStart(2,'0')+'-'+String(+m[1]).padStart(2,'0');
  return lnDia(iso)?iso:null;
}
function linhaDataTx(iso){ const d=lnDia(iso); return d?String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear():''; }
// erro da janela digitada ('' = válida). Os dois vazios = tirar a janela (válido).
function linhaJanelaErro(start, end){
  start=String(start||'').trim(); end=String(end||'').trim();
  if(!start && !end) return '';
  if(!start || !end) return 'Preencha o início e o fim (ou deixe os dois vazios pra tirar a janela).';
  const a=lnDia(start), b=lnDia(end);
  if(!a || !b) return 'Data inválida — use o formato dia/mês/ano.';
  if(b<a) return 'O fim vem antes do início.';
  return '';
}
// janela gravada → { s, e, start, end } ou null (sem janela, ou dado ruim vindo do banco = sem janela)
function linhaJanela(w){
  if(!w || typeof w!=='object') return null;
  const s=lnDia(w.start), e=lnDia(w.end);
  if(!s || !e || e<s) return null;
  return { s, e, start:w.start, end:w.end };
}
// erro da saúde ('' = ok): estado conhecido; atenção/atrasado pedem a frase
function linhaSaudeErro(state, note){
  if(!LN_SAUDE[state]) return 'Escolha no rumo, atenção ou atrasado.';
  if(state!=='no_rumo' && !String(note||'').trim()) return 'Escreva em uma frase o motivo — é o que quem acompanha vai ler.';
  return '';
}
// saúde gravada → { state, note, by, at } ou null (sem avaliação / dado ruim)
function linhaSaude(h){
  if(!h || typeof h!=='object' || !LN_SAUDE[h.state]) return null;
  return { state:h.state, note:String(h.note||'').trim(), by:h.by||'', at:h.at||'' };
}
// mescla UMA chave (window|health) no spec FRESCO da nuvem; o resto (doneWhen, description…) fica intacto
function linhaMesclaSpec(fresh, key, val){
  const spec={ ...((fresh&&typeof fresh==='object')?fresh:{}) };
  if(val==null) delete spec[key]; else spec[key]=val;
  return spec;
}
// tarefa do épico ainda ATIVA (rodando, na fila, aguardando, em revisão…): entregue, cancelada ou encerrada não conta
function lnTaskAtiva(t){ return !!t && !lnTaskOk(t) && t.status!=='cancelled' && t.flag!=='closed'; }
// A regra ÚNICA de "épico entregue" (Linha, contagem de ativos do Time, cabeçalho, seletor, página do épico):
// todos os itens do "pronto quando" provados E nenhuma tarefa do épico ainda ativa · ou, sem "pronto quando", todas as
// tarefas entregues (≥1) · ou status done
function epEntregue(ep, tasks){
  if(!ep) return false;
  if(ep.status==='done') return true;
  const ts=Array.isArray(tasks)?tasks:[];
  const dw=Array.isArray((ep.spec||{}).doneWhen)?ep.spec.doneWhen.filter(Boolean):[]; // mesma lista do linhaModelo
  if(dw.length) return dw.every(d=>d.checkedBy) && !ts.some(lnTaskAtiva);
  return ts.length>0 && ts.every(lnTaskOk);
}
// ativo = não arquivado e não entregue
function epAtivo(ep, tasks){ return !!ep && ep.status!=='archived' && !epEntregue(ep, tasks); }
// o modelo de UMA linha (sem DOM): progresso, rótulo, custo, janela válida, saúde, entrega
function linhaModelo(ep, tasks){
  ep=ep||{}; const sp=ep.spec||{}; const ts=Array.isArray(tasks)?tasks:[];
  const dw=Array.isArray(sp.doneWhen)?sp.doneWhen.filter(Boolean):[];
  const dwOk=dw.filter(d=>d.checkedBy).length, tOk=ts.filter(lnTaskOk).length;
  const porDw=dw.length>0;
  const tot=porDw?dw.length:ts.length, ok=porDw?dwOk:tOk;
  const pct=tot?Math.floor(ok/tot*100):0; // para baixo: a barra nunca promete mais do que está provado
  const rotulo=porDw?`${ok} de ${tot} ${tot===1?'item provado':'itens provados'}`:(tot?`${ok} de ${tot} ${tot===1?'tarefa':'tarefas'}`:'sem itens');
  const custo=ts.reduce((s,t)=>s+(+t.cost_usd||0),0);
  const janela=linhaJanela(sp.window), saude=linhaSaude(sp.health);
  const entregue=epEntregue(ep, ts);
  let entregueEm=null;
  if(entregue){
    if(janela) entregueEm=janela.e; // losango na data de fim da janela…
    else { // …ou na da última entrega (item provado / tarefa entregue); sem nenhuma, a última mudança do épico
      const ms=[...dw.map(d=>Date.parse(d.checkedAt)), ...ts.filter(lnTaskOk).map(t=>Date.parse(t.updated_at))].filter(x=>x>0);
      const last=ms.length?Math.max(...ms):(Date.parse(ep.updated_at)||Date.parse(ep.created_at)||0);
      if(last){ const d=new Date(last); entregueEm=new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    }
  }
  // tarefas todas entregues mas o "pronto quando" ainda sem prova: a barra não promete nada, mas a tela diz o que falta
  const faltaConferir=porDw && !entregue && ts.length>0 && tOk===ts.length;
  return { id:ep.id, nome:ep.name||'Épico', ep, porDw, ok, tot, pct, rotulo, custo, janela, saude, entregue, entregueEm, faltaConferir, ativo:ep.status!=='archived'&&!entregue };
}
// escala de meses visíveis (mín. 3, máx. 12) cobrindo janelas, entregas e hoje → { meses:[{label, left, width}], ini, fim, pos(d), hojePct }
function linhaEscala(modelos, hoje){
  hoje=hoje||new Date();
  const mi=d=>d.getFullYear()*12+d.getMonth(), th=mi(hoje);
  const pts=[th];
  (modelos||[]).forEach(m=>{ if(m.janela){ pts.push(mi(m.janela.s), mi(m.janela.e)); } if(m.entregue&&m.entregueEm) pts.push(mi(m.entregueEm)); });
  let lo=Math.min(...pts), hi=Math.max(...pts);
  if(hi-lo+1<3) hi=lo+2;
  if(hi-lo+1>12){ lo=Math.max(lo, th-3); hi=lo+11; }
  const ini=new Date(Math.floor(lo/12), lo%12, 1), fim=new Date(Math.floor((hi+1)/12), (hi+1)%12, 1);
  const span=fim-ini;
  const pos=d=>{ const p=(d-ini)/span*100; return Math.max(0, Math.min(100, Math.round(p*100)/100)); };
  const meses=[];
  for(let k=lo;k<=hi;k++){ const a=new Date(Math.floor(k/12), k%12, 1), b=new Date(Math.floor((k+1)/12), (k+1)%12, 1);
    const m=k%12; meses.push({ label:LN_MES[m]+((k===lo||m===0)?'/'+String(a.getFullYear()).slice(2):''), left:pos(a), width:Math.round((b-a)/span*10000)/100 }); }
  return { meses, ini, fim, pos, hojePct:pos(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 12)) };
}
// "out–nov" (mês, nunca dia — veto do Rafa); ano só quando não é o de hoje
function linhaJanelaTx(j, hoje){
  if(!j) return 'sem data';
  const y=(hoje||new Date()).getFullYear();
  const f=d=>LN_MES[d.getMonth()]+(d.getFullYear()!==y?'/'+String(d.getFullYear()).slice(2):'');
  const a=f(j.s), b=f(j.e);
  return a===b?a:a+'–'+b;
}
// muitos épicos (> 20): entregues há mais de 60 dias ficam recolhidos em "mostrar entregues (N)"
function linhaVisiveis(modelos, hoje, mostrar){
  const l=modelos||[];
  if(l.length<=20) return { vis:l, ocultos:0, recolhe:false };
  const cut=(hoje||new Date()).getTime()-60*LN_DIA;
  const vis=l.filter(m=>!(m.entregue && m.entregueEm && m.entregueEm.getTime()<cut));
  const velhos=l.length-vis.length; // nenhum entregue antigo: nada a recolher (sem "mostrar entregues (0)")
  if(mostrar) return { vis:l, ocultos:0, recolhe:velhos>0 };
  return { vis, ocultos:velhos, recolhe:velhos>0 };
}
// ordem: pela janela (início) ou entrega; sem data no fim
function linhaOrdena(modelos){
  const k=m=>m.janela?m.janela.s.getTime():(m.entregueEm?m.entregueEm.getTime():Infinity);
  return [...(modelos||[])].sort((a,b)=>k(a)-k(b) || String(a.nome).localeCompare(String(b.nome),'pt-BR'));
}
// HTML da linha. o: { hoje, mostrar, podeEditar(m), projeto(m) → rótulo, quem(uid) → nome, custoTx(usd) }
function linhaHtml(modelos, o){
  o=o||{}; const hoje=o.hoje||new Date();
  const ord=linhaOrdena(modelos);
  const { vis, ocultos, recolhe }=linhaVisiveis(ord, hoje, o.mostrar);
  const esc_=lnE, custoTx=o.custoTx||(v=>'US$ '+(+v||0).toFixed(2).replace('.',','));
  const quem=o.quem||(()=>''), pode=o.podeEditar||(()=>false), proj=o.projeto||(()=>'');
  const E=linhaEscala(vis, hoje);
  const grid=E.meses.slice(1).map(m=>`<i class="ln-gl" style="left:${m.left}%"></i>`).join('');
  const hojeL=`<i class="ln-today" style="left:${E.hojePct}%"></i>`;
  const head=`<div class="ln-hd ln-nmh">Épico</div><div class="ln-hd ln-mh">${E.meses.map(m=>`<span class="ln-m" style="left:${m.left}%;width:${m.width}%" title="${esc_(m.label)}">${esc_(m.label)}</span>`).join('')}<span class="ln-hoje" style="left:${E.hojePct}%" title="hoje, ${lnDM(hoje)}">hoje</span></div>`;
  const row=m=>{
    const can=!!pode(m), pj=proj(m), s=m.saude;
    const sub1=m.entregue
      ? `entregue${m.entregueEm?' '+lnDM(m.entregueEm):''} · ${esc_(custoTx(m.custo))}`
      : `${esc_(m.rotulo)} · ${esc_(custoTx(m.custo))}`;
    const sub2=m.entregue?'':(s
      ? `<span class="ln-sd h-${s.state}">${esc_(LN_SAUDE[s.state])}</span>${s.note?' · “'+esc_(s.note)+'”':''}${s.by?' · '+esc_(quem(s.by)):''}${Date.parse(s.at)>0?', '+lnDM(new Date(Date.parse(s.at))):''}`
      : `<span class="ln-sd">sem avaliação</span>`);
    const acts=(can&&!m.entregue)?`<span class="ln-acts"><button class="ln-lk" type="button" data-lnwin="${esc_(m.id)}" title="definir início e fim — só uma pessoa define a janela">${m.janela?'janela':'definir janela'}</button><button class="ln-lk" type="button" data-lnhealth="${esc_(m.id)}" title="no rumo · atenção · atrasado, com uma frase">saúde</button></span>`:'';
    const nm=`<div class="ln-nm"><button class="ln-ep" type="button" data-lnep="${esc_(m.id)}" title="${esc_('abrir o épico “'+m.nome+'”')}">${esc_(m.nome)}</button>${pj?`<span class="ln-proj">${esc_(pj)}</span>`:''}<span class="ln-sub">${sub1}</span>${m.faltaConferir?`<span class="ln-falta" title="todas as tarefas foram entregues, mas ninguém marcou o pronto quando com prova — abra o épico pra conferir">tarefas entregues · falta conferir o pronto quando</span>`:''}${sub2?`<span class="ln-sub"${s?` title="${esc_(LN_SAUDE[s.state]+(s.note?' · “'+s.note+'”':'')+(s.by?' · '+quem(s.by):''))}"`:''}>${sub2}</span>`:''}${acts}</div>`;
    let lane='';
    if(m.entregue){
      // sem data conhecida: só o texto "entregue" (nada de losango num lugar inventado); fora da faixa: preso na borda, marcado
      const fora=m.entregueEm && (m.entregueEm<E.ini || m.entregueEm>=E.fim);
      const t=m.entregueEm?'entregue '+lnDM(m.entregueEm)+(fora?', fora da faixa':''):'';
      lane=m.entregueEm?`<span class="ln-ms${fora?' out':''}" style="left:${E.pos(m.entregueEm)}%" title="${esc_(t)}" aria-label="${esc_(t)}"></span>`:'';
    } else if(m.janela && (m.janela.e<E.ini || m.janela.s>=E.fim)){
      // janela inteira fora dos meses visíveis: rótulo na borda, nunca uma lasca que parece data real
      const antes=m.janela.e<E.ini, ref=antes?E.ini:new Date(E.fim.getTime()-LN_DIA);
      const tx=(antes?'antes de ':'depois de ')+LN_MES[ref.getMonth()]+'/'+String(ref.getFullYear()).slice(2);
      lane=`<span class="ln-edge ${antes?'l':'r'}" title="${esc_(linhaJanelaTx(m.janela, hoje)+' · '+m.rotulo)}">${esc_(tx)}</span>`;
    } else if(m.janela){
      const a=E.pos(m.janela.s), b=E.pos(new Date(m.janela.e.getTime()+LN_DIA));
      const plan=!s && m.janela.s>hoje;
      const tx=(s?LN_SAUDE[s.state]:(plan?'planejado':'sem avaliação'))+' · '+m.pct+'%';
      const cut=(m.janela.s<E.ini?' cut-l':'')+(m.janela.e>=E.fim?' cut-r':'');
      lane=`<span class="ln-bar h-${s?s.state:'none'}${plan?' plan':''}${cut}" style="left:${a}%;width:${Math.max(0.8, b-a)}%" title="${esc_(linhaJanelaTx(m.janela, hoje)+' · '+m.rotulo+' · '+tx)}"><span class="ln-fill" style="width:${m.pct}%"></span><span class="ln-bt">${esc_(tx)}</span></span>`;
    } else {
      lane=can?`<button class="ln-nodate" type="button" data-lnwin="${esc_(m.id)}" title="só uma pessoa define a janela — o app nunca calcula data">sem data · definir janela</button>`:`<span class="ln-nodate">sem data</span>`;
    }
    return nm+`<div class="ln-lane">${grid}${lane}${hojeL}</div>`;
  };
  const body=vis.length?vis.map(row).join(''):'';
  const more=recolhe?`<button class="btn sm quiet ln-more" type="button" data-lnmore="1">${o.mostrar?'recolher entregues antigos':'mostrar entregues ('+ocultos+')'}</button>`:'';
  return `<div class="ln-wrap" role="region" aria-label="Linha do tempo dos épicos" tabindex="0"><div class="ln" style="min-width:${Math.max(660, 240+E.meses.length*64)}px">${head}${body}</div></div>
    <div class="ln-legend"><span><i class="lg h-no_rumo"></i>no rumo</span><span><i class="lg h-atencao"></i>atenção</span><span><i class="lg h-atrasado"></i>atrasado</span><span><i class="lg h-none"></i>sem avaliação</span><span><i class="lg plan"></i>planejado</span><span><i class="lg ms"></i>entregue</span><span class="ln-lg-tx">preenchimento = "pronto quando" provado (sem ele, tarefas entregues)</span>${more}</div>`;
}
// @puro-linha-fim

// ===================== dados (o que o Time já buscou) =====================
let lnMostrar=false; // "mostrar entregues (N)" — só nesta sessão
function lnTasksOf(id){ return ((typeof teamTasks!=='undefined'&&teamTasks)||[]).filter(t=>t.epic_id===id); }
function lnEpics(){ return ((typeof teamEpics!=='undefined'&&teamEpics)||[]).filter(e=>e&&e.status!=='archived'); }
// projeto de um épico = o projeto da maioria das suas tarefas (épico sem tarefa: sem projeto)
function lnProjOf(id){
  const n={}; lnTasksOf(id).forEach(t=>{ if(t.project_id) n[t.project_id]=(n[t.project_id]||0)+1; });
  const P=(typeof teamProj!=='undefined'&&teamProj)||{}, nm=k=>String((P[k]||{}).name||'');
  // empate: nome do projeto e depois id — o rótulo não troca entre uma busca e outra
  const best=Object.keys(n).sort((a,b)=>n[b]-n[a] || nm(a).localeCompare(nm(b),'pt-BR') || (a<b?-1:a>b?1:0))[0];
  return best?(P[best]||null):null;
}
function lnOpts(extra){
  return { hoje:new Date(), mostrar:lnMostrar,
    podeEditar:m=>typeof epCanCheck==='function'&&epCanCheck(m.ep),
    quem:uid=>typeof tmName==='function'?tmName(uid):'',
    custoTx:v=>typeof fmtCost==='function'?fmtCost(v):'US$ '+v,
    ...(extra||{}) };
}
// Time › Linha: todos os projetos, com o rótulo do projeto por épico
function linhaTimeHtml(){
  const eps=lnEpics();
  const org=typeof tsOrgScope==='function'&&tsOrgScope();
  const head=`<h1>Linha do time</h1><div class="tssub">O que cada projeto está entregando e quando · hoje ${lnDM(new Date())} · janela e saúde postas por uma pessoa</div>`;
  if(!eps.length) return head+(typeof emptyHtml==='function'?emptyHtml({ icon:'flag', title:'Nenhum épico no time ainda', help:'Crie um épico no Quadro (+ épico) e defina a janela dele aqui.' }):'<div class="dim">nenhum épico no time ainda</div>');
  const mods=eps.map(e=>linhaModelo(e, lnTasksOf(e.id)));
  return head+linhaHtml(mods, lnOpts({ projeto:m=>{ const p=lnProjOf(m.id); const pn=p?(p.name||String(p.repo_remote||'').split('/').pop()):'sem projeto'; return org&&typeof tsTeamName==='function'?pn+' · '+(tsTeamName(m.ep.team_id)||''):pn; } }));
}
window.linhaTimeHtml=linhaTimeHtml;

// ===================== Projeto › Linha =====================
let lnProjRepo=null, lnProjIds=null, lnProjSig='', lnProjErr=null, lnProjTry=0, lnProjShown=null;
function linhaProjMount(){
  const host=$id('projLinhaHost'); if(!host) return;
  if(!(typeof SB!=='undefined'&&SB.sess()) || !(typeof cloudTeamId==='function'&&cloudTeamId())){
    const h=emptyHtml({ icon:'cloud', title:'A Linha é do time', help:'Entre na sua conta e num time pra ver o que este projeto está entregando e quando.', action:{ id:'lnGoConta', label:'Abrir Conta e time' } });
    if(lnProjSig!==h){ lnProjSig=h; host.innerHTML=h; bindClick('lnGoConta', ()=>{ if(typeof g1Ajustes==='function') g1Ajustes('conta'); else openTab('conta'); }); }
    return;
  }
  const repo=(typeof state!=='undefined'&&state.repo)||'';
  if(!repo) return; // sem projeto aberto: a casca mostra "Esta página é de um projeto"
  if(lnProjRepo!==repo){ lnProjRepo=repo; lnProjIds=null; lnProjSig='';
    // resposta (ou falha) atrasada do projeto anterior não vale pro atual; erro de pintura não cai no handler de falha
    repoRemoteIds().then(ids=>{ if(lnProjRepo===repo){ lnProjIds=ids; linhaProjPaint(); } }, ()=>{ if(lnProjRepo===repo){ lnProjIds={ remote:'', legacy:'' }; linhaProjPaint(); } }); }
  // sem timer próprio: o render que já existe chama isto; busca no máx. 1×/min (falhou: só pelo "tentar de novo")
  const stale=teamTasks ? Date.now()-teamFetchedAt>60000 : !lnProjErr;
  if(stale && (!teamTasks || Date.now()-lnProjTry>15000)){
    lnProjTry=Date.now();
    // a busca volta sem cartões (nenhum time no escopo): vira erro com "tentar de novo" em vez de esqueleto eterno
    if(!teamFetching) teamFetch(!teamTasks).then(()=>{ lnProjErr=teamTasks?null:new Error('sem time no escopo'); lnProjSig=''; linhaProjPaint(); }, e=>{ lnProjErr=e; lnProjSig=''; linhaProjPaint(); });
  }
  linhaProjPaint();
}
window.linhaProjMount=linhaProjMount;
function linhaProjPaint(){
  const host=$id('projLinhaHost'); if(!host || host.closest('[hidden]')) return;
  let h;
  if(!teamTasks || !lnProjIds){
    // o Time zerou o cache (cartão novo, épico mexido…): mantém a última Linha na tela até a nova busca chegar
    if(lnProjIds && lnProjShown===lnProjRepo && !lnProjErr) return;
    h=lnProjErr&&!teamTasks
      ? emptyHtml({ icon:'cloud', title:'Não consegui carregar a Linha', help:(typeof errShort==='function'?errShort(lnProjErr):'sem conexão com a nuvem'), action:{ id:'lnRetry', label:'Tentar de novo' } })
      : (typeof skeletonHtml==='function'?skeletonHtml('lista',{ n:4, compact:true, inline:true, label:'carregando a linha do projeto' }):'<div class="dim">carregando…</div>');
  } else {
    // épicos do projeto = os que têm tarefa deste projeto (tasks.epic_id → tasks.project_id → repo_remote)
    const mine=new Set(); (teamTasks||[]).forEach(t=>{ if(!t.epic_id) return; const p=teamProj[t.project_id]; if(p&&p.repo_remote&&remoteSame(p.repo_remote, lnProjIds)) mine.add(t.epic_id); });
    const eps=lnEpics().filter(e=>mine.has(e.id));
    const sem=lnEpics().filter(e=>!lnTasksOf(e.id).length).length;
    const nota=sem?`<p class="ln-nota">No time, ${sem} ${sem===1?'épico ainda sem tarefas aparece':'épicos ainda sem tarefas aparecem'} só em Time › Linha (o projeto de um épico vem das tarefas dele).</p>`:'';
    h=eps.length
      ? linhaHtml(eps.map(e=>linhaModelo(e, lnTasksOf(e.id))), lnOpts())+nota
      : emptyHtml({ icon:'flag', title:'Nenhum épico com tarefas deste projeto', help:'Quando um épico do time tiver tarefas neste projeto, ele aparece aqui com a janela e a saúde.' })+nota;
  }
  if(lnProjSig===h) return;
  const sx=(host.querySelector('.ln-wrap')||{}).scrollLeft||0;
  lnProjSig=h; host.innerHTML=h; lnProjShown=(teamTasks&&lnProjIds)?lnProjRepo:null;
  { const w=host.querySelector('.ln-wrap'); if(w) w.scrollLeft=sx; }
  bindClick('lnRetry', ()=>{ lnProjErr=null; lnProjSig=''; teamFetch(true).then(()=>{ lnProjErr=teamTasks?null:new Error('sem time no escopo'); lnProjSig=''; linhaProjPaint(); }, e=>{ lnProjErr=e; lnProjSig=''; linhaProjPaint(); }); linhaProjPaint(); });
  linhaWire(host);
}
// repinta onde a Linha estiver visível (depois de gravar / mostrar entregues)
function linhaRepaint(){
  lnProjSig=''; linhaProjPaint();
  if(typeof teamPaintSig!=='undefined'){ teamPaintSig=''; if(typeof g1TabOn==='function'&&g1TabOn('time')&&typeof renderTeamBoard==='function') safe(renderTeamBoard); }
}

// ===================== interação (folhas ancoradas, nunca modal) =====================
function lnEpById(id){ return lnEpics().find(e=>e.id===id)||null; }
function linhaWire(root){
  if(!root) return;
  root.querySelectorAll('[data-lnep]').forEach(b=>b.onclick=()=>{ const e=lnEpById(b.dataset.lnep); if(e&&window.openEpicPage) openEpicPage(e); });
  root.querySelectorAll('[data-lnwin]').forEach(b=>b.onclick=(ev)=>{ ev.stopPropagation(); const e=lnEpById(b.dataset.lnwin); if(e) linhaFolhaJanela(b, e); });
  root.querySelectorAll('[data-lnhealth]').forEach(b=>b.onclick=(ev)=>{ ev.stopPropagation(); const e=lnEpById(b.dataset.lnhealth); if(e) linhaFolhaSaude(b, e); });
  root.querySelectorAll('[data-lnmore]').forEach(b=>b.onclick=()=>{ lnMostrar=!lnMostrar; linhaRepaint(); });
}
window.linhaWire=linhaWire;
// folha ancorada com formulário (mesmo visual da sheetAsk do 52): ok(el) → '' (fecha) ou texto do erro (fica aberta)
let lnSheetClose=null;
function linhaFolha(anchor, title, bodyHtml, ok, okLabel){
  if(lnSheetClose) lnSheetClose();
  const prev=document.activeElement;
  const el=document.createElement('div'); el.className='sfsheet ln-sheet'; el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-label', title);
  el.innerHTML=`<div class="sh-h"><b>${lnE(title)}</b></div><div class="sh-b">${bodyHtml}<p class="ln-sherr" role="alert" hidden></p></div><div class="sh-f"><button type="button" class="btn primary sm" data-ln-ok>${lnE(okLabel||'salvar')}</button><button type="button" class="btn sm" data-ln-no>cancelar</button><span>Esc fecha</span></div>`;
  document.body.appendChild(el);
  const vw=window.innerWidth||1280, vh=window.innerHeight||800, r=anchor.getBoundingClientRect();
  const p=(typeof sheetPlace==='function')?sheetPlace(r, el.offsetWidth||380, el.offsetHeight||220, vw, vh):{ top:r.bottom+8, left:Math.max(8,r.left), ax:30, up:false };
  el.style.top=p.top+'px'; el.style.left=p.left+'px'; el.style.setProperty('--ax', p.ax+'px'); if(p.up) el.classList.add('up');
  const errEl=el.querySelector('.ln-sherr'), okB=el.querySelector('[data-ln-ok]');
  let busy=false;
  // a Linha é redesenhada ao salvar: o botão que abriu a folha some — o foco volta pro botão NOVO equivalente
  const ds=(prev&&prev.dataset)||{}, cls=prev&&prev.classList?prev.classList[0]:'';
  const q=v=>String(v).replace(/["\\]/g,'\\$&');
  const sel=ds.lnwin?`.${cls}[data-lnwin="${q(ds.lnwin)}"]`:ds.lnhealth?`.${cls}[data-lnhealth="${q(ds.lnhealth)}"]`:'';
  const close=()=>{ if(!el.isConnected) return; el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true);
    document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResize); lnSheetClose=null;
    try{ const f=(prev&&prev.isConnected)?prev:(sel&&cls?document.querySelector(sel):null); if(f&&f.focus) f.focus(); }catch(_){ } };
  // folha fixa: se a linha (ou a página) rolar, ou a janela mudar de tamanho, ela soltaria da linha — fecha
  const onScroll=e=>{ if(busy) return; const t=e.target; if(t===document || (t&&t.contains&&!el.contains(t)&&t.contains(anchor))) close(); };
  const onResize=()=>{ if(!busy) close(); };
  const go=async()=>{ if(busy) return; busy=true; okB.disabled=true; const lb=okB.textContent; okB.textContent='salvando…';
    // erro de rede/permissão: toast (com "ver detalhes") + a frase na folha, que fica aberta com o que foi digitado
    let msg=''; try{ msg=await ok(el); }catch(e){ if(typeof showErr==='function') showErr(e, 'Não consegui salvar'); msg=(typeof errShort==='function'?errShort(e):String(e&&e.message||e)); }
    busy=false; okB.disabled=false; okB.textContent=lb;
    if(msg){ errEl.textContent=msg; errEl.hidden=false; } else close(); };
  const outside=e=>{ if(!el.contains(e.target) && !busy) close(); };
  const key=e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); if(!busy) close(); return; }
    if(e.key==='Tab'){ const f=[...el.querySelectorAll('button:not([disabled]),input,textarea')]; if(!f.length) return; const i=f.indexOf(document.activeElement);
      if(e.shiftKey && i<=0){ e.preventDefault(); f[f.length-1].focus(); } else if(!e.shiftKey && (i===-1||i===f.length-1)){ e.preventDefault(); f[0].focus(); } return; }
    if(e.key==='Enter' && el.contains(e.target) && !(e.target.matches&&e.target.matches('textarea,[data-ln-no],[data-lnst]'))){ e.preventDefault(); go(); } };
  okB.onclick=go; el.querySelector('[data-ln-no]').onclick=close;
  lnSheetClose=close;
  setTimeout(()=>{ if(!el.isConnected) return; document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); document.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResize); const f=el.querySelector('input,textarea,button'); if(f) f.focus(); }, 0);
  return el;
}
function linhaFolhaJanela(anchor, ep){
  const j=linhaJanela((ep.spec||{}).window);
  const body=`<p>Quando este épico deve começar e terminar. Quem define é uma pessoa — o app nunca calcula nem prevê data.</p>
    <div class="ln-dates"><label>Início<input class="in" type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/aaaa" maxlength="10" data-ln-ini value="${lnE(j?linhaDataTx(j.start):'')}"></label><label>Fim<input class="in" type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/aaaa" maxlength="10" data-ln-fim value="${lnE(j?linhaDataTx(j.end):'')}"></label></div>
    <p class="ln-hint">${j?'Apague os dois pra tirar a janela.':'Ex.: 03/11/2026.'}</p>`;
  const el=linhaFolha(anchor, 'Janela · '+(ep.name||'Épico'), body, async(el)=>{
    const ii=el.querySelector('[data-ln-ini]'), fi=el.querySelector('[data-ln-fim]');
    const s=linhaDataBR(ii.value), e=linhaDataBR(fi.value);
    if(s===null || e===null) return 'Data inválida — use dia/mês/ano, ex.: 03/11/2026.';
    if(!s && !e && !j) return 'Preencha o início e o fim.';
    const err=linhaJanelaErro(s, e); if(err) return err;
    await linhaSalvar(ep.id, 'window', (s&&e)?{ start:s, end:e }:null);
    if(typeof toast==='function') toast((s&&e)?'Janela salva':'Janela removida', 'ok');
    return '';
  });
  if(el) el.querySelectorAll('[data-ln-ini],[data-ln-fim]').forEach(lnMascaraData);
}
// máscara leve dd/mm/aaaa: põe a barra sozinha ao digitar (apagar continua livre)
function lnMascaraData(inp){ inp.addEventListener('input', ev=>{ if(ev.inputType && !ev.inputType.startsWith('insert')) return; let v=inp.value.replace(/[^0-9/]/g,''); if(/^\d{2}$/.test(v)||/^\d{1,2}\/\d{2}$/.test(v)) v+='/'; inp.value=v.slice(0,10); }); }
function linhaFolhaSaude(anchor, ep){
  const h=linhaSaude((ep.spec||{}).health); let pick=h?h.state:null; // sem avaliação: nada marcado (um Enter não grava "no rumo" por engano)
  const opts=Object.keys(LN_SAUDE).map(k=>`<button type="button" class="sh-opt${k===pick?' on':''}" role="radio" aria-checked="${k===pick}" data-lnst="${k}"><span class="rd"></span><b>${lnE(LN_SAUDE[k])}</b><em>${k==='no_rumo'?'segue a janela':k==='atencao'?'risco pra janela — diga o motivo':'vai passar da janela — diga o motivo'}</em></button>`).join('');
  const body=`<p>Sua leitura de como o épico está. Fica com o seu nome; sem avaliação, a barra fica neutra.</p><div class="sh-opts" role="radiogroup" aria-label="saúde do épico">${opts}</div>
    <label class="ln-note">Em uma frase<textarea class="in" rows="2" maxlength="200" data-ln-nota placeholder="ex.: falta acesso ao banco de telemetria">${lnE(h?h.note:'')}</textarea></label>`;
  const el=linhaFolha(anchor, 'Saúde · '+(ep.name||'Épico'), body, async(el)=>{
    const note=el.querySelector('[data-ln-nota]').value.trim();
    const err=linhaSaudeErro(pick, note); if(err){ if(pick) el.querySelector('[data-ln-nota]').focus(); return err; }
    await linhaSalvar(ep.id, 'health', { state:pick, note, by:cloudUserId(), at:new Date().toISOString() });
    if(typeof toast==='function') toast('Saúde do épico salva', 'ok');
    return '';
  });
  const rds=[...el.querySelectorAll('[data-lnst]')];
  const marca=(b)=>{ pick=b.dataset.lnst; rds.forEach(x=>{ const on=x===b; x.classList.toggle('on',on); x.setAttribute('aria-checked',String(on)); x.tabIndex=on?0:-1; }); };
  rds.forEach((b,i)=>{ b.tabIndex=(pick?b.dataset.lnst===pick:i===0)?0:-1; b.onclick=()=>marca(b);
    b.onkeydown=(e)=>{ const d={ ArrowDown:1, ArrowRight:1, ArrowUp:-1, ArrowLeft:-1 }[e.key]; if(!d) return; e.preventDefault(); const n=rds[(i+d+rds.length)%rds.length]; marca(n); n.focus(); }; });
}
// grava UMA chave do spec: relê o spec FRESCO e mescla (outro membro ou o agente revisor podem ter mexido no doneWhen).
// O PATCH só vale se o épico não mudou desde a releitura (updated_at igual); mudou no meio → relê e refaz UMA vez.
// Falha de rede na releitura = não grava nada (nunca escreve em cima de um spec velho). Status do épico não muda.
const LN_SUMIU='Esse épico não existe mais — alguém mudou agora há pouco.';
async function linhaSalvar(epId, key, val){
  const ler=async()=>((await sbGet('epics?select=id,spec,updated_at&id=eq.'+epId))||[])[0]||null;
  let fresh=await ler();
  if(!fresh) throw new Error(LN_SUMIU);
  for(let tent=0;;tent++){
    const spec=linhaMesclaSpec(fresh.spec, key, val);
    const at=new Date().toISOString();
    const pre=fresh.updated_at?'&updated_at=eq.'+encodeURIComponent(fresh.updated_at):'';
    const r=await sbFetch('/rest/v1/epics?id=eq.'+epId+pre, { method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({ spec, updated_at:at }) });
    if(Array.isArray(r) && r.length){
      const row=r[0]||{}; const upd=e=>e?{ ...e, spec:row.spec||spec, updated_at:row.updated_at||at }:e;
      if(typeof teamEpics!=='undefined'){ const i=teamEpics.findIndex(e=>e.id===epId); if(i>=0) teamEpics[i]=upd(teamEpics[i]); }
      if(typeof epCache!=='undefined' && epCache[epId] && epCache[epId].ep) epCache[epId].ep=upd(epCache[epId].ep);
      if(typeof epTab!=='undefined' && epTab && epTab.id===epId){ epTab=upd(epTab); }
      linhaRepaint();
      return;
    }
    // 0 linhas: sumiu, mudou no meio ou não tenho permissão — relê pra saber qual
    const now=await ler();
    if(!now) throw new Error(LN_SUMIU);
    if(now.updated_at===fresh.updated_at) throw new Error('Você não tem permissão pra mudar este épico — só quem criou o épico ou um admin.');
    if(tent>=1) throw new Error('Alguém mudou este épico agora mesmo — tente de novo.');
    fresh=now;
  }
}
