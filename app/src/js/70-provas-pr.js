// Starfork — 70-provas-pr: PROVAS NO PR (prints e vídeos de prova visíveis no GitHub)
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
const provasPr={}; // taskId → { links, note, sig, at, failed? }
const provasBusy=new Set();
function provasOf(id){
  if(provasPr[id]) return provasPr[id];
  try{ const v=JSON.parse(lsGet('provasPr:'+id)||'null'); if(v&&v.links){ provasPr[id]=v; return v; } }catch(_){ }
  return null;
}
function provasSave(id, v){ provasPr[id]=v; lsSet('provasPr:'+id, JSON.stringify(v)); return v; }
function provasSig(t){ return provasSigOf(typeof reqRows==='function'?reqRows(t):[]); }
// sobe as provas da tarefa (rede: comando async). ask=true → pode perguntar do repositório público (fluxo de abrir o PR)
async function provasAttach(t, o){
  o=o||{};
  const sig=provasSig(t);
  if(!sig) return provasSave(t.id, { links:{}, note:'', sig:'', at:Date.now() });
  if(provasBusy.has(t.id)) return provasOf(t.id)||{ links:{}, note:'' };
  provasBusy.add(t.id);
  try{
    let r=await invokeQuiet('pr_attach_proofs',{ taskId:t.id });
    if(r && r.needConfirm && o.ask){
      const yes=await askYes(provasAskText(r.visibility), 'Provas no PR');
      r=await invokeQuiet('pr_attach_proofs',{ taskId:t.id, decide:yes?'on':'off' });
      if(yes && r && Object.keys(r.links||{}).length) toast('Provas anexadas ao PR (branch starfork-provas)','ok');
    }
    return provasSave(t.id, { links:(r&&r.links)||{}, note:(r&&r.note)||'', sig, at:Date.now(), failed:/^não consegui anexar/.test((r&&r.note)||'') });
  }catch(e){
    return provasSave(t.id, { links:{}, note:'não consegui anexar as provas ('+errFirstLine(errText(e)).slice(0,140)+')', sig, at:Date.now(), failed:true });
  }finally{ provasBusy.delete(t.id); }
}
// reescreve a seção "## Relatório Starfork" do PR aberto com o relatório desta tela (inclui o "aprovado sem prova" daqui)
async function provasPushReport(t){
  const rep=(typeof cicloReportFor==='function')?cicloReportFor(t).trim():'';
  if(!rep) return;
  try{ await invokeQuiet('pr_update_report',{ taskId:t.id, report:rep }); if(typeof prCache!=='undefined') prCache[t.id]=undefined; }
  catch(e){ if(window.logAppError) window.logAppError('invoke:pr_update_report', e); }
}
// aba PR (PR aberto): provas novas → sobem e o relatório do PR é reescrito. Sem pergunta: repositório público
// sem decisão espera a pessoa (a nota no relatório diz isso; "abrir o PR" pergunta).
// Devolve true só quando sincronizou (quem chama repinta) — o render chama isto a cada poll: o caminho comum é sair cedo.
async function provasSyncOpenPr(t){
  if(!t || provasBusy.has(t.id)) return false;
  const sig=provasSig(t);
  if(!provasNeedSync(provasOf(t.id), sig, Date.now())) return false;
  const v=await provasAttach(t);
  if(Object.keys(v.links||{}).length || v.note) await provasPushReport(t);
  return true;
}
// ---- Projeto › Regras › Provas no PR (opção do projeto, no .git/config: starfork.provasNoPr) ----
async function provasPrefsRender(repo){
  const h=$id('prefsProvasHost'); if(!h) return;
  let cur=''; try{ cur=String(await invokeQuiet('provas_setting',{ value:null })||''); }catch(_){ }
  const on=cur!=='off';
  h.innerHTML=`<label class="ajsw"><input type="checkbox" role="switch" id="provasSw"${on?' checked':''}><span class="ajsw-t" aria-hidden="true"></span><span class="ajsw-l">Mostrar as provas no PR</span></label>
    <div class="dim" style="font-size:var(--fs-xs);margin-top:6px">Os prints e vídeos que provam cada requisito aparecem como miniatura no PR do GitHub. Ficam no branch <span class="mono">starfork-provas</span> do repositório, fora do código. ${cur===''?'Em repositório <b>público</b> o Starfork pergunta uma vez antes de publicar.':cur==='on'?'Ligado também em repositório público.':''}</div>`;
  const sw=$id('provasSw');
  if(sw) sw.onchange=async()=>{
    try{ await invoke('provas_setting',{ value:sw.checked?'on':'off' }); toast(sw.checked?'Provas no PR ligadas neste projeto':'Provas no PR desligadas — o PR mostra só os nomes', 'ok'); provasPrefsRender(repo); }
    catch(e){ sw.checked=!sw.checked; showErr(e, 'Não salvou'); }
  };
}
