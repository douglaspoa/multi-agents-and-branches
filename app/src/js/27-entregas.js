// Starfork — 27-entregas: card de demanda (Execução/Concluídas), aba ENTREGA da demanda
// (objetivo · entregáveis com provas · documentos · linha do tempo), lightbox dos prints,
// relatório da entrega e relatório do período (IA), tudo em cima do que o app já guarda.
const TASK_DONE_ST=['merged','done'];
function taskIsDone(t){ return !!t && (t.flag==='closed' || TASK_DONE_ST.includes(t.status)); }
function prNumOf(t){ return (String((t&&t.prUrl)||'').match(/\/pull\/(\d+)/)||[])[1]||''; }
function agoShort(ms){ const s=(Date.now()-ms)/1000; if(!(s>=0)) return ''; if(s<60) return 'agora'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
// duração desconhecida (sem eventos) = '' — nunca "0 min" como se a tarefa não tivesse levado tempo
function fmtDurKnown(ms){ return ms>0?fmtDurMs(ms):''; }
function fmtDurMs(ms){ ms=Math.max(0,ms||0); const m=Math.round(ms/60000); if(m<60) return m+' min'; const h=Math.floor(m/60); return h<48?`${h}h${String(m%60).padStart(2,'0')}`:Math.round(h/24)+' dias'; }
function taskDurationMs(t){ const evs=eventsOf(t.id); const last=evs.length?+new Date(evs[evs.length-1].ts):0; const a=taskTs(t); return last&&a?last-a:0; }
// ---- requisitos com estado de prova (mesma regra do resumo/lateral) ----
function reqRows(t){
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  const c=reqProofCache[t.id];
  const m=matchReqProofs(reqs, c&&c.list);
  return reqs.map((r,i)=>{ const p=m[i]; const st=p?(p.status==='done'?'ok':'blk'):'na'; return { text:r, st, evidence:(p&&Array.isArray(p.evidence))?p.evidence:[], note:(p&&p.note)||'' }; });
}
// nome AMIGÁVEL do modelo pros cards do quadro: "claude-sonnet-4-5" → "Sonnet 4.5"; id que não dá pra
// traduzir some do card (o id cru continua no cabeçalho da tarefa e no tooltip)
function boardModelName(id){
  if(!id) return '';
  const n=(typeof aiModelName==='function')?aiModelName(id):id;
  if(n && n!==id) return n;
  const m=String(id).match(/(opus|sonnet|haiku)(?:[-_ ](\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?)?/i);
  if(m) return m[1].charAt(0).toUpperCase()+m[1].slice(1).toLowerCase()+(m[2]?' '+m[2]+(m[3]?'.'+m[3]:''):'');
  return /^[a-z]+$/i.test(id) ? id : ''; // apelido curto (ex.: "opus") passa; id técnico longo não
}
// R5-9: nome amigável SEMPRE (menus/cabeçalhos): "claude-sonnet-4-5" → "Sonnet 4.5"; sem modelo = padrão da assinatura;
// o id cru fica pro tooltip de quem chama
function modelFriendly(id){ if(!id) return 'padrão da assinatura'; return boardModelName(id)||((typeof aiModelName==='function')?aiModelName(id):id); }
// ---- CARD DE DEMANDA (lista da Central: Execução e Concluídas) ----
function flowDemandCard(t){
  const asking=pendingOf(t.id);
  const done=taskIsDone(t);
  const ph=taskPhase(t), pct=taskPct(t);
  const dot= asking.length||t.status==='plan-review'?'var(--warn)' : ['error','conflict'].includes(t.status)?'var(--crit)' : (ACTIVE_ST.has(t.status)||t.status==='thinking')?'var(--good)' : ['review','delivered'].includes(t.status)?'var(--warn)' : done?'var(--info)':'var(--muted)';
  const ev=lastEventOf(t.id);
  const prN=prNumOf(t);
  const proj=t.proj||pathBase(state.repo);
  const ty=taskType(t);
  if(reqProofCache[t.id]===undefined) loadReqProofs(t.id).then(flowRerenderSoon);
  const rows=reqRows(t);
  const okN=rows.filter(r=>r.st==='ok').length;
  const reqsHtml = rows.length ? `<div class="dc-reqs">${rows.slice(0,4).map(r=>`<span class="dc-req ${r.st}"><i>${r.st==='ok'?IC.ok:r.st==='blk'?IC.stErr:''}</i><span class="dc-rt">${esc(r.text)}</span></span>`).join('')}${rows.length>4?`<span class="dc-more">+${rows.length-4}</span>`:''}</div>` : '';
  const msg= asking.length ? `<b>${esc(asking[0].agent||t.agent)} perguntou</b> — ${esc((asking[0].prompt||'').slice(0,90))}`
    : t.status==='plan-review' ? 'plano pronto — aprove pra continuar'
    : t.status==='draft' ? 'rascunho — clique pra editar'
    : done ? (prN?`PR #${prN} integrado`:'concluída')
    : (t.prUrl&&prN) ? `PR #${prN} aguardando aprovação`
    : ['review','delivered'].includes(t.status) ? `pronta pra revisar${(n=>n>0?' · '+nPl(n,'arquivo'):'')(diffFiles(diffOf(t.id)))}`
    // E1: erro conhecido do motor/gh vira frase em pt-BR (antes: "spawn claude ENOENT", "Please run /login"…)
    : (t.status==='error' && ev && humanErr(ev.text).id!=='generic') ? `<b style="color:var(--crit)">${esc(humanErr(ev.text).msg)}</b>`
    : ev ? `${esc(ev.agent||t.agent)} — ${esc(String(ev.text||'').slice(0,90))}` : 'iniciando…';
  const artC=artifactsCache[t.id];
  if(done && (!artC||artC.status!==t.status)) loadArtifacts(t.id, t.status).then(flowRerenderSoon);
  const arts=(artC&&artC.list||[]).filter(a=>a.name!=='requirements.json');
  const nImg=arts.filter(a=>a.kind==='image'||a.kind==='video').length, nDoc=arts.filter(a=>/\.(md|txt|pdf|html?)$/i.test(a.name)).length;
  const readyPr=['review','delivered'].includes(t.status);
  const artOnly=['invest','design'].includes(ty)||entregaNonCode(t); // FT-6: entrega só de documentos também não abre PR
  const primary = t.status==='conflict' ? `<button class="btn primary sm" data-resolveconf="${escA(t.id)}" title="a IA junta a base na branch e resolve os conflitos na worktree; você revisa e integra">${IC.bolt} resolver conflito</button>`
    : t.status==='draft' ? `<button class="btn primary sm" data-rowplay="${escA(t.id)}">${IC.play} iniciar</button>`
    : asking.length ? `<button class="btn primary sm" data-dcopen="${escA(t.id)}">responder</button>`
    : (!done && !t.prUrl && readyPr) ? (artOnly?`<button class="btn primary sm" data-dcopen="${escA(t.id)}" title="confira a prévia dos arquivos e salve na sua pasta">${IC.ok} ver e salvar</button>`
      // portão de prova (21): requisito sem prova → o verde pede a prova; aprovar vira o secundário com motivo
      : proofGate(t).st==='unproven' ? `<button class="btn sm ghost" data-rownoproof="${escA(t.id)}" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar sem prova…</button><button class="btn primary sm" data-rowproof="${escA(t.id)}" title="${escA(proofMissingTip(proofGate(t)))}">${IC.ai} pedir a prova ao agente</button>`
      : `<button class="btn primary sm" data-rowpr="${escA(t.id)}">${IC.merge} aprovar e abrir PR</button>`)
    : (done ? `<button class="btn sm" data-dcopen="${escA(t.id)}">ver entrega</button>` : '');
  const segs=[1,2,3,4,5].map(i=>`<i class="${i<=ph?((asking.length&&i===ph)?'on warn':'on'):''}"></i>`).join('');
  const foot = done
    ? `<span class="dc-meta">${prN?`<span class="dc-pr" data-lk="${escA(t.prUrl)}">PR #${prN} ${IC.extlink?icEm(IC.extlink):''}</span>`:''}${nImg?`<span>${nImg} prova${nImg===1?'':'s'}</span>`:''}${nDoc?`<span>${nDoc} doc${nDoc===1?'':'s'}</span>`:''}${rows.length?`<span>${okN}/${rows.length} requisitos provados</span>`:''}${(d=>d?`<span>${esc(d)}</span>`:'')(fmtDurKnown(taskDurationMs(t)))}</span>`
    : `<span class="seg5">${segs}</span><span class="dc-pct" data-sum="${escA(t.id)}" title="resumo do que já foi feito">${pct}%</span><span class="dc-msg">${msg}</span>`;
  // F2/F3: tarefa de épico mantém a identidade depois de começar — selo "◆ nome · onda N" + borda na cor do épico
  const epId=(t.epic&&t.epic.epicId)||'';
  const epSt=(epId&&typeof epColor==='function')?` style="--epc:${epColor(epId)}"`:'';
  const bare=!t.objective && !rows.length; // sem descrição nem requisitos: o card não reserva o espaço (sumia num buraco)
  const mName=boardModelName(t.model);
  return `<div class="dcard${done?' done':''}${epSt?' has-ep':''}${bare?' dc-bare':''}" data-id="${escA(t.id)}"${epSt}>
    <div class="dc-top"><span class="d" style="background:${dot}"></span><span class="dc-title">${esc(t.title)}</span>${typeof epTaskBadge==='function'?epTaskBadge(t):''}${typeof taskOriginHtml==='function'?taskOriginHtml(t):''}<span class="dc-type" style="color:${TYPE_COLOR[ty]||'var(--muted)'}">${esc(TYPE_PT[ty]||ty)}</span>${t.orchestration?`<span class="dc-orq" data-orq="${escA(t.orchestration.id)}" data-orq-task="${escA(t.id)}" title="fase ${escA(t.orchestration.phase||'')} do plano — abrir o grafo">${IC.orq} ${esc(String(t.orchestration.title||'plano').slice(0,28))}</span>`:''}<span class="prj"><span class="prjd" style="background:${projColor(t.repo||state.repo)}"></span>${esc(proj)}</span><span style="flex:1"></span>${pvChips(t,true)}${linkChips(t)}${primary}<button class="btn sm dc-menu" data-tmenu="${escA(t.id)}" title="mudar status / encerrar" aria-label="mais ações">${IC.more}</button></div>
    ${t.objective?`<div class="dc-obj">${esc(String(t.objective).split('[PLANO DO ORQUESTRADOR')[0].replace(/\s+/g,' ').slice(0,220))}</div>`:''}
    ${reqsHtml}
    <div class="dc-foot"><span class="ini2" aria-hidden="true" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span><span class="dc-agent">${esc(t.agent||'')}${mName?` <span class="dc-model" title="${escA(t.model)}">· ${esc(mName)}</span>`:''}</span>${foot}<span class="tm">${agoShort(ev?+new Date(ev.ts):taskTs(t))}</span></div>
  </div>`;
}
// ---- ABA ENTREGA (dentro da demanda) ----
const artThumbCache={}; // taskId|name → dataUrl | null
// Print vem DIRETO do disco pelo protocolo sfart:// (o mesmo do vídeo): nada de read_artifact + base64.
// Antes cada miniatura lia a imagem inteira em base64 — com 40+ prints de iPhone (1206x2622) a aba
// passava de 2 GB de RAM e 100% de CPU. Fora do Tauri (preview no navegador) mantém o caminho antigo.
function artFileUrlOk(){ return !!(window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.convertFileSrc); }
function artThumb(taskId, name){
  if(artFileUrlOk()) return artMediaUrl(taskId, name);
  const k=taskId+'|'+name;
  if(artThumbCache[k]!==undefined) return artThumbCache[k];
  artThumbCache[k]=null;
  const again=()=>{ if(typeof fwTask!=='undefined' && fwTask===taskId && fwMode==='entrega' && typeof renderWorkspace==='function') renderWorkspace(); };
  invoke('read_artifact',{ taskId, name }).then(c=>{ const u=(c&&c.kind==='image'&&c.dataUrl)||null; artThumbCache[k]=u; if(!u) artMissing.add(k); again(); })
    .catch(()=>{ artMissing.add(k); again(); });
  return null;
}
// modos escondidos PELO TIPO (dono, 02/10: "esconder pelo tipo" — modo simples global vetado): entrega que não é
// código (investigação, design, pesquisa, relatório, docs sem mudança de código, ou o que entregaNonCode já trata
// como só-documentos) não mostra Código, Revisão nem PR. Os 6 modos continuam pra quem entrega código.
// @modos-tipo-inicio (testado em app/tests/critica-impeccable.test.mjs)
const FW_NONCODE_TYPES=['invest','design','research','report'];
function fwModesNonCodeOf(o){
  if(!o || o.prUrl) return false; // PR aberto: é código, mostra tudo
  if(FW_NONCODE_TYPES.includes(o.type) || FW_NONCODE_TYPES.includes(o.kind)) return true;
  if(/^(research|report|relatorio)\//.test(o.branch||'')) return true;
  if(o.type==='docs' && !(o.diffFiles>0)) return true; // docs que não mexeu em arquivo do repo = documento entregue
  return !!o.nonCode;
}
function fwModesListOf(nonCode, prUrl){
  const M=nonCode ? [['entrega','Entrega'],['conversa','Conversa'],['previa','Prévia']]
    : [['entrega','Entrega'],['codigo','Código'],['conversa','Conversa'],['revisao','Revisão'],['previa','Prévia']];
  if(prUrl && !nonCode) M.push(['pr','PR']); return M;
}
// @modos-tipo-fim
function fwModesNonCode(t){
  if(!t) return false; const d=diffOf(t.id);
  return fwModesNonCodeOf({ prUrl:t.prUrl, type:(typeof taskType==='function')?taskType(t):'', kind:String(t.kind||'').toLowerCase(), branch:t.branch||'',
    diffFiles:d?diffFiles(d):0, nonCode:entregaNonCode(t) });
}
function fwModesList(t){ return fwModesListOf(fwModesNonCode(t), !!(t&&t.prUrl)); } // Prévia: 57-navegador
function fwModesHtml(t){
  return fwModesList(t).map(([k,l])=>`<button class="fwmode${fwMode===k?' on':''}" data-fwmode="${k}">${l}</button>`).join('');
}
// ---- entrega SEM código (FT-6): investigação/design, ou tarefa que só produziu documentos ----
// Júlia vetou um "modo" separado: é o TIPO da entrega que esconde branch/PR. O fim é salvar os
// entregáveis numa pasta do usuário e concluir.
function entregaArts(t){ const c=artifactsCache[t.id]; return (c&&c.list||[]).filter(a=>a.name!=='requirements.json'); }
function entregaNonCode(t){
  if(!t || t.prUrl) return false;
  if(typeof fwArtOnly==='function' && fwArtOnly(t)) return true;
  const d=diffOf(t.id);
  return !!(d && diffFiles(d)===0 && entregaArts(t).length); // não mexeu em código, só entregou arquivos
}
const enPvSel={};      // taskId → nome do arquivo na prévia
const enPvCache={};    // taskId|nome → conteúdo lido (read_artifact) | { err }
const enLogOpen=new Set(); // taskId|checkId com o log aberto
const enCfgOpen={};    // taskId → editor de checagens aberto dentro da Entrega
let enDefDir='';       // ~/Documents/Starfork/Entregas (vem do Rust)
function enHomeShort(p){ return String(p||'').replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/,'~'); }
function enBaseDir(){ return lsGet('entregaDir')||enDefDir||''; }
function enSubDir(t){ const d=new Date(); const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const proj=t.proj||(t.repo||state.repo||'').split(/[\\/]/).filter(Boolean).slice(-1)[0]||'projeto'; return `${proj}/${iso} ${t.title||'entrega'}`; }
async function enPickDir(cur){
  const inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
  if(inv){ try{ const r=await inv('plugin:dialog|open',{ options:{ directory:true, defaultPath:cur||undefined, title:'Onde salvar as entregas?' } }); return r?(Array.isArray(r)?r[0]:r):null; }catch(_){ } }
  return await askText('Pasta das entregas', 'caminho completo da pasta (ex.: ~/Documents/Starfork/Entregas)', cur||'');
}
async function enSaveDeliverables(t, conclude, btn){
  const names=entregaArts(t).map(a=>a.name);
  if(!names.length){ toast('nenhum arquivo entregue ainda','warn'); return; }
  const o=btn?btn.innerHTML:''; if(btn){ btn.disabled=true; btn.textContent='salvando…'; }
  try{
    const dest=await invoke('save_deliverables',{ taskId:t.id, names, base:enBaseDir()||null, sub:enSubDir(t) });
    lsSet('entregaSaved:'+t.id, dest||'');
    if(conclude && !taskIsDone(t)){ await invoke('set_task_flag',{ taskId:t.id, flag:'closed' }); lastSig=''; await refresh(); }
    toast(`${nPl(names.length,'arquivo')} salvo${names.length===1?'':'s'} em ${enHomeShort(dest)}${conclude?' · concluída':''}`,'ok');
  }catch(e){ showErr(e, 'Não deu pra salvar'); }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=o; } renderWorkspace(); }
}
function enSaveBarHtml(t, arts){
  const done=taskIsDone(t), saved=lsGet('entregaSaved:'+t.id);
  const base=enBaseDir(); const where=(base?enHomeShort(base):'~/Documents/Starfork/Entregas')+'/'+enSubDir(t);
  return `<section class="en-save">
    <span class="en-save-ic">${ic('folder',18)}</span>
    <div class="en-save-t"><b>${saved?'Entregáveis salvos':'Salvar entregáveis na pasta'}</b>
      <div class="dim">${saved?`em <span class="mono">${esc(enHomeShort(saved))}</span> · <a class="lnk" data-enopendir="${escA(saved)}">abrir pasta</a>`
        :`${nPl(arts.length,'arquivo')} → <span class="mono" title="${escA(where)}">${esc(where)}</span> · <a class="lnk" id="enChDir">trocar pasta</a>`}</div></div>
    <span style="flex:1"></span>
    ${done?`<button class="btn sm${saved?'':' primary'}" id="enSave">${saved?'salvar de novo':'salvar na pasta'}</button>`
      :`${saved?'':`<button class="btn sm ghost" id="enJustClose" title="conclui sem copiar os arquivos (eles continuam na pasta de trabalho do Starfork)">só concluir</button>`}<button class="btn primary" id="enSave" ${arts.length?'':'disabled title="o agente ainda não entregou nenhum arquivo"'}>${ic('save')}${saved?'concluir':'salvar e concluir'}</button>`}
  </section>`;
}
// ---- bloco Verificação (FT-5) ----
function enVerifHtml(t){
  chkRefresh(t.id);
  const g=chkGate(t), done=taskIsDone(t);
  const pre=['review','delivered'].includes(t.status) && !t.prUrl && !done;
  const cfgOpen=!!enCfgOpen[t.id];
  const pill={ none:['sem checagens','muted'], loading:['conferindo…','muted'], running:['rodando…','run'], notrun:['não rodou','warn'], stale:['desatualizada','warn'], fail:['falhou','crit'], pass:['passou','good'], override:['liberada com motivo','warn'], err:['indisponível','muted'] }[g.st]||['—','muted'];
  const r=g.r||(['notrun','stale','override'].includes(g.st)?chkResGet(t.id):null);
  const live=g.st==='running'?g.live:null;
  const cur=chkFpC[t.id]&&chkFpC[t.id].fp;
  const short=h=>String(h||'').slice(0,7);
  // portão de provas (sempre ligado com requisitos) vem PRIMEIRO; checagens do repositório são um extra opcional
  const pg0=proofGate(t);
  const gl=proofGateLine(pg0, Array.isArray(t.requirements)?t.requirements.length:0, esc);
  const sum = g.st==='none' ? `<span class="vf-opt">Checagens do repositório (opcional): nenhuma configurada — dá pra rodar testes/lint aqui antes de aprovar. <a class="lnk" data-encfg="1">configurar</a></span>`
    : g.st==='loading' ? 'conferindo a versão do código desta tarefa…'
    : g.st==='err' ? esc(humanErr(g.err,'Não deu pra conferir a verificação').msg)
    : g.st==='running' ? `rodando <b>${esc(live.cur?live.cur.label:'…')}</b> (${Math.min(live.done.length+1,g.on.length)} de ${g.on.length}) na cópia desta tarefa`
    // tarefa já concluída: não há aprovação a liberar (antes pedia "rode pra liberar a aprovação" até em tarefa mergeada)
    : g.st==='notrun' ? (pre ? 'ainda não rodou nesta versão do código — rode pra liberar a aprovação' : done ? 'não rodou antes de concluir — dá pra rodar agora só pra conferir o código' : 'ainda não rodou nesta versão do código')
    : g.st==='stale' ? `<b>desatualizada</b>: o agente mexeu no código depois (verificada ${esc(short(r&&r.head))}${r&&r.dirty?'+':''}, agora ${esc(short(cur&&cur.head))}${cur&&cur.dirty?'+':''}).${done?'':' Rode de novo.'}`
    : g.st==='fail' ? `<b>${nPl(g.bad.length,'checagem')} falhou</b> na versão atual — a aprovação fica bloqueada até corrigir (ou liberar com um motivo)`
    : g.st==='pass' ? `tudo verde na versão atual <span class="mono dim">${esc(short(r.head))}${r.dirty?'+':''}</span> · ${esc(agoShort(r.at))==='agora'?'agora':'há '+esc(agoShort(r.at))}`
    : g.st==='override' ? `${IC.warn} liberada ${g.was==='fail'?'com checagem falhando':'sem verificação'}: <b>${esc(g.ov.reason)}</b>` : '';
  const byId=Object.fromEntries(((live?live.done:(r&&r.results))||[]).map(x=>[x.id,x]));
  const rows=(g.on||[]).map(c=>{
    const x=byId[c.id]; const running=live&&live.cur&&live.cur.id===c.id;
    const st=running?'run':x?(x.ok?'ok':'fail'):'na';
    const k=t.id+'|'+c.id; const open=enLogOpen.has(k);
    const meta=x?`<span class="vf-m">${chkDur(x.durationMs)}</span><span class="vf-m">${x.timedOut?'tempo esgotado':x.stopped?'parada':'exit '+(x.exitCode==null?'?':x.exitCode)}</span>`:(running?'<span class="vf-m">rodando…</span>':'<span class="vf-m">—</span>');
    return `<div class="vf-row ${st}${g.st==='stale'?' old':''}"><span class="vf-ic">${st==='ok'?'✓':st==='fail'?'✕':st==='run'?'<span class="spin"></span>':'·'}</span>
      <div class="vf-t"><b>${esc(c.label)}</b><span class="mono vf-cmd" title="${escA(c.cmd)}">${esc(c.cmd)}</span></div>${meta}
      ${x&&x.log?`<button class="btn sm ghost" data-vflog="${escA(k)}">${open?'esconder log':'ver log'}</button>`:''}</div>
      ${x&&open?`<pre class="vf-log mono">${esc(x.log||'')}</pre>`:''}`;
  }).join('');
  const canRun=!['none','loading','err','running'].includes(g.st);
  const runBtn = g.st==='running' ? `<button class="btn sm" id="vfStop">■ parar</button>`
    : canRun ? `<button class="btn sm${['notrun','stale'].includes(g.st)?' primary':''}" id="vfRun" title="roda as checagens do projeto na cópia desta tarefa (cada uma com até 10 min)">▶ ${g.st==='pass'||g.st==='fail'?'rodar de novo':'rodar checagens'}</button>` : '';
  const ok=chkCanApprove(g);
  // portão de prova (21: proofGate) antes da verificação. O verde da tela é o do cabeçalho (mesma ação) — aqui os
  // botões são neutros: um verde por tela.
  const pg=proofGate(t), unproven=pg.st==='unproven';
  const approve = pre ? `<div class="vf-approve">
      ${g.st==='fail'?`<button class="btn sm" id="vfFix" title="manda o log da falha pro agente corrigir">${IC.ai} pedir pro agente corrigir</button>`:''}
      ${unproven?`<span class="vf-proofmiss" role="status">${IC.warn} ${esc(nPl(pg.missing.length,'requisito'))} sem prova</span>`:''}
      <span style="flex:1"></span>
      ${unproven ? `<button class="btn sm ghost" id="vfNoProof" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar sem prova…</button><button class="btn" id="vfAskProof" title="${escA(proofMissingTip(pg))}">${IC.ai} pedir a prova ao agente</button>`
        : `${!ok && !['running','loading'].includes(g.st)?`<button class="btn sm ghost" id="vfOverride" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar mesmo assim…</button>`:''}
      <button class="btn" id="vfApprove" ${ok?'':`disabled title="${escA(chkBlockWhy(g))}"`}>${IC.merge} aprovar e abrir PR</button>`}</div>` : '';
  // concluída: sem o tom de alerta (amarelo) de "falta rodar" — é só informação
  let pillShown=(done && ['notrun','stale'].includes(g.st)) ? [pill[0],'muted'] : pill;
  // sem checagens: o selo é o do portão de provas (nunca "sem checagens" como se nada protegesse a aprovação)
  if(g.st==='none' && gl.pill) pillShown=done?[gl.pill[0],'muted']:gl.pill;
  else if(g.st==='none') pillShown=['opcional','muted'];
  return `<section class="en-sec en-verif vf-${done&&['notrun','stale'].includes(g.st)?'done':g.st}" id="enVerif">
    <div class="seclbl2">Verificação <span class="dim">· testes e checagens automáticas, rodadas de verdade (exit code e log)</span><span style="flex:1"></span>
      <span class="vf-pill ${pillShown[1]}">${pillShown[0]}</span>${runBtn}<button class="btn sm ghost" data-encfg="1" title="quais checagens rodam neste projeto (fica em .cardume/checks.json)">${IC.wrench||''} checagens</button></div>
    ${gl.on?`<div class="vf-sum vf-gate">${IC.check||''}<span>${gl.html}</span></div>`:''}
    <div class="vf-sum">${sum}</div>
    ${rows?`<div class="vf-rows">${rows}</div>`:''}
    ${cfgOpen?`<div class="vf-cfg" id="enChkCfg"></div>`:''}
    ${approve}
  </section>`;
}
function enWireVerif(t, main){
  main.querySelectorAll('[data-vflog]').forEach(b=>b.onclick=()=>{ const k=b.dataset.vflog; enLogOpen.has(k)?enLogOpen.delete(k):enLogOpen.add(k); renderWorkspace(); });
  main.querySelectorAll('[data-encfg]').forEach(b=>b.onclick=()=>{ enCfgOpen[t.id]=!enCfgOpen[t.id]; renderWorkspace(); });
  bindClick('vfRun', ()=>chkRun(t));
  bindClick('vfStop', ()=>chkStop(t));
  bindClick('vfApprove', ()=>{ const g=chkGate(t); if(chkCanApprove(g)) approveGate(t); });
  bindClick('vfOverride', async()=>{ const g=chkGate(t); if(await chkOverride(t, g)){ renderWorkspace(); approveGate(t); } });
  bindClick('vfAskProof', (e)=>proofAsk(t, e.currentTarget));
  bindClick('vfNoProof', ()=>approveNoProof(t));
  bindClick('vfFix', async()=>{ const g=chkGate(t); if(g.st!=='fail') return;
    const msg='A verificação do projeto falhou na sua cópia. Corrija e rode de novo antes de entregar:\n\n'+g.bad.map(b=>`### ${b.label} — \`${b.cmd}\` (${b.timedOut?'passou do tempo-limite':'exit '+b.exitCode})\n\`\`\`\n${String(b.log||'').split('\n').slice(-40).join('\n')}\n\`\`\``).join('\n\n');
    if(typeof fwSendText==='function' && await fwSendText(t.id, msg)) toast('log enviado ao agente','ok'); }); // falhou: o showErr do envio já disse
  const cfgBox=$id('enChkCfg'); if(cfgBox && typeof chkCfgEditor==='function') chkCfgEditor(cfgBox, t.id, ()=>{ delete chkCfg[t.id]; chkRefresh(t.id); });
}
// ---- Prévia do entregável (FT-6) ----
function enPvPick(t, files){
  const cur=enPvSel[t.id]; if(cur && files.some(a=>a.name===cur)) return cur;
  const rank=a=>({ pdf:0, md:1, csv:2, html:3, image:4, text:5 }[pvKind(a.name)] ?? 9);
  const f=files.slice().sort((a,b)=>rank(a)-rank(b))[0]; return f?f.name:'';
}
function enPvHtml(t, files){
  if(!files.length) return '';
  const sel=enPvPick(t, files); const a=files.find(x=>x.name===sel)||files[0];
  const k=t.id+'|'+a.name; const c=enPvCache[k];
  if(c===undefined){ enPvCache[k]=null; invoke('read_artifact',{ taskId:t.id, name:a.name }).then(v=>{ enPvCache[k]=v||{ err:'vazio' }; }).catch(e=>{ enPvCache[k]={ err:String(e&&e.message||e) }; }).finally(()=>{ if(fwTask===t.id&&fwMode==='entrega') renderWorkspace(); }); }
  const kind=pvKind(a.name);
  const tag={ pdf:'PDF', md:'MD', csv:'CSV', html:'HTML', image:'IMG', video:'VÍDEO', text:'TXT' }[kind]||'ARQ';
  return `<section class="en-sec en-prev" id="enPv">
    <div class="seclbl2">Prévia <span class="dim">· o arquivo de verdade, sem sair daqui</span></div>
    ${files.length>1?`<div class="pv-tabs">${files.map(f=>`<button class="pv-tab${f.name===a.name?' on':''}" data-pvsel="${escA(f.name)}" title="${escA(f.name)}"><i>${({ pdf:'PDF', md:'MD', csv:'CSV', html:'HTML', image:'IMG', video:'VÍDEO', text:'TXT' }[pvKind(f.name)]||'ARQ')}</i>${esc(f.name.split('/').pop())}</button>`).join('')}</div>`:''}
    <div class="pv-bar"><span class="en-dic">${tag}</span><b class="pv-name">${esc(a.name)}</b><span class="dim pv-meta">${artDate(a.created)}${a.size?' · '+(a.size<1024?a.size+' B':Math.round(a.size/1024)+' KB'):''}</span><span style="flex:1"></span>
      ${kind==='md'?`<button class="btn sm ghost" id="pvPdf" title="gera um PDF formatado deste documento">${ic('doc')}exportar PDF</button>`:''}
      <button class="btn sm" id="pvOpen" title="abre no programa padrão do computador (Preview, Excel, Word, navegador…)">${IC.extlink||'↗'} abrir no app padrão</button>
      <button class="btn sm" id="pvReveal" title="mostra o arquivo na pasta">${ic('folder')}mostrar na pasta</button></div>
    <div class="pv-body pv-${kind}">${artPreviewHtml(a.name, c, t.id)}</div>
  </section>`;
}
function enWirePv(t, main){
  main.querySelectorAll('.pv-tab[data-pvsel]').forEach(b=>b.onclick=()=>{ enPvSel[t.id]=b.dataset.pvsel; renderWorkspace(); });
  const nm=()=>{ const n=main.querySelector('.pv-name'); return n?n.textContent:''; };
  bindClick('pvOpen', ()=>invoke('open_artifact',{ taskId:t.id, name:nm() }).catch(e=>showErr(e, 'Não abriu')));
  bindClick('pvReveal', ()=>invoke('reveal_artifact',{ taskId:t.id, name:nm() }).catch(e=>showErr(e, 'Não achei o arquivo')));
  bindClick('pvPdf', (e)=>mdArtifactPdf(t.id, nm(), e.currentTarget));
}
// ---- Preview "caiu → subir de novo" (R8) ----
// O agente sobe o servidor DENTRO do grupo de processos dele: quando o turno acaba, o motor mata
// o grupo e o link anunciado morre. Aqui: health-check leve (TCP, só loopback) enquanto a faixa
// "Ver funcionando" ou o globo do topo estão à vista; caiu → "subir de novo" (preview_start roda o
// comando que o agente gravou em .cardume/preview.json — ou um palpite pelo package.json — num
// grupo PRÓPRIO, que sobrevive ao turno). Sem comando conhecido → "pedir pro agente subir".
const PV_POLL_MS=5000, PV_BOOT_MS=90000;
const pvHealth={};  // url → { st:'on'|'off'|'na', at }
const pvBusy={};    // url → checagem em voo (1 por vez)
const pvRun={};     // taskId → { phase:'subindo'|'falhou'|null, byApp, log, exitCode, err }
const pvInfoC={};   // taskId → { v:PreviewInfo|null, at }
const pvSleep=ms=>new Promise(r=>setTimeout(r, ms));
// URL do preview: a última anunciada no chat → senão a gravada no .cardume/preview.json
function taskPreviewTarget(t){ if(!t) return null; return taskPreviewUrl(t.id) || ((pvInfoC[t.id]||{}).v||{}).url || null; }
function pvInfoEnsure(t){
  const c=pvInfoC[t.id]; if(c && (c.busy || Date.now()-c.at<30000)) return;
  pvInfoC[t.id]=Object.assign({ v:null, at:0 }, c, { busy:true });
  invoke('preview_info',{ taskId:t.id, url:taskPreviewUrl(t.id) }).then(v=>v||null).catch(()=>null).then(v=>{
    const old=JSON.stringify((c||{}).v||null); pvInfoC[t.id]={ v, at:Date.now() };
    if(JSON.stringify(v)!==old) pvRerender(t.id);
  });
}
// estado exibido: online | caiu | subindo | falhou | checando
function pvState(t){
  const url=taskPreviewTarget(t); if(!url) return null;
  const r=pvRun[t.id]; if(r && r.phase) return r.phase;
  const h=pvHealth[url]; if(!h || h.st==='na') return 'checando';
  return h.st==='on'?'online':'caiu';
}
async function pvCheck(url, taskId){
  if(!url) return null;
  if(pvBusy[url]) return pvHealth[url]||null;
  pvBusy[url]=1; const prev=(pvHealth[url]||{}).st;
  try{ const ok=await invoke('preview_alive',{ url }); pvHealth[url]={ st:ok?'on':'off', at:Date.now() }; }
  catch(_){ pvHealth[url]={ st:'na', at:Date.now() }; } // host que não é local: não dá pra saber — não acusa "caiu"
  finally{ delete pvBusy[url]; }
  if(prev!==pvHealth[url].st && taskId) pvRerender(taskId);
  return pvHealth[url];
}
// 1ª checagem na hora em que o preview aparece na tela (sem esperar o tick de 5s)
function pvKick(t, url){ if(!url || pvHealth[url] || pvBusy[url] || taskIsDone(t)) return; setTimeout(()=>pvCheck(url, t.id), 0); }
// repinta só o que mostra o preview: a Entrega (render com guarda de html) e o globo do topo
function pvRerender(taskId){
  if(fwTask!==taskId) return;
  const t=fwTaskObj(); if(!t) return;
  if(fwMode==='entrega'){ renderWorkspace(); return; }
  const url=taskPreviewTarget(t), b=$id('fwPv');
  if(!!url !== !!b || (b && b.dataset.url!==url)){ renderWorkspace(); return; }
  pvDecorateGlobe(t);
}
function pvGlobeHtml(t){
  const pv=taskPreviewTarget(t); if(!pv) return '';
  const st=pvState(t)||'checando';
  pvKick(t, pv);
  return `<button class="btn sm fwpvic pv-${st}" id="fwPv" data-url="${escA(pv)}" title="${escA(pvGlobeTip(st, pv))}">${IC.globe}<i class="fwpv-dot"></i></button>`;
}
function pvGlobeTip(st, pv){
  return st==='caiu'?'o app parou (o turno do agente terminou) — clique pra subir de novo'
    : st==='falhou'?'o app não subiu — clique pra ver o log'
    : st==='subindo'?'subindo o app…'
    : `abrir o site que o agente subiu — ${pv} (celular: no ⋯)`;
}
function pvDecorateGlobe(t){
  const b=$id('fwPv'); if(!b) return;
  const st=pvState(t)||'checando', cls='btn sm fwpvic pv-'+st;
  if(b.className!==cls) b.className=cls;
  const tip=pvGlobeTip(st, b.dataset.url); if(b.title!==tip) b.title=tip;
}
// globo do topo: no ar → abre; fora do ar → leva pra Entrega, onde está o "subir de novo"
function pvGlobeClick(t, url){
  const st=pvState(t);
  if(st==='online' || st==='checando'){ invoke('open_url',{ url }).catch(e=>showErr(e, 'Não consegui abrir o app')); return; }
  fwMode='entrega'; if(typeof fwRememberTab==='function') fwRememberTab(); renderWorkspace();
  setTimeout(()=>{ const s=document.querySelector('#fwOverlay .en-live'); if(s){ s.scrollIntoView(scrollOpts('center')); s.classList.add('flash'); setTimeout(()=>s.classList.remove('flash'),1600); } }, 60);
}
async function pvLoadLog(taskId){
  try{ const r=await invoke('preview_log_tail',{ taskId }); if(r && pvRun[taskId]){ pvRun[taskId].log=r.log||''; pvRun[taskId].exitCode=r.exitCode; } return r; }catch(_){ return null; }
}
async function pvStartUp(t){
  const url0=taskPreviewTarget(t);
  let info=(pvInfoC[t.id]||{}).v;
  if(!info){ info=await invoke('preview_info',{ taskId:t.id, url:taskPreviewUrl(t.id) }).catch(()=>null); pvInfoC[t.id]={ v:info||null, at:Date.now() }; }
  if(!info){ await pvAskAgent(t); return; }
  // 1ª vez (ou comando novo): mostra EXATAMENTE o que vai rodar antes de rodar
  const okKey='pvOk:'+t.id;
  if(lsGet(okKey)!==info.cmd){
    const where=(!info.cwd||info.cwd==='.')?'na pasta da tarefa':`em ${info.cwd.replace(/\/$/,'')}/`;
    const ok=await askYes(`Vai rodar: ${info.cmd}\n${where}${info.guessed?'\n\n(comando deduzido do projeto — o agente não deixou registrado)':''}\n\nO app fica no ar até você parar ou a tarefa ser concluída.`, 'Subir o app de novo');
    if(!ok) return; lsSet(okKey, info.cmd);
  }
  const t0=Date.now(); pvRun[t.id]={ phase:'subindo', byApp:true, t0 }; pvRerender(t.id);
  try{ await invoke('preview_start',{ taskId:t.id, url:taskPreviewUrl(t.id) }); }
  catch(e){ pvRun[t.id]={ phase:'falhou', byApp:false, err:errShort(e) }; await pvLoadLog(t.id); pvRerender(t.id); showErr(e, 'Não subiu o app'); return; }
  const url=url0||info.url;
  while(Date.now()-t0<PV_BOOT_MS){
    await pvSleep(1500);
    const r=pvRun[t.id]; if(!r || r.t0!==t0 || r.phase!=='subindo') return; // cancelado / outra subida
    if(url){ const h=await pvCheck(url); if(h && h.st==='on'){ pvRun[t.id]={ phase:null, byApp:true }; pvRerender(t.id); toast('o app está no ar de novo','ok'); return; } }
    const lg=await pvLoadLog(t.id);
    if(lg && lg.exited){ pvRun[t.id].phase='falhou'; pvRerender(t.id); return; }
    if(!url && Date.now()-t0>8000 && lg && lg.running){ pvRun[t.id]={ phase:null, byApp:true }; pvRerender(t.id); toast('app subindo — o endereço aparece quando o agente anunciar','info'); return; }
  }
  if(pvRun[t.id] && pvRun[t.id].t0===t0){ await pvLoadLog(t.id); pvRun[t.id].phase='falhou'; pvRun[t.id].err='não respondeu em 90s'; pvRerender(t.id); }
}
async function pvStop(t){
  try{ await invoke('preview_stop',{ taskId:t.id }); }catch(e){ showErr(e, 'Não parou o app'); return; }
  delete pvRun[t.id]; const url=taskPreviewTarget(t); if(url) delete pvHealth[url];
  toast('app parado','ok'); pvRerender(t.id); if(url) pvCheck(url, t.id);
}
async function pvAskAgent(t){
  const msg='Suba de novo o servidor de preview desta tarefa e anuncie PREVIEW: http://127.0.0.1:PORTA/caminho, gravando também .cardume/preview.json (cmd, cwd, url) pra eu conseguir subir sozinho da próxima vez.';
  if(typeof fwSendText!=='function') return;
  if(await fwSendText(t.id, msg)) toast('pedido enviado ao agente','ok'); else pvRerender(t.id); // falhou: o botão volta
}
// tick: só com a tarefa aberta, app visível e 1 checagem por vez
function pvTick(){
  if(document.hidden || !fwTask) return;
  const ov=$id('fwOverlay'); if(!ov || ov.style.display==='none') return;
  const t=fwTaskObj(); if(!t || taskIsDone(t)) return;
  pvInfoEnsure(t);
  if(fwMode!=='entrega' && !$id('fwPv')) return;
  const r=pvRun[t.id]; if(r && r.phase==='subindo') return; // o laço da subida já checa
  const url=taskPreviewTarget(t); if(url) pvCheck(url, t.id);
}
setInterval(pvTick, PV_POLL_MS);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pvTick(); });
// ---- "Ver funcionando": o app que o agente subiu, no topo da Entrega ----
function enLiveHtml(t){
  if(taskIsDone(t)) return '';
  pvInfoEnsure(t);
  const pv=taskPreviewTarget(t); if(!pv) return '';
  const st=pvState(t); pvKick(t, pv);
  const info=(pvInfoC[t.id]||{}).v, r=pvRun[t.id]||{};
  const host=`<span class="mono">${esc(pv.replace(/^https?:\/\//,''))}</span>`;
  const ask=`<button class="btn sm ghost" id="enLiveAsk" title="manda uma mensagem pro agente subir o servidor e anunciar o endereço">${ic('chat')} pedir pro agente subir</button>`;
  const cmdTip=info?`vai rodar: ${info.cmd}${info.cwd&&info.cwd!=='.'?' em '+info.cwd.replace(/\/$/,'')+'/':''}`:'';
  if(st==='caiu'){
    return `<section class="en-live off" data-pv="caiu"><span class="en-live-dot"></span><div class="en-live-t"><b>O app parou</b><span class="dim">o turno do agente terminou e o servidor caiu junto · ${host}</span></div><span style="flex:1"></span>
      ${info?`${ask.replace('btn sm ghost','btn sm ghost en-live-sec')}<button class="btn primary" id="enLiveUp" title="${escA(cmdTip)}">${IC.retry||''} subir de novo</button>`:ask.replace('btn sm ghost','btn primary')}</section>`;
  }
  if(st==='subindo'){
    return `<section class="en-live up" data-pv="subindo"><span class="spin"></span><div class="en-live-t"><b>Subindo o app…</b><span class="dim">${info?`<span class="mono">${esc(info.cmd)}</span> · `:''}pode levar até 90s</span></div><span style="flex:1"></span>
      <button class="btn sm ghost" id="enLiveStop">cancelar</button></section>`;
  }
  if(st==='falhou'){
    const lines=String(r.log||'').trim();
    return `<section class="en-live bad" data-pv="falhou"><span class="en-live-dot"></span><div class="en-live-t"><b>O app não subiu</b><span class="dim">${esc(r.err||(r.exitCode!=null?`o comando terminou com código ${r.exitCode}`:'o processo terminou antes de responder'))}${info?` · <span class="mono">${esc(info.cmd)}</span>`:''}</span>
      ${lines?`<details class="en-live-log"><summary>ver o log (últimas linhas)</summary><pre class="mono">${esc(lines)}</pre></details>`:''}</div><span style="flex:1"></span>
      ${ask}${info?`<button class="btn primary" id="enLiveUp" title="${escA(cmdTip)}">${IC.retry||''} tentar de novo</button>`:''}</section>`;
  }
  const tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
  return `<section class="en-live${st==='checando'?' chk':''}" data-pv="${st}"><span class="en-live-dot"></span><div class="en-live-t"><b>Ver funcionando</b><span class="dim">${r.byApp?'o app subiu o servidor de novo':'o agente deixou o app rodando'} — teste antes de aprovar · ${host}${r.byApp?' · <button class="linkbtn" id="enLiveStop">parar</button>':''}</span></div><span style="flex:1"></span>
    <button class="btn sm" id="enLiveMob" title="${tun?'o celular já tem acesso — clique pra fechar':'abre este site no seu celular (túnel criptografado)'}">${IC.phone} ${tun?'fechar no celular':'no celular'}</button>
    <button class="btn primary" id="enLiveOpen">${IC.globe} abrir o app</button></section>`;
}
function enWireLive(t){
  bindClick('enLiveOpen', ()=>{ const pv=taskPreviewTarget(t); if(pv) invoke('open_url',{ url:pv }).catch(e=>showErr(e, 'Não consegui abrir o app')); });
  bindClick('enLiveMob', async()=>{ const pv=taskPreviewTarget(t); if(!pv) return; const tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
    if(tun){ if(typeof fwTunnelOff==='function') await fwTunnelOff(t); return; }
    toast('criando o túnel pro celular…'); const pub=await mobilePreview(t.id, pv); if(pub && typeof tunnelUp!=='undefined') tunnelUp[t.id]=pub; renderWorkspace(); });
  bindClick('enLiveUp', (e)=>{ e.currentTarget.disabled=true; pvStartUp(t); });
  bindClick('enLiveAsk', (e)=>{ e.currentTarget.disabled=true; pvAskAgent(t); });
  bindClick('enLiveStop', (e)=>{ e.preventDefault(); pvStop(t); });
}
function fwRenderEntrega(t, main){
  const done=taskIsDone(t);
  fwReqProofsEnsure(t.id); fwArtsEnsure(t); // 1 leitura em voo por tarefa (antes: uma nova a cada render)
  if(commitsCache[t.id]===undefined) loadCommits(t.id).then(()=>{ if(fwTask===t.id) renderWorkspace(); });
  if(!enDefDir) invoke('deliverables_default_dir').then(d=>{ if(d&&!enDefDir){ enDefDir=d; if(fwTask===t.id&&fwMode==='entrega') renderWorkspace(); } }).catch(()=>{});
  const arts=entregaArts(t);
  const nonCode=entregaNonCode(t);
  const imgs=arts.filter(a=>a.kind==='image');
  const vids=arts.filter(a=>pvKind(a.name)==='video');
  const docs=arts.filter(a=>!/\.(png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm)$/i.test(a.name));
  const rows=reqRows(t); const okN=rows.filter(r=>r.st==='ok').length;
  const prN=prNumOf(t); const cost=taskCost(t.id); const d=diffOf(t.id); const rev=reviewOf(t.id);
  const c=commitsCache[t.id]||[];
  const evidenceNames=new Set(rows.flatMap(r=>r.evidence));
  const evNorm=new Set([...evidenceNames].map(e=>enEvResolve(t.id, e, arts)).filter(Boolean)); // MESMA regra das mídias por requisito
  const proofsHtml = (imgs.length||vids.length) ? `<div class="en-proofs">${imgs.map((a,i)=>{ return `<button class="en-proof" data-lb="${i}" title="${escA(a.name)}">${enThumbHtml(t.id, a.name, '')}<span class="en-pn">${esc(a.name)}</span>${evNorm.has(a.name)?'<span class="en-pv">evidência</span>':''}</button>`; }).join('')}${vids.map(a=>`<div class="en-proof en-vproof" title="${escA(a.name)}">${artVideoHtml(t.id, a.name, 'en-pvid')}<span class="en-pn">${IC.play} ${esc(a.name)}</span>${evNorm.has(a.name)?'<span class="en-pv">evidência</span>':''}</div>`).join('')}</div>` : `<div class="en-empty">nenhum print ou vídeo de prova ainda${done?'':' — o agente anexa em .cardume/artifacts quando comprova um requisito'}</div>`;
  const reqHtml = rows.length ? rows.map(r=>`<div class="en-req ${r.st}"><span class="reqst ${r.st==='ok'?'ok':r.st==='blk'?'blk':'na'}">${r.st==='ok'?IC.check:r.st==='blk'?'!':'·'}</span><div class="en-rt"><div>${esc(r.text)}</div>${enEvMediaHtml(t, r.evidence, arts, imgs)}${r.evidence.length?`<div class="en-ev">${r.evidence.map(e=>`<button class="reqevb mono" data-art="${escA(e)}" title="${escA(e)}">${esc(enEvName(t.id, e)||e)}</button>`).join('')}</div>`:''}${r.note&&r.st==='blk'?`<div class="reqnote">${esc(r.note)}</div>`:''}</div></div>`).join('') : '<div class="en-empty">sem critérios de aceite nesta demanda</div>';
  const docIc=n=>({ pdf:'PDF', md:'MD', csv:'CSV', html:'HTML', image:'IMG', video:'VÍDEO', text:'TXT' }[pvKind(n)]||'ARQ');
  const listed=nonCode?arts:docs;
  const pvSel=enPvPick(t, nonCode?arts:docs);
  const docsHtml = listed.length ? listed.map(a=>`<div class="en-doc${a.name===pvSel?' on':''}"><span class="en-dic">${docIc(a.name)}</span><span class="en-dn">${esc(a.name)}<span class="en-dd">${artDate(a.created)}${a.size?' · '+(a.size<1024?a.size+' B':Math.round(a.size/1024)+' KB'):''}</span></span><span class="en-dacts"><button class="btn sm ghost" data-pvsel="${escA(a.name)}" title="mostra na prévia abaixo">ver</button>${/\.md$/i.test(a.name)?`<button class="btn sm ghost" data-docpdf="${escA(a.name)}">PDF</button>`:''}<button class="btn sm ghost" data-docslack="${escA(a.name)}">Slack</button></span></div>`).join('') : '<div class="en-empty">nenhum documento ainda</div>';
  const dels=(t.deliverables||[]).filter(Boolean);
  const timeline=stageStepper(t).replace('<div class="seclbl" style="margin-top:13px">Etapas</div>','');
  const dur=fmtDurKnown(taskDurationMs(t));
  // sem requisitos: "0/0 requisitos provados" parecia reprovação — vira "—"
  const reqKpi = rows.length ? `<div class="en-kpi"><b>${okN}/${rows.length}</b><span>requisitos provados</span></div>` : `<div class="en-kpi" title="esta demanda não tem critérios de aceite"><b>—</b><span>sem requisitos</span></div>`;
  const kpis = nonCode
    ? `${reqKpi}
       <div class="en-kpi"><b>${arts.length}</b><span>${arts.length===1?'arquivo entregue':'arquivos entregues'}</span></div>
       <div class="en-kpi"><b>${esc(dur||'—')}</b><span>${cost.usd>0?fmtCost(cost.usd):'duração'}</span></div>`
    : `${prN?`<button class="en-kpi" data-lk="${escA(t.prUrl)}"><b>PR #${prN}</b><span>${done?'integrado':'aberto'} ${icEm(IC.extlink)}</span></button>`:''}
        ${reqKpi}
        <div class="en-kpi"><b>${d?`+${d.additions||0} −${d.deletions||0}`:'—'}</b><span>${d?nPl(diffFiles(d),'arquivo'):'sem diff'}</span></div>
        <div class="en-kpi"><b>${esc(dur||'—')}</b><span>${esc(commitsLabel(t))}${cost.usd>0?' · '+fmtCost(cost.usd):''}</span></div>`;
  const pvSec=enPvHtml(t, nonCode?arts:docs);
  const html=`<div class="enpage${nonCode?' en-noncode':''}" data-task="${escA(t.id)}">
    <div class="en-head">
      <div class="en-ht"><span class="ndeyebrow">${esc(TYPE_PT[taskType(t)]||'demanda')} · ${done?'concluída':nonCode&&['review','delivered'].includes(t.status)?'pronta pra você conferir':esc(PHASES[taskPhase(t)-1]||'')}</span><h2 class="en-h1">${esc(t.title)}</h2>${t.objective?`<p class="en-obj">${esc(t.objective)}</p>`:''}</div>
      <div class="en-kpis">${kpis}</div>
    </div>
    ${enLiveHtml(t)}
    ${nonCode?enSaveBarHtml(t, arts)+pvSec:enVerifHtml(t)}
    <div class="en-grid">
      <section class="en-sec"><div class="seclbl2">Entregáveis <span class="dim">· requisitos e a prova de cada um</span></div>${reqHtml}${dels.length?`<div class="seclbl2" style="margin-top:14px">Escopo combinado</div>${dels.map(x=>`<div class="en-del">◆ ${esc(x)}</div>`).join('')}`:''}${rev&&rev.howToTest?`<div class="seclbl2" style="margin-top:14px">Como testar</div><div class="en-how">${esc(rev.howToTest)}</div>`:''}</section>
      <section class="en-sec">${nonCode?'':`<div class="seclbl2">Provas <span class="dim">· prints e vídeos anexados pelo agente</span></div>${proofsHtml}`}
        <div class="seclbl2"${nonCode?'':' style="margin-top:16px"'}>${nonCode?'Arquivos entregues':'Documentos'} <span style="flex:1"></span><button class="btn sm${(typeof fwPrimaryAction==='function'&&fwPrimaryAction(t))?'':' primary'}" id="enGen" title="a IA escreve o relatório desta entrega — o que foi feito, por quê, como e o que foi validado">${IC.ai} gerar relatório da entrega</button></div>
        <div id="enGenOut"></div>${docsHtml}</section>
    </div>
    ${nonCode?'':pvSec}
    <section class="en-sec" style="margin-top:6px"><div class="seclbl2">Linha do tempo</div><div class="en-tl">${timeline}</div>${!nonCode&&c.length?`<div class="en-commits">${c.slice(0,8).map(x=>`<button class="fcommit" data-hash="${escA(x.hash||'')}"><span class="mono">${esc(String(x.hash||'').slice(0,7))}</span> ${esc(x.subject||'')}</button>`).join('')}</div>`:''}</section>
  </div>`;
  // guarda: só troca o DOM quando o conteúdo mudou (o PDF da prévia não recarrega a cada tick; log aberto fica aberto)
  const cur=main.firstElementChild;
  if(main._enHtml===html && cur && cur.classList.contains('enpage') && cur.dataset.task===t.id) return;
  // vídeo da prova TOCANDO: não reconstrói a página (o <video> recomeçaria do zero) — redesenha quando ele pausar/acabar
  if(cur && cur.dataset.task===t.id && enVideoPlaying(main)){ main._enPending=true; return; }
  main._enPending=false;
  const out=$id('enGenOut'); const genBusy=out&&out.innerHTML&&cur&&cur.dataset.task===t.id?out.innerHTML:''; // relatório sendo gerado: não some
  main.innerHTML=html; main._enHtml=html;
  if(genBusy){ const o2=$id('enGenOut'); if(o2) o2.innerHTML=genBusy; }
  main.querySelectorAll('video').forEach(v=>{ v.onpause=v.onended=()=>{ if(main._enPending && !enVideoPlaying(main)){ main._enPending=false; if(typeof renderWorkspace==='function') renderWorkspace(); } }; });
  main.querySelectorAll('[data-art]').forEach(b=>b.onclick=()=>openArtifact(t.id, b.dataset.art));
  main.querySelectorAll('[data-lb]').forEach(b=>b.onclick=()=>lbOpen(t.id, imgs.map(a=>a.name), +b.dataset.lb));
  main.querySelectorAll('[data-lk]').forEach(b=>b.onclick=()=>openExternal(b.dataset.lk));
  main.querySelectorAll('[data-docpdf]').forEach(b=>b.onclick=()=>entregaDocPdf(t, b.dataset.docpdf, b));
  main.querySelectorAll('[data-docslack]').forEach(b=>b.onclick=()=>sendArtifactSlack(t.id, b.dataset.docslack));
  main.querySelectorAll('.en-doc [data-pvsel]').forEach(b=>b.onclick=()=>{ enPvSel[t.id]=b.dataset.pvsel; renderWorkspace(); setTimeout(()=>{ const p=$id('enPv'); if(p) p.scrollIntoView(scrollOpts('start')); }, 40); });
  main.querySelectorAll('.fcommit').forEach(b=>b.onclick=()=>{ if(b.dataset.hash&&typeof openCommit==='function') openCommit(b.dataset.hash); });
  main.querySelectorAll('[data-enopendir]').forEach(b=>b.onclick=()=>invoke('open_folder',{ path:b.dataset.enopendir }).catch(e=>showErr(e, 'Não abriu a pasta')));
  bindClick('enGen', ()=>entregaGenReport(t));
  bindClick('enSave', (e)=>enSaveDeliverables(t, !done, e.currentTarget));
  bindClick('enJustClose', async(e)=>{ e.currentTarget.disabled=true; try{ await invoke('set_task_flag',{ taskId:t.id, flag:'closed' }); lastSig=''; await refresh(); toast('concluída — saiu da fila','ok'); }catch(err){ showErr(err, 'Falhou'); } renderWorkspace(); });
  bindClick('enChDir', async()=>{ const p=await enPickDir(enBaseDir()); if(p&&String(p).trim()){ lsSet('entregaDir', String(p).trim()); renderWorkspace(); } });
  enWireLive(t);
  if(!nonCode) enWireVerif(t, main);
  enWirePv(t, main);
}
// ---- provas DENTRO de cada requisito: miniaturas dos prints e o player dos vídeos citados como evidência ----
// nome citado no requirements.json ("./.cardume/artifacts/mobile-ios-1.png", "<tarefa>/x.mp4") → nome do artefato
function enEvName(taskId, e){ return artRelName(taskId, e); }
// ---- prova cujo arquivo não abre: era uma caixa vazia (img quebrada com o alt cortado) ----
// taskId|nome → o arquivo da prova não abriu (404 no sfart://, read_artifact falhou, ou a evidência citada não existe)
const artMissing=new Set();
const EN_MISS_TXT='arquivo da prova não encontrado';
function enMissHtml(name){ return `<span class="en-miss" role="img" aria-label="${escA(EN_MISS_TXT+': '+name)}" title="${escA(EN_MISS_TXT+': '+name)}">${IC.image}<span>${EN_MISS_TXT}</span></span>`; }
// miniatura de um print: a imagem real, o "carregando" (fora do Tauri, lendo) ou o aviso de arquivo que não existe
function enThumbHtml(taskId, name, alt){
  const k=taskId+'|'+name;
  if(artMissing.has(k)) return enMissHtml(name);
  const th=artThumb(taskId, name);
  if(artMissing.has(k)) return enMissHtml(name);
  return th?`<img src="${escA(th)}" alt="${escA(alt||'')}" data-sfthumb="${escA(k)}" loading="lazy" decoding="async">`:`<span class="en-ph" role="img" aria-label="carregando a prova">${IC.image}</span>`;
}
// erro de carga (não sobe na árvore: escuta na CAPTURA) de uma miniatura/vídeo de prova → aviso no lugar
function enMediaErr(ev){
  const el=ev && ev.target; if(!el || !el.dataset || !el.dataset.sfthumb) return;
  const k=el.dataset.sfthumb; artMissing.add(k);
  el.outerHTML=enMissHtml(k.slice(k.indexOf('|')+1));
}
if(typeof document!=='undefined' && document.addEventListener) document.addEventListener('error', enMediaErr, true);
// evidência citada → nome do artefato: igual normalizado; senão pelo nome do arquivo SÓ se UM artefato bater (ambíguo = nada)
function enEvResolve(taskId, e, arts){
  const n=enEvName(taskId, e); const list=arts||[];
  if(list.some(a=>a.name===n)) return n;
  const b=n.split('/').pop(); const hits=list.filter(a=>a.name.split('/').pop()===b);
  return hits.length===1?hits[0].name:null;
}
function enVideoPlaying(root){ try{ return [...root.querySelectorAll('video')].some(v=>!v.paused && !v.ended); }catch(_){ return false; } }
function enEvMediaHtml(t, evidence, arts, imgs){
  const seen=new Set(); const items=[];
  for(const e of (evidence||[])){
    const n=enEvResolve(t.id, e, arts);
    // citada como prova mas o arquivo não existe (nem na worktree nem na cópia coletada): diz isso, não some
    if(!n){ const c=enEvName(t.id, e); const ck=pvKind(c); if((ck==='image'||ck==='video') && !seen.has('?'+c)){ seen.add('?'+c); items.push(`<div class="en-evi en-evmiss" title="${escA(c)}">${enMissHtml(c)}</div>`); } continue; }
    if(seen.has(n)) continue; seen.add(n);
    const k=pvKind(n);
    if(k==='video') items.push(`<div class="en-evv">${artVideoHtml(t.id, n, 'en-evvid')}<span class="en-evn">${IC.play} ${esc(n)}</span></div>`);
    else if(k==='image'){ const i=(imgs||[]).findIndex(a=>a.name===n); items.push(`<button class="en-evi" ${i>=0?`data-lb="${i}"`:`data-art="${escA(n)}"`} title="${escA(n)}">${enThumbHtml(t.id, n, 'print: '+n)}</button>`); }
  }
  return items.length?`<div class="en-evm">${items.join('')}</div>`:'';
}
// ---- lightbox das provas ----
let lbList=[], lbIdx=0, lbTask='';
function lbOpen(taskId, names, idx){ lbTask=taskId; lbList=names; lbIdx=idx||0; $id('lbOverlay').style.display='flex'; lbShow(); }
function lbShow(){
  const name=lbList[lbIdx]; if(!name) return;
  $id('lbCap').textContent=`${name} · ${lbIdx+1} de ${lbList.length}`;
  const img=$id('lbImg'); img.alt='prova: '+name; const th=artFileUrlOk()?artMediaUrl(lbTask,name):artThumbCache[lbTask+'|'+name]; // R8 a11y: o print tinha alt vazio
  if(th){ img.src=th; } else { img.removeAttribute('src'); invoke('read_artifact',{ taskId:lbTask, name }).then(c=>{ artThumbCache[lbTask+'|'+name]=c.dataUrl||null; if(lbList[lbIdx]===name) img.src=c.dataUrl||''; }).catch(()=>{}); }
  $id('lbPrev').style.visibility=lbIdx>0?'visible':'hidden'; $id('lbNext').style.visibility=lbIdx<lbList.length-1?'visible':'hidden';
}
function lbClose(){ $id('lbOverlay').style.display='none'; }
bindClick('lbClose', lbClose); bindClick('lbPrev', ()=>{ if(lbIdx>0){ lbIdx--; lbShow(); } }); bindClick('lbNext', ()=>{ if(lbIdx<lbList.length-1){ lbIdx++; lbShow(); } });
{ const o=$id('lbOverlay'); if(o) o.addEventListener('click', e=>{ if(e.target===o) lbClose(); }); }
document.addEventListener('keydown', e=>{ const o=$id('lbOverlay'); if(!o||o.style.display==='none') return; if(e.key==='Escape') lbClose(); if(e.key==='ArrowLeft'&&lbIdx>0){ lbIdx--; lbShow(); } if(e.key==='ArrowRight'&&lbIdx<lbList.length-1){ lbIdx++; lbShow(); } });
// ---- fatos da entrega → texto pra IA ----
async function entregaFacts(t){
  if(reqProofCache[t.id]===undefined) await loadReqProofs(t.id).catch(()=>{});
  if(commitsCache[t.id]===undefined) await loadCommits(t.id).catch(()=>{});
  if(t.prUrl && prCache[t.id]===undefined) await loadPr(t.id).catch(()=>{});
  const rows=reqRows(t); const d=diffOf(t.id); const rev=reviewOf(t.id); const c=commitsCache[t.id]||[]; const pr=prCache[t.id];
  const notas=eventsOf(t.id).filter(e=>['done','note'].includes(e.type)&&(e.text||'').length>30&&!/^(Você:|perguntou ao humano|humano respondeu)|sess[aã]o iniciada|claude finaliz|timeout|rework/i.test(e.text||'')).slice(-12).map(e=>`- ${e.agent||''}: ${String(e.text).slice(0,220)}`);
  const roles=(t.roles||[]).map(r=>`${r.name} (${r.role}, ${r.engine||''}${r.model?' '+r.model:''})`).join(', ');
  return [
    `DEMANDA: ${t.title}`, `TIPO: ${TYPE_PT[taskType(t)]||taskType(t)}`, `PROJETO: ${pathBase(state.repo)}`,
    `OBJETIVO: ${t.objective||'—'}`,
    `REQUISITOS:\n${rows.map(r=>`- ${r.text} → ${r.st==='ok'?'PROVADO'+(r.evidence.length?' (evidência: '+r.evidence.join(', ')+')':''):r.st==='blk'?'NÃO PROVADO'+(r.note?' — '+r.note:''):'sem verificação'}`).join('\n')||'—'}`,
    `ENTREGÁVEIS COMBINADOS: ${(t.deliverables||[]).join(' | ')||'—'}`,
    `MUDANÇAS (assuntos dos commits): ${c.map(x=>x.subject||'').filter(Boolean).join(' | ')||'—'}`,
    `ESCOPO: ${d?`${nPl(diffFiles(d),'arquivo')}, +${d.additions||0} −${d.deletions||0}`:'—'}`,
    `PR: ${t.prUrl?`#${prNumOf(t)} ${t.prUrl} · ${pr&&pr.state?pr.state:(taskIsDone(t)?'MERGED':'aberto')}${pr&&pr.body?'\nDESCRIÇÃO DO PR:\n'+String(pr.body).slice(0,2500):''}`:'sem PR'}`,
    `REVISÃO INTERNA: ${rev?(rev.summary||'')+(rev.howToTest?'\nCOMO TESTAR: '+rev.howToTest:''):'—'}`,
    `DIÁRIO DO AGENTE:\n${notas.join('\n')||'—'}`,
    `AGENTES: ${roles||t.agent||'—'}`, `DURAÇÃO: ${fmtDurKnown(taskDurationMs(t))||'—'}`,
  ].join('\n\n');
}
async function entregaGenReport(t){
  const out=$id('enGenOut'), b=$id('enGen'); if(!out) return;
  if(b) b.disabled=true;
  ldPaint(out, brandLoaderHtml('a IA está escrevendo o relatório da entrega…', { inline:true }));
  try{
    const md=await invoke('ai_task_report',{ text: await entregaFacts(t), kind:'entrega', label:'Relatório de entrega — '+t.title });
    await invoke('write_artifact',{ taskId:t.id, name:'RELATORIO-ENTREGA.md', content:md });
    artifactsCache[t.id]=undefined; out.innerHTML='';
    repShow('Relatório de entrega — '+t.title, md, 'relatorio-'+t.id);
    renderWorkspace();
  }catch(e){ out.innerHTML=`<div class="imhint" style="border-left:2px solid var(--crit)">${esc(humanErr(e,'Não consegui gerar o relatório').msg)}</div>`; }
  finally{ if(b) b.disabled=false; }
}
async function entregaDocPdf(t, name, btn){
  try{ if(btn){ btn.disabled=true; btn.textContent='PDF…'; } const c=await invoke('read_artifact',{ taskId:t.id, name }); const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(c.text||'', new Date().toLocaleDateString('pt-BR')), name: (t.id+'-'+name).replace(/\.md$/i,'') }); if(btn) btn.textContent='PDF ✓'; setTimeout(()=>{ if(btn){ btn.textContent='PDF'; btn.disabled=false; } },2500); }
  catch(e){ showErr(e, 'Falhou o PDF'); if(btn){ btn.textContent='PDF'; btn.disabled=false; } }
}
// ---- modal do relatório (entrega ou período): ler · copiar · salvar .md · PDF ----
function repShow(title, md, fileBase){
  $id('repTitle').textContent=title;
  $id('repBody').innerHTML=`<div class="mdview" style="font-size:var(--fs-base);line-height:1.65">${mdToHtml(md)}</div>`;
  $id('repFoot').innerHTML=`<span class="dim" id="repMsg" style="font-size:var(--fs-xs)"></span><span style="flex:1"></span><button class="btn sm" id="repCopy">copiar</button><button class="btn sm" id="repMd">${ic('save')}salvar .md</button><button class="btn primary sm" id="repPdf">${ic('doc')}PDF</button>`;
  const msg=v=>{ const m=$id('repMsg'); if(m) m.textContent=v; };
  bindClick('repCopy', function(){ navigator.clipboard.writeText(md); this.textContent='copiado ✓'; });
  bindClick('repMd', async function(){ this.disabled=true; try{ const p=await invoke('save_doc',{ name:fileBase+'.md', content:md }); msg('salvo em '+p); }catch(e){ msg(humanErr(e,'Não consegui salvar o .md').msg); } this.disabled=false; });
  bindClick('repPdf', async function(){ this.disabled=true; const o=this.textContent; this.textContent='gerando PDF…'; try{ const p=await invoke('html_to_pdf',{ html: dailyPdfHtml(md, new Date().toLocaleDateString('pt-BR')), name:fileBase }); msg('PDF em '+p); }catch(e){ msg(humanErr(e,'Não consegui gerar o PDF').msg); } this.textContent=o; this.disabled=false; });
  bindClick('repClose', ()=>{ $id('repOverlay').style.display='none'; });
  $id('repOverlay').style.display='flex';
}
// ---- relatório do PERÍODO (Concluídas): várias entregas num documento ----
async function periodReport(){
  let src; try{ src=boardSource(); }catch(_){ src=(state.tasks||[]); }
  const tasks=flowVisible(src).filter(taskIsDone).sort((a,b)=>taskTs(b)-taskTs(a)).slice(0,25);
  if(!tasks.length){ toast('Nenhuma demanda concluída neste filtro/período.','warn'); return; }
  const b=$id('flowPeriodRep'); if(b){ b.disabled=true; b.textContent='escrevendo…'; }
  try{
    const facts=[]; for(const t of tasks){ facts.push(await entregaFacts(t)); }
    const label={today:'hoje',week:'últimos 7 dias',month:'últimos 30 dias'}[flowPeriod]||'todas as entregas';
    const md=await invoke('ai_task_report',{ text: facts.join('\n\n=====\n\n'), kind:'periodo', label });
    repShow('Relatório de entregas — '+label, md, 'entregas-'+(flowPeriod||'todas'));
  }catch(e){ showErr(e, 'Falhou o relatório'); }
  finally{ if(b){ b.disabled=false; b.innerHTML=ic('doc')+'relatório do período'; } }
}
