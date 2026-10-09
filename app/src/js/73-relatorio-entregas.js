// Starfork — 73-relatorio-entregas: RELATÓRIO DO PERÍODO pro gestor (pedido do dono 09/10). Botão "gerar relatório" na
// aba Entregas (70) → abre como ABA (nunca modal) um documento com: resumo executivo em 3–5 linhas montado SEM IA
// (contagens, épicos que avançaram, travadas, quem entregou), seções por épico e por pessoa (issue · PR · requisitos
// provados · miniaturas das provas), "o que está travado" (motivo — entMotivo/entTravada) e "o que vem a seguir"
// (prontas pra revisar e a fila dos épicos). Ordem: modificação mais recente primeiro.
// Os MESMOS dados da aba: alcance, filtros e período (entUltimo do 70), carimbos de entrega do 72 (nunca updated_at),
// provas do lote do 70. Custo só pra líder/owner/admin (T8 — entPodeVerCusto). Nada sobe pra nuvem: exporta PDF
// (relatorio.rs: WKWebView fora da tela + createPDF, local), Markdown (copiar) e HTML autocontido (CSS inline, provas
// em data:, sem script). "Melhorar com IA" ficou de fora: o resumo é montado pelos números, sem custo nem espera.

// @puro-relatorio-inicio (testado em app/tests/entregas-dia.test.mjs)
function relEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function relMdEsc(s){ return String(s==null?'':s).replace(/\s+/g,' ').trim().replace(/([\\`*_[\]<>])/g,'\\$1'); }
function relPl(n, a, b){ return n+' '+(n===1?a:b); }
function relUsd(v){ return 'US$ '+(Math.round((+v||0)*100)/100).toFixed(2).replace('.',','); }
const relMod=x=>x.mod||x.ts||0;
const relOrd=list=>(list||[]).slice().sort((a,b)=>relMod(b)-relMod(a));
// d → o documento (sem HTML): { titulo, sub, resumo:[3–5 linhas], porEpico, porPessoa, travadas, prontas, fila, rodape }
function relMonta(d){
  const itens=relOrd(d.itens), pr=itens.filter(x=>x.tipo==='pr'), sempr=itens.length-pr.length;
  // pessoas: quem entregou (integradas), agrupadas pelo ID (nome igual não junta gente); "Sem dono" não é pessoa.
  // Ordem: a entrega mais recente (modificação) primeiro; empate, quem entregou mais
  const pc={}, pn={}, pm={}; pr.forEach(x=>{ const k=x.quemId||''; if(!k) return; pc[k]=(pc[k]||0)+1; pn[k]=x.quem; pm[k]=Math.max(pm[k]||0, relMod(x)); });
  const pess=Object.keys(pc).sort((a,b)=>pm[b]-pm[a] || pc[b]-pc[a] || pn[a].localeCompare(pn[b],'pt-BR'));
  const eps=(d.epicos||[]).map(e=>({ ...e, itens:itens.filter(x=>x.epicoId===e.id) })).filter(e=>e.itens.length)
    .sort((a,b)=>relMod(b.itens[0])-relMod(a.itens[0]));
  const soltos=itens.filter(x=>!x.epicoId || !eps.some(e=>e.id===x.epicoId));
  const trav=relOrd(d.travadas), prontas=relOrd(d.prontas), fila=relOrd(d.fila);
  const resumo=[];
  resumo.push(pr.length?`${relPl(pr.length,'entrega integrada','entregas integradas')} por ${relPl(pess.length,'pessoa','pessoas')}: ${pess.map(p=>pn[p]+' ('+pc[p]+')').join(', ')}.`:'Nenhuma entrega integrada no período.');
  const epAv=eps.filter(e=>e.itens.some(x=>x.tipo==='pr'));
  resumo.push(epAv.length?`Épicos que avançaram: ${epAv.map(e=>`${e.nome} (+${e.itens.filter(x=>x.tipo==='pr').length}, ${e.ent} de ${e.tot} entregues)`).join('; ')}.`:'Nenhum épico avançou no período.');
  resumo.push(trav.length?`${relPl(trav.length,'travada','travadas')} agora: ${trav.slice(0,2).map(t=>`${t.titulo} (${t.motivo||'travada'})`).join('; ')}${trav.length>2?` e mais ${trav.length-2}`:''}.`:'Nada travado agora.');
  resumo.push(`${relPl(prontas.length,'pronta','prontas')} pra revisar e ${fila.length} na fila dos épicos.`);
  const ex=[]; if(sempr) ex.push(relPl(sempr,'concluída sem PR','concluídas sem PR'));
  if(d.semData) ex.push(`${d.semData} sem data de entrega (fora das contas)`);
  if(d.custo!=null) ex.push('custo das entregas: '+relUsd(d.custo));
  if(ex.length) resumo.push(ex.join(' · ').replace(/^./, c=>c.toUpperCase())+'.');
  const porEpico=eps.map(e=>({ nome:e.nome, nums:`${e.ent} de ${e.tot} entregues · +${e.itens.filter(x=>x.tipo==='pr').length} no período`, itens:e.itens }));
  if(soltos.length) porEpico.push({ nome:'Sem épico', nums:relPl(soltos.length,'item','itens'), itens:soltos });
  const porPessoa=pess.map(p=>({ nome:pn[p], n:pc[p], itens:pr.filter(x=>x.quemId===p) }));
  return { titulo:'Relatório de entregas', sub:`${d.periodo} (${d.de}${d.ate&&d.ate!==d.de?'–'+d.ate:''}) · ${d.escopo}${d.filtros?' · '+d.filtros:''}`,
    resumo:resumo.slice(0,5), porEpico, porPessoa, travadas:trav, prontas, fila, total:pr.length,
    rodape:`Gerado pelo Starfork em ${d.geradoEm}. Entregue = PR integrado com data real (evento de status ou conclusão registrada); nada deste relatório foi enviado pra nuvem.` };
}
function relMeta(x){
  return [x.quem, x.dia, x.issue&&x.issue.code?x.issue.code:'', x.pr&&x.pr.num?'PR #'+x.pr.num:(x.tipo==='sempr'?'sem PR':''),
    x.reqs?`requisitos ${x.reqs.ok}/${x.reqs.tot}`:'', x.provas?relPl(x.provas,'prova','provas'):''].filter(Boolean);
}
function relMarkdown(m){
  const L=[`# ${m.titulo}`, '', relMdEsc(m.sub), '', '## Resumo', '', ...m.resumo.map(l=>'- '+relMdEsc(l)), ''];
  L.push('## Por épico', '');
  if(!m.porEpico.length) L.push('_Nada entregue no período._', '');
  m.porEpico.forEach(g=>{ L.push(`### ${relMdEsc(g.nome)} — ${relMdEsc(g.nums)}`, ''); g.itens.forEach(x=>L.push(`- **${relMdEsc(x.titulo)}** — ${relMeta(x).map(relMdEsc).join(' — ')}`)); L.push(''); });
  L.push('## Por pessoa', '');
  if(!m.porPessoa.length) L.push('_Ninguém entregou no período._', '');
  m.porPessoa.forEach(p=>{ L.push(`### ${relMdEsc(p.nome)} — ${relPl(p.n,'entrega','entregas')}`, ''); p.itens.forEach(x=>L.push(`- **${relMdEsc(x.titulo)}** — ${relMeta(x).slice(1).map(relMdEsc).join(' — ')}`)); L.push(''); });
  L.push('## O que está travado agora', '');
  if(!m.travadas.length) L.push('Nada travado agora.', '');
  else { m.travadas.forEach(t=>L.push(`- **${relMdEsc(t.titulo)}** — ${relMdEsc(t.quem)} — ${relMdEsc(t.motivo||'travada')}${t.epico?` (${relMdEsc(t.epico)})`:''}`)); L.push(''); }
  L.push('## O que vem a seguir (agora)', '', '### Prontas pra revisar', '');
  if(!m.prontas.length) L.push('Nenhuma.', '');
  else { m.prontas.forEach(t=>L.push(`- ${relMdEsc(t.titulo)} — ${relMdEsc(t.quem)}${t.pr&&t.pr.num?' — PR #'+t.pr.num:''}${t.epico?` (${relMdEsc(t.epico)})`:''}`)); L.push(''); }
  L.push('### Na fila dos épicos', '');
  if(!m.fila.length) L.push('Nada na fila.', '');
  else { m.fila.forEach(t=>L.push(`- ${relMdEsc(t.titulo)} — ${relMdEsc(t.epico)} — ${relMdEsc(t.quem)}`)); L.push(''); }
  L.push('---', '', '_'+relMdEsc(m.rodape)+'_', '');
  return L.join('\n');
}
// corpo do documento (o MESMO na aba e no arquivo). src(path) → URL da miniatura ('' = sem imagem)
function relCorpoHtml(m, src){
  src=src||(()=>'');
  const a=(u, t)=>/^https?:\/\//i.test(u||'')?`<a href="${relEsc(u)}">${relEsc(t)}</a>`:relEsc(t);
  const meta=x=>{ const p=[relEsc(x.quem), relEsc(x.dia)];
    if(x.issue&&x.issue.code) p.push(a(x.issue.url, x.issue.code));
    if(x.pr&&x.pr.num) p.push(a(x.pr.url, 'PR #'+x.pr.num)); else if(x.tipo==='sempr') p.push('<span class="rl-sempr">sem PR</span>');
    if(x.reqs) p.push(`<span class="rl-rq${x.reqs.ok===x.reqs.tot?' ok':''}">requisitos ${x.reqs.ok}/${x.reqs.tot} provados</span>`);
    if(x.provas) p.push(relEsc(relPl(x.provas,'prova','provas')));
    return p.join('<i>·</i>'); };
  const imgs=x=>{ const v=(x.imgs||[]).map(i=>({ i, u:src(i.path) })).filter(y=>/^(https?:|data:image\/)/.test(y.u)); return v.length?`<div class="rl-imgs">${v.map(y=>`<img src="${relEsc(y.u)}" alt="${relEsc('prova: '+y.i.nome)}">`).join('')}</div>`:''; };
  const item=(x, semQuem)=>`<div class="rl-it rl-keep"><div class="rl-t">${relEsc(x.titulo)}</div><div class="rl-m">${semQuem?meta(x).replace(/^[^<]*<i>·<\/i>/, ''):meta(x)}</div>${imgs(x)}</div>`;
  const lista=(arr, f, vazio)=>arr.length?`<ul class="rl-ul">${arr.map(t=>`<li class="rl-keep">${f(t)}</li>`).join('')}</ul>`:`<p class="rl-vz">${relEsc(vazio)}</p>`;
  return `<header class="rl-head rl-keep"><h1>${relEsc(m.titulo)}</h1><p class="rl-sub">${relEsc(m.sub)}</p></header>
<section class="rl-sec rl-resumo rl-keep"><h2>Resumo</h2><ul>${m.resumo.map(l=>`<li>${relEsc(l)}</li>`).join('')}</ul></section>
<section class="rl-sec"><h2 class="rl-keep rl-kn">Por épico</h2>${m.porEpico.length?m.porEpico.map(g=>`<div class="rl-grp"><h3 class="rl-keep rl-kn">${relEsc(g.nome)} <small>${relEsc(g.nums)}</small></h3>${g.itens.map(x=>item(x)).join('')}</div>`).join(''):'<p class="rl-vz">Nada entregue no período.</p>'}</section>
<section class="rl-sec"><h2 class="rl-keep rl-kn">Por pessoa</h2>${m.porPessoa.length?m.porPessoa.map(p=>`<div class="rl-pess"><h3 class="rl-keep rl-kn">${relEsc(p.nome)} <small>${relEsc(relPl(p.n,'entrega','entregas'))}</small></h3>${p.itens.map(x=>item(x, true)).join('')}</div>`).join(''):'<p class="rl-vz">Ninguém entregou no período.</p>'}</section>
<section class="rl-sec"><h2 class="rl-keep rl-kn">O que está travado agora</h2>${lista(m.travadas, t=>`<b>${relEsc(t.titulo)}</b> <span class="rl-dim">${relEsc(t.quem)}${t.epico?' · '+relEsc(t.epico):''}</span><div class="rl-why">${relEsc(t.motivo||'travada')}</div>`, 'Nada travado agora.')}</section>
<section class="rl-sec"><h2 class="rl-keep rl-kn">O que vem a seguir <small class="rl-dim">agora</small></h2><h3 class="rl-keep rl-kn">Prontas pra revisar</h3>${lista(m.prontas, t=>`<b>${relEsc(t.titulo)}</b> <span class="rl-dim">${relEsc(t.quem)}${t.pr&&t.pr.num?' · ':''}${t.pr&&t.pr.num?a(t.pr.url, 'PR #'+t.pr.num):''}${t.epico?' · '+relEsc(t.epico):''}</span>`, 'Nenhuma.')}<h3 class="rl-keep rl-kn">Na fila dos épicos</h3>${lista(m.fila, t=>`${relEsc(t.titulo)} <span class="rl-dim">${relEsc(t.epico)} · ${relEsc(t.quem)}</span>`, 'Nada na fila.')}</section>
<footer class="rl-foot rl-keep">${relEsc(m.rodape)}</footer>`;
}
// o arquivo: HTML autocontido — CSS inline, imagens só em data:, SEM script
function relHtml(m, o){
  o=o||{};
  const src=p=>{ const u=o.src?o.src(p):''; return /^data:image\//.test(u||'')?u:''; };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${relEsc(m.titulo+' · '+m.sub)}</title><style>${o.css||''}</style></head><body><main class="rl-doc">${relCorpoHtml(m, src)}</main></body></html>`;
}
// o nome do arquivo: relatorio-entregas-<de>-a-<até>
function relNome(d){ const f=s=>String(s||'').replace(/\//g,'-'); return 'relatorio-entregas-'+f(d.de)+(d.ate&&d.ate!==d.de?'-a-'+f(d.ate):''); }
// @puro-relatorio-fim

// CSS do ARQUIVO (impressão, fundo claro — o documento sai do app; na aba vale o 99-entregas-dia.css com os tokens)
// @cor-dado-inicio (o arquivo exportado não tem os tokens do app: cores fixas de documento impresso, como o Daily exportado)
const REL_CSS=`*{box-sizing:border-box}html,body{margin:0;background:#fff}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d2420;-webkit-print-color-adjust:exact}
.rl-doc{width:794px;max-width:100%;margin:0 auto;padding:28px 36px 36px}
.rl-head h1{font-size:26px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}.rl-sub{margin:0;color:#56635c;font-size:13.5px}
.rl-sec{margin-top:26px}.rl-sec h2{font-size:17px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #dfe5e1}
.rl-sec h3{font-size:14.5px;margin:16px 0 6px}.rl-sec h3 small{font-weight:500;color:#56635c;font-size:12.5px;margin-left:6px}
.rl-resumo ul{margin:0;padding:12px 16px 12px 30px;background:#f3f6f4;border:1px solid #dfe5e1;border-radius:10px}.rl-resumo li{margin:3px 0}
.rl-it{padding:9px 0 10px;border-top:1px solid #edf1ee}.rl-grp h3+.rl-it{border-top:0}
.rl-t{font-weight:600}.rl-m{color:#56635c;font-size:12.5px;margin-top:2px}.rl-m i{font-style:normal;margin:0 6px;color:#b9c4bd}
.rl-m a,.rl-ul a{color:#2f6f57;text-decoration:none;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.rl-rq{color:#56635c}.rl-rq.ok{color:#2f7a4f}.rl-sempr{border:1px solid #c9d2cc;border-radius:999px;padding:0 6px;font-size:11.5px}
.rl-imgs{display:flex;gap:8px;margin-top:8px}.rl-imgs img{width:150px;height:96px;object-fit:cover;object-position:top;border:1px solid #dfe5e1;border-radius:6px}
.rl-ul{margin:0;padding-left:20px}.rl-ul li{margin:5px 0}.rl-dim{color:#56635c;font-size:12.5px}.rl-why{color:#a3402f;font-size:12.5px}
.rl-vz{color:#56635c;margin:4px 0}.rl-pess h3{margin-top:12px}
.rl-foot{margin-top:30px;padding-top:10px;border-top:1px solid #dfe5e1;color:#56635c;font-size:11.5px}`;
// @cor-dado-fim

// ---- montar a partir da aba (mesmos dados) ----
function relDados(c, pe){
  const r=c.range, ent=diaItensDe(pe);
  const epName=id=>(((typeof teamEpics!=='undefined'&&teamEpics)||[]).find(e=>e.id===id)||{}).name||'';
  // quem ENTREGOU (responsável, senão quem criou) nas entregas; nas listas de "agora" (travadas, prontas, fila) o
  // RESPONSÁVEL — sem responsável é "Sem dono", que é justamente a informação útil pro gestor
  const quem=t=>{ const u=diaQuem(t); return u?personName(u,{ noYou:true }):'Sem dono'; };
  const dono=t=>t.assignee?personName(t.assignee,{ noYou:true }):'Sem dono';
  const dd=ms=>new Date(ms).toLocaleDateString('pt-BR',{ day:'2-digit', month:'2-digit' });
  const itens=ent.filter(x=>x.ts && periodHas(r, x.ts)).map(x=>{ const t=x.t, ch=chainOfNow(t);
    return { id:t.id, titulo:t.title||'tarefa', quem:quem(t), quemId:diaQuem(t)||'', epico:epName(t.epic_id), epicoId:t.epic_id||'',
      issue:ch&&ch.issue&&ch.issue.code?{ code:ch.issue.code, url:ch.issue.url }:null, pr:ch&&ch.pr?{ num:ch.pr.num, url:ch.pr.url }:null,
      reqs:entReqs(t), provas:entProvas.m?(entProvas.m[t.id]||0):0, imgs:diaImgs(t.id).slice(0,3).map(a=>({ nome:a.name, path:a.storage_path })),
      ts:x.ts, dia:diaRotulo(x.ts), tipo:x.tipo, mod:x.mod, custo:+t.cost_usd||0 }; });
  const epIds=[...new Set(itens.map(x=>x.epicoId).filter(Boolean))];
  const epicos=epIds.filter(id=>epName(id)).map(id=>{ const n=entNums(c.all.filter(t=>t.epic_id===id), ENT_FN); return { id, nome:epName(id), ent:n.ent, tot:n.tot }; });
  const lb=t=>typeof ctStLabel==='function'?ctStLabel(t):stLabel(tsSt(t));
  const f=c.f||{};
  const filtros=[f.who?'pessoa: '+(f.who==='-'?'sem dono':personName(f.who,{ noYou:true })):'', f.epic?'épico: '+(f.epic==='-'?'sem épico':epName(f.epic)||'épico'):''].filter(Boolean).join(' · ');
  return {
    periodo:periodLabel(c.per), de:dd(r.from), ate:dd(r.to-1), escopo:c.escopo||'', filtros,
    geradoEm:new Date().toLocaleString('pt-BR',{ day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }),
    itens, epicos, semData:ent.filter(x=>!x.ts && periodHas(r, x.mod)).length,
    travadas:pe.filter(t=>entTravada(t, ENT_FN)).map(t=>({ titulo:t.title||'tarefa', quem:dono(t), motivo:(typeof entTravaTx==='function'?entTravaTx(t):entMotivo(t, lb(t))), epico:epName(t.epic_id), mod:ENT_FN.mod(t) })),
    prontas:pe.filter(t=>entPronta(t, ENT_FN)).map(t=>{ const ch=chainOfNow(t); return { titulo:t.title||'tarefa', quem:dono(t), epico:epName(t.epic_id), pr:ch&&ch.pr?{ num:ch.pr.num, url:ch.pr.url }:null, mod:ENT_FN.mod(t) }; }),
    fila:pe.filter(t=>t.epic_id && tsBucket(t)==='fila' && !ENT_FN.delivered(t) && !entFora(t, ENT_FN)).map(t=>({ titulo:t.title||'tarefa', quem:dono(t), epico:epName(t.epic_id)||'épico', mod:ENT_FN.mod(t) })),
    custo:entPodeVerCusto()?itens.reduce((s,x)=>s+x.custo,0):null,
  };
}
let relAtual=null; // { m, d, data:{ path:dataURI } }
let relGerando=false;
async function relGerar(btn, c){
  c=c||(typeof entUltimo==='function'?entUltimo():null); if(!c || relGerando) return;
  relGerando=true;
  const old=btn?btn.innerHTML:''; if(btn){ btn.disabled=true; btn.textContent='montando o relatório…'; }
  try{
    const pe=c.pe||entFiltra(c.all, { who:c.f.who, epic:c.f.epic }, ENT_FN);
    // os MESMOS lotes da aba: carimbos de entrega (72) e provas (70) — espera os dois terminarem
    await Promise.all([diaStampsLoad(pe.filter(ENT_FN.delivered).map(t=>t.id), c.range), entProvasLoad(c.all.map(t=>t.id))]);
    if(diaSt.err) throw new Error('não consegui ler as datas de entrega agora — tente de novo em instantes');
    await personEnsure([...new Set(pe.flatMap(t=>[t.assignee, t.created_by]).filter(Boolean))]);
    const d=relDados(c, pe);
    if(entProvas.err) d.avisoProvas=true;
    relAbrir({ m:relMonta(d), d, data:{} });
  }catch(e){ showErr(e, 'Não consegui montar o relatório'); }
  finally{ relGerando=false; if(btn && btn.isConnected){ btn.disabled=false; btn.innerHTML=old; } }
}
function relAbrir(rep){
  relAtual=rep; const id='relent';
  let tab=tabById(id);
  if(!tab){ tab={ id, kind:'relent', title:'Relatório de entregas' }; TABS.push(tab); }
  tab.rep=rep;
  activateTab(id);
}
function relOpenInner(tab){
  if(tab&&tab.rep) relAtual=tab.rep;
  const o=$id('relEntOverlay'); if(!o) return;
  o.style.display='flex';
  relRender();
}
window.relOpenInner=relOpenInner;
function relPaths(rep){ rep=rep||relAtual; return rep?[].concat(...rep.d.itens.map(x=>(x.imgs||[]).map(i=>i.path))):[]; }
function relRender(){
  const main=$id('relEntMain'); if(!main || !relAtual) return;
  const m=relAtual.m, sc=main.closest('.fw')||main, top=sc.scrollTop;
  const right=`<span class="rl-acts"><button type="button" class="btn sm" id="relMd" title="copia o relatório em Markdown (cola no chat, na issue ou no e-mail)">copiar Markdown</button><button type="button" class="btn sm" id="relHtmlB" title="um arquivo .html só, com as provas dentro e sem script — abre em qualquer navegador">salvar HTML</button></span>`;
  main.innerHTML=pageHead({ title:'Relatório de entregas', sub:'Prévia do documento — exporte em PDF, copie em Markdown ou salve como HTML. Gerado neste computador; nada sobe pra nuvem.', right, primary:{ id:'relPdf', label:'exportar PDF', icon:'doc', title:'gera o PDF neste computador (nada sobe pra nuvem) e pergunta onde salvar' } })
    +`<div class="rl-wrap">${relAtual.d.avisoProvas?'<div class="en-note" role="status">não consegui ler as provas agora — o relatório saiu sem as miniaturas</div>':''}<article class="rl-doc rl-app">${relCorpoHtml(m, p=>(diaUrl[p]||{}).u||'')}</article></div>`;
  sc.scrollTop=top;
  const ps=relPaths(); if(ps.some(p=>!diaUrl[p])) Promise.resolve(diaThumbsLoad(ps)).then(()=>{ if(relAtual && $id('relEntMain')===main) relRender(); });
  main.querySelectorAll('.rl-doc a[href]').forEach(a=>{ a.onclick=(e)=>{ e.preventDefault(); const u=a.getAttribute('href')||''; if(/^https?:\/\//i.test(u)) openExternal(u); }; });
  bindClick('relMd', async function(){ await cloudCopy(relMarkdown(relAtual.m), this); });
  bindClick('relHtmlB', function(){ relSalvar(this, 'html'); });
  bindClick('relPdf', function(){ relSalvar(this, 'pdf'); });
}
// miniaturas → data: (reduzidas a 480 px de largura, JPEG) pro arquivo autocontido; falhou → o item sai sem imagem
// (sem guardar a falha: a próxima exportação tenta de novo). Teto de 90 imagens por relatório.
const REL_MAX_IMGS=90;
async function relDataUris(rep){
  const ps=[...new Set(relPaths(rep))].slice(0, REL_MAX_IMGS).filter(p=>!rep.data[p]);
  if(ps.some(p=>!diaUrl[p] || !diaUrl[p].u)) await diaThumbsLoad(ps);
  for(const p of ps){
    let bm=null;
    try{
      const u=(diaUrl[p]||{}).u; if(!u) continue;
      const b=await (await fetch(u)).blob(); bm=await createImageBitmap(b);
      const w=Math.min(480, bm.width), h=Math.round(bm.height*w/bm.width), cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(bm, 0, 0, w, h); rep.data[p]=cv.toDataURL('image/jpeg', .82);
    }catch(e){ console.warn('prova no relatório', e&&e.message||e); }
    finally{ try{ if(bm) bm.close(); }catch(_){ } }
  }
}
async function relSalvar(btn, ext){
  const rep=relAtual; if(!rep || btn.disabled) return; // o relatório da TELA no clique (um novo não troca o arquivo no meio)
  const old=btn.innerHTML; btn.disabled=true; btn.textContent=ext==='pdf'?'gerando o PDF…':'salvando…';
  try{
    await relDataUris(rep);
    const html=relHtml(rep.m, { css:REL_CSS, src:p=>rep.data[p]||'' });
    const nome=relNome(rep.d);
    const path=ext==='pdf'?await invoke('relatorio_pdf', { nome, html }):await invoke('relatorio_salvar', { nome, ext:'html', conteudo:html });
    if(path) toast((ext==='pdf'?'PDF salvo: ':'HTML salvo: ')+String(path).split(/[\\/]/).pop(), 'ok', { label:(typeof osKind!=='function'||osKind()==='mac')?'Mostrar no Finder':'Abrir a pasta', fn:()=>invoke('relatorio_mostrar', { path }).catch(e=>showErr(e, 'Não consegui abrir a pasta')) });
  }catch(e){
    // sem PDF nativo (Windows/Linux ou o macOS recusou): o HTML autocontido abre em qualquer navegador e imprime em PDF
    if(ext==='pdf') toast('Não consegui gerar o PDF: '+((typeof humanErr==='function'&&humanErr(e,'').msg)||String(e&&e.message||e)), 'err', { label:'salvar como HTML', fn:()=>relSalvar($id('relHtmlB')||btn, 'html') });
    else showErr(e, 'Não consegui salvar o relatório');
  }
  finally{ btn.disabled=false; btn.innerHTML=old; }
}
window.relGerar=relGerar;
