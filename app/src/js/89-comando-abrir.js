// COMANDO · ABRIR NO PRÓPRIO STARFORK (26/11): "abre o código que ele editou", "abre a imagem da prova", "abre o
// ambiente". O agente abre a coisa numa ABA do Starfork — o código na aba da tarefa (modo Código, no arquivo), o que
// foi entregue (imagem, PDF, vídeo, documento) na aba Documento e o ambiente/simulador nas abas do canvas. Vira a aba da vez (ou divide a
// tela, quando a aba aberta aceita dividir). Nada abre fora do app.
const CMD_ABRIR=new Set(['abrir_codigo','abrir_entrega','abrir_ambiente','abrir_simulador']);

// @abrir-puro-inicio
const cmdAbrirN=x=>String(x||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
/** tipo de um entregável pelo nome. Puro. */
function cmdAbrirTipo(nome){ const n=cmdAbrirN(nome); return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(n)?'imagem':/\.(mp4|mov|webm|m4v)$/.test(n)?'vídeo':/\.pdf$/.test(n)?'pdf':/\.html?$/.test(n)?'página':'documento'; }
/**
 * Escolhe entre `itens` (cada um com um nome/caminho em `nomeDe`) o que a pessoa pediu em `q`. Puro.
 * → { um } | { varios } | { nenhum:true }. Sem `q`: um só item = ele; vários = a lista.
 */
function cmdAbrirEscolhe(itens, nomeDe, q){
  const L=(itens||[]).filter(Boolean), n=cmdAbrirN(q).replace(/["'`]/g,'').trim();
  if(!L.length) return { nenhum:true };
  if(!n || /^(todos|todas|tudo|qualquer|o codigo|codigo|arquivo|a imagem|imagem|imagens|a prova|prova|provas|print|prints)$/.test(n)) return L.length===1?{ um:L[0] }:{ varios:L };
  const nome=x=>cmdAbrirN(nomeDe(x)), base=x=>nome(x).split('/').pop();
  const ex=L.filter(x=>nome(x)===n || base(x)===n); if(ex.length===1) return { um:ex[0] };
  const pa=L.filter(x=>nome(x).includes(n)); if(pa.length===1) return { um:pa[0] }; if(pa.length>1) return { varios:pa };
  const toks=n.split(/[^a-z0-9]+/).filter(w=>w.length>=3); if(!toks.length) return { nenhum:true };
  const sc=L.map(x=>({ x, s:toks.filter(w=>nome(x).includes(w)).length })).filter(o=>o.s>0).sort((a,b)=>b.s-a.s);
  if(!sc.length) return { nenhum:true };
  return (sc.length===1 || sc[0].s>sc[1].s)?{ um:sc[0].x }:{ varios:sc.filter(o=>o.s===sc[0].s).map(o=>o.x) };
}
/** Do pedido ("as imagens", "o pdf", "o vídeo") → o tipo que a pessoa quer, ou ''. Puro. */
function cmdAbrirQuer(q){ const n=cmdAbrirN(q); return /\b(imagem|imagens|print|prints|foto|fotos|screenshot|tela|telas)\b/.test(n)?'imagem':/\bvideo|gravac/.test(n)?'vídeo':/\bpdf\b/.test(n)?'pdf':''; }
/** arquivos de código que vale abrir: o que a tarefa mudou, do mais mexido pro menos; fora .cardume e lock. Puro. */
function cmdAbrirCodigos(files){ return (files||[]).filter(f=>f && f.path && !/^\.cardume\//.test(f.path) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/.test(f.path))
  .sort((a,b)=>((+b.add||0)+(+b.del||0))-((+a.add||0)+(+a.del||0))); }
// @abrir-puro-fim

/** abre uma aba do canvas */
function cmdAbrirAba(desc){ if(typeof cvOpenTop!=='function') return false;
  // dividir a tela só quando a aba da vez aceita (demanda, navegador, simulador, documento) — do Comando ela abre como a aba da vez, sem aviso de "não divide"
  let lado=false; try{ lado=typeof cvSplitable==='function' && typeof cvTabOf==='function' && typeof activeTab!=='undefined' && cvSplitable(cvTabOf(activeTab)); }catch(_){ }
  try{ cvOpenTop(desc, lado?{ split:'right' }:{}); return true; }catch(e){ console.warn('comando: não abri a aba', e); return false; } }

async function cmdAbrirDo(p, x, say){
  const code=x.code||x.ref||'a tarefa', q=String(p.alvo||p.texto||'').trim();
  try{
    if(p.acao==='abrir_codigo'){
      let files=[]; try{ files=await invoke('task_files',{ taskId:x.id })||[]; }catch(e){ return say('Não consegui ler os arquivos da '+code+': '+String((e&&e.message)||e).slice(0,160)); }
      const cods=cmdAbrirCodigos(files); if(!cods.length) return say('A '+code+' ainda não alterou nenhum arquivo de código.');
      // sem dizer qual: abre o mais mexido (é "o código que ele editou") e conta os outros
      const r=q?cmdAbrirEscolhe(cods, f=>f.path, q):{ um:cods[0] };
      if(r.nenhum) return say('A '+code+' não mexeu em nenhum arquivo parecido com “'+q+'”. Ela alterou: '+cods.slice(0,8).map(f=>f.path).join(', ')+(cods.length>8?' e mais '+(cods.length-8):'')+'.');
      if(r.varios && r.varios.length>1) return say('Qual deles? A '+code+' alterou '+r.varios.length+' arquivos assim: '+r.varios.slice(0,8).map(f=>f.path).join(', ')+'.');
      const f=r.um||r.varios[0]; openWorkspace(x.id, f.path);
      const outros=cods.filter(o=>o!==f).slice(0,5).map(o=>o.path);
      return say('Abri '+f.path+' da '+code+' no Starfork (+'+(+f.add||0)+' −'+(+f.del||0)+').'+(!q && outros.length?' Ela também alterou: '+outros.join(', ')+(cods.length>6?' e mais '+(cods.length-6):'')+'.':''));
    }
    if(p.acao==='abrir_entrega'){
      const t=cmdTask(x.id); if(typeof loadArtifacts==='function'){ try{ await loadArtifacts(x.id, t&&t.status); }catch(_){ } }
      let arts=(t && typeof entregaArts==='function')?entregaArts(t):[]; arts=arts.filter(a=>a && a.name);
      if(!arts.length) return say('A '+code+' ainda não entregou nenhuma imagem, documento ou vídeo.');
      const quer=cmdAbrirQuer(q); let lista=arts;
      if(quer){ lista=arts.filter(a=>cmdAbrirTipo(a.name)===quer); if(!lista.length) return say('A '+code+' não entregou '+(quer==='imagem'?'nenhuma imagem':quer==='pdf'?'nenhum PDF':'nenhum vídeo')+'. O que ela entregou: '+arts.slice(0,8).map(a=>a.name).join(', ')+'.'); }
      const r=cmdAbrirEscolhe(lista, a=>a.name, quer?'':q);
      if(r.nenhum) return say('A '+code+' não entregou nada parecido com “'+q+'”. O que ela entregou: '+arts.slice(0,8).map(a=>a.name).join(', ')+'.');
      // "abre as imagens": abre a primeira ao lado e diz quais são as outras (cada uma é uma aba; não abro dez de uma vez)
      const um=r.um||r.varios[0], resto=(r.varios||[]).filter(a=>a!==um);
      if(!cmdAbrirAba({ kind:'doc', taskId:x.id, ref:'art:'+um.name })){ if(typeof openArtifact==='function') openArtifact(x.id, um.name); else return say('Não consegui abrir '+um.name+' aqui.'); }
      return say('Abri '+um.name+' ('+cmdAbrirTipo(um.name)+') da '+code+' no Starfork.'+(resto.length?' Tem mais '+resto.length+': '+resto.slice(0,6).map(a=>a.name).join(', ')+'. Diga qual quer ver.':''));
    }
    if(p.acao==='abrir_ambiente'){ return say(cmdAbrirAba({ kind:'web', taskId:x.id, app:true })?'Abri o ambiente da '+code+' numa aba do Starfork. Se ele ainda não estiver no ar, a aba mostra como subir.':'Não consegui abrir a aba do ambiente da '+code+'.'); }
    if(p.acao==='abrir_simulador'){ return say(cmdAbrirAba({ kind:'device', taskId:x.id })?'Abri o simulador da '+code+' numa aba do Starfork.':'Não consegui abrir o simulador da '+code+'.'); }
  }catch(e){ say('Não deu: '+String((e&&e.message)||e).slice(0,200)); }
}
