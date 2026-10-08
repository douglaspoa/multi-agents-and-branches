// Starfork — 60-provas-pr: PROVAS NO PR (prints e vídeos de prova visíveis no GitHub)
// Fonte única do upload: o motor (src/pr-provas.ts → CLI `pr-provas` → comando pr_attach_proofs). As provas vão pro
// branch ÓRFÃO `starfork-provas` do próprio repositório (pasta <tarefa>/), nunca pro branch da tarefa.
// Aqui: (1) pergunta UMA vez por projeto (askYes) quando o repositório é PÚBLICO; (2) guarda os links pro Relatório
// Starfork (cicloReportFor → miniaturas na tabela Requisito × Prova); (3) na aba PR, provas novas depois da abertura
// sobem sozinhas e a seção do relatório no corpo do PR é reescrita (pr_update_report). Falha nunca bloqueia o PR:
// o relatório volta pra lista de nomes e diz "não consegui anexar as provas (motivo)".
// Limpeza: integrar/fechar a tarefa NÃO apaga as provas — o PR mergeado continua mostrando as imagens.
// @provas-puro-inicio (testado em app/tests/provas-pr.test.mjs — sem DOM)
const PROVAS_MEDIA=/\.(png|jpe?g|gif|webp|mp4|mov)$/i;
// assinatura das provas que existem agora (requisito provado + arquivo de imagem/vídeo): mudou → sobe de novo
function provasSigOf(rows){ return (rows||[]).filter(r=>r.st==='ok').flatMap(r=>r.evidence||[]).map(String).filter(e=>PROVAS_MEDIA.test(e)).sort().join('|'); }
function provasAskText(vis){
  return (vis==='PUBLIC'
    ? 'Publicar os prints de prova neste PR?\n\nEste repositório é PÚBLICO: qualquer pessoa na internet vai ver as imagens (ficam no branch starfork-provas). Prints podem mostrar dados de clientes, e-mails ou caminhos do seu computador — confira as provas antes.'
    : 'Publicar os prints de prova neste PR?\n\nNão deu pra confirmar se o repositório é privado. Se ele for público, qualquer pessoa vai ver as imagens (branch starfork-provas).')
    +'\n\nA resposta vale pra este projeto — dá pra trocar em Projeto › Regras › Provas no PR.';
}
// sincroniza de novo? assinatura nova, ou a última tentativa falhou há mais de 10 min (rede) — nunca em loop
function provasNeedSync(cur, sig, now){ if(!sig) return false; if(!cur||cur.sig!==sig) return true; return !!cur.failed && now-(cur.at||0)>10*60000; }
// @provas-puro-fim
const provasPr={}; // taskId → { links, note, sig, at, failed?, needConfirm? }
const provasBusy=new Map(); // taskId → Promise em voo (uma subida por tarefa; quem chega espera a mesma)
function provasOf(id){
  if(provasPr[id]) return provasPr[id];
  try{ const v=JSON.parse(lsGet('provasPr:'+id)||'null'); if(v&&v.links){ provasPr[id]=v; return v; } }catch(_){ }
  return null;
}
function provasSave(id, v){ provasPr[id]=v; lsSet('provasPr:'+id, JSON.stringify(v)); return v; }
// a opção do projeto mudou: esquece o que foi sincronizado (a aba PR sobe de novo, ou volta pra lista de nomes)
function provasResetAll(){
  for(const k of Object.keys(provasPr)) delete provasPr[k];
  try{ for(let i=localStorage.length-1;i>=0;i--){ const k=localStorage.key(i); if(k&&k.startsWith('provasPr:')) localStorage.removeItem(k); } }catch(_){ }
}
function provasSig(t){ return provasSigOf(typeof reqRows==='function'?reqRows(t):[]); }
function provasPrUrl(t){ const c=(typeof prCache!=='undefined'&&prCache[t.id])||null; return (c&&c.url)||t.prUrl||((t.spec||{}).prUrl)||''; }
// sobe as provas da tarefa (rede: comando async). ask=true → pode perguntar do repositório público (abrir o PR / botão)
async function provasAttach(t, o){
  o=o||{};
  const sig=provasSig(t);
  if(!sig) return provasSave(t.id, { links:{}, note:'', sig:'', at:Date.now() });
  // já subindo (aba PR): espera a mesma; quem pode perguntar refaz depois se ficou pendente de decisão
  if(provasBusy.has(t.id)){ const v=await provasBusy.get(t.id).catch(()=>null); if(!(o.ask && v && v.needConfirm)) return v||provasOf(t.id)||{ links:{}, note:'' }; }
  const p=(async()=>{
    try{
      let r=await invokeQuiet('pr_attach_proofs',{ taskId:t.id });
      if(r && r.needConfirm && o.ask){
        const yes=await askYes(provasAskText(r.visibility), 'Provas no PR');
        r=await invokeQuiet('pr_attach_proofs',{ taskId:t.id, decide:yes?'on':'off' });
        if(yes && r && Object.keys(r.links||{}).length) toast('Provas anexadas ao PR (branch starfork-provas)','ok');
      }
      const note=(r&&r.note)||'';
      return provasSave(t.id, { links:(r&&r.links)||{}, note, sig, at:Date.now(), failed:/^não consegui anexar/.test(note), needConfirm:!!(r&&r.needConfirm) });
    }catch(e){
      return provasSave(t.id, { links:{}, note:'não consegui anexar as provas ('+errFirstLine(errText(e)).slice(0,140)+')', sig, at:Date.now(), failed:true });
    }
  })();
  provasBusy.set(t.id, p);
  try{ return await p; }finally{ if(provasBusy.get(t.id)===p) provasBusy.delete(t.id); }
}
// reescreve a seção "## Relatório Starfork" do PR aberto com o relatório desta tela (inclui o "aprovado sem prova" daqui)
async function provasPushReport(t, url){
  const rep=(typeof cicloReportFor==='function')?cicloReportFor(t).trim():'';
  if(!rep) return false;
  try{ await invokeQuiet('pr_update_report',{ taskId:t.id, report:rep, url:url||provasPrUrl(t)||null }); if(typeof prCache!=='undefined') prCache[t.id]=undefined; return true; }
  catch(e){ if(window.logAppError) window.logAppError('invoke:pr_update_report', e); return false; }
}
// aba PR (PR aberto): provas novas → sobem e o relatório do PR é reescrito. Sem pergunta aqui: repositório público
// sem decisão mostra o botão "publicar as provas…" (provasConfirmHtml) — a pergunta só sai com o clique da pessoa.
// Devolve true só quando sincronizou (quem chama repinta) — o render chama isto a cada poll: o caminho comum é sair cedo.
async function provasSyncOpenPr(t){
  if(!t || provasBusy.has(t.id)) return false;
  const sig=provasSig(t);
  if(!provasNeedSync(provasOf(t.id), sig, Date.now())) return false;
  const v=await provasAttach(t);
  if(Object.keys(v.links||{}).length || v.note) await provasPushReport(t);
  return true;
}
// aba PR: repositório público esperando decisão → botão que pergunta (askYes) e, com sim, sobe e reescreve o relatório
function provasConfirmHtml(t){
  const v=provasOf(t.id);
  return v&&v.needConfirm ? `<div class="prvout"><b>Provas fora do PR:</b> ${esc(v.note)} <button type="button" class="btn sm" onclick="provasConfirm('${escA(t.id)}')">publicar as provas…</button></div>` : '';
}
async function provasConfirm(id){
  const t=(state.tasks||[]).find(x=>x.id===id); if(!t) return;
  const v=await provasAttach(t, { ask:true });
  if(Object.keys(v.links||{}).length || !v.needConfirm) await provasPushReport(t);
  lastSig='';
}
// ---- Projeto › Regras › Provas no PR (opção do projeto, no .git/config: starfork.provasNoPr) ----
const PROVAS_OPTS=[
  ['ask','Ligado — pergunta em repositório público','PADRÃO','Em repositório privado as provas aparecem no PR. Em repositório público o Starfork pergunta uma vez antes de publicar (prints podem mostrar dados).'],
  ['on','Ligado sempre','','As provas aparecem no PR também em repositório público — qualquer pessoa vê as imagens.'],
  ['off','Desligado','','O PR mostra só os nomes das provas. O que já foi publicado continua no branch starfork-provas.'],
];
async function provasPrefsRender(repo){
  const h=$id('prefsProvasHost'); if(!h) return;
  let cur=''; try{ cur=String(await invokeQuiet('provas_setting',{ value:null })||''); }catch(_){ }
  const sel=cur||'ask';
  h.innerHTML=`<div class="protopts" id="provasOpts">${PROVAS_OPTS.map(([v,l,rec,d])=>`<label class="howopt${v===sel?' on':''}"><input type="radio" name="provasmode" value="${v}"${v===sel?' checked':''}><span><span class="ht">${l}${rec?` <span class="rec">${rec}</span>`:''}</span><div class="hd">${d}</div></span></label>`).join('')}</div>
    <div class="dim" style="font-size:var(--fs-xs);margin-top:6px">Mostrar as provas no PR: os prints e vídeos que provam cada requisito aparecem como miniatura no PR do GitHub. Ficam no branch <span class="mono">starfork-provas</span> do repositório, fora do código, e continuam lá depois de integrar (o PR antigo segue mostrando as imagens). Vale neste computador, pra este projeto.</div>`;
  h.querySelectorAll('input[name="provasmode"]').forEach(r=>r.onchange=async()=>{
    try{ await invoke('provas_setting',{ value:r.value }); provasResetAll(); toast(r.value==='off'?'Provas no PR desligadas — o PR mostra só os nomes':r.value==='on'?'Provas no PR ligadas, inclusive em repositório público':'Provas no PR: pergunta em repositório público','ok'); }
    catch(e){ showErr(e, 'Não salvou'); }
    provasPrefsRender(repo);
  });
}
