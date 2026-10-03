// Starfork — 20-workspace-tarefa
// ---------- workspace 3 colunas (arquivos · código · chat do agente) ----------
let fwWhyCache={}, fwWhyOpen=false;
let fwTask=null, fwPath=null, fwContent='', fwAdded=[], fwSelA=0, fwSelB=0, fwFiles=[], fwEditing=false, fwDrag=false;
let fwEvents=[], fwEvLast=0, fwFetching=false; // conversa com texto COMPLETO (incremental)
let fwAgentSel=null; // com quem estou falando (null = agente padrão da tarefa)
const fwChat={}; // taskId -> [{who:'you'|'sys', text}]
const fwCollapsed=new Set(); // pastas recolhidas na árvore
const fwDraft={};   // taskId → rascunho do chat (cada tarefa tem o SEU — antes o texto vazava de uma aba pra outra)
const fwAsReqOn={}; // taskId → checkbox "vira requisito" (sobrevive aos re-renders do poll)
const fwArtLoading={}; // taskId → carga de artefatos em voo (1 por vez)
const fwRpLoading={};  // taskId → leitura do requirements.json em voo (1 por vez)
// provas por requisito: UMA leitura por vez por tarefa. Antes a Entrega e a lista de requisitos chamavam
// loadReqProofs a cada render enquanto o cache estava vazio → várias leituras iguais em paralelo por tick.
// Invalidação no meio da carga (um envio zera o cache): cada invalidação sobe a geração da tarefa; a carga que
// termina numa geração velha descarta o resultado e busca de novo (antes gravava o dado velho e travava a nova).
const fwRpGen={}, fwArtGen={};
function fwInvalidate(taskId){ fwRpGen[taskId]=(fwRpGen[taskId]||0)+1; fwArtGen[taskId]=(fwArtGen[taskId]||0)+1; artifactsCache[taskId]=undefined; reqProofCache[taskId]=undefined; }
function fwReqProofsEnsure(taskId){
  if(reqProofCache[taskId]!==undefined || fwRpLoading[taskId]) return;
  const g=fwRpGen[taskId]||0; fwRpLoading[taskId]=1;
  loadReqProofs(taskId).finally(()=>{ delete fwRpLoading[taskId];
    if((fwRpGen[taskId]||0)!==g){ reqProofCache[taskId]=undefined; if(fwTask===taskId) fwReqProofsEnsure(taskId); return; }
    if(fwTask===taskId && fwVisible()) renderWorkspace(); });
}
// artefatos: idem (a tela da tarefa e a Entrega pediam a mesma lista no mesmo render)
function fwArtsEnsure(t){
  const c=artifactsCache[t.id];
  if((c && c.status===t.status) || fwArtLoading[t.id]) return;
  const g=fwArtGen[t.id]||0; fwArtLoading[t.id]=1;
  loadArtifacts(t.id, t.status).finally(()=>{ delete fwArtLoading[t.id];
    if((fwArtGen[t.id]||0)!==g){ artifactsCache[t.id]=undefined; const cur=fwTask===t.id?fwTaskObj():null; if(cur) fwArtsEnsure(cur); return; }
    if(fwTask===t.id && fwVisible()) renderWorkspace(); });
}
let fwFilesLoading=false; // task_files ainda não respondeu (≠ "nada ainda")
let fwFilesErr='';         // task_files falhou (≠ "nada ainda": antes o erro virava a frase "nada ainda" e mentia)
// R8: a lista de arquivos é da CÓPIA da tarefa — "criar repositório"/"publicar no GitHub" do catálogo não valem aqui
const FW_FILES_CTX='Não consegui listar os arquivos desta tarefa';
function fwFilesErrOwnAction(err){ const h=humanErr(err); return !!h.action && !['not-git','no-remote'].includes(h.id); }
const fwAskSent={};       // fwAskKey(pergunta) → resposta já enviada (trava as opções: 2 cliques = 2 respostas pra mesma pergunta)
// chave = id + criação: o id da pergunta do TETO é fixo por tarefa (budgetPendId) — só o id faria o PRÓXIMO teto
// nascer com as opções travadas
function fwAskKey(p){ return p.id+'|'+(p.createdAt||''); }
function fwAskIsSent(p){ return fwAskSent[fwAskKey(p)]!=null; }
// solta as travas das perguntas que já saíram do pending (respondidas de verdade)
function fwAskPrune(){ const live=new Set(((state&&state.pending)||[]).map(fwAskKey)); for(const k of Object.keys(fwAskSent)) if(!live.has(k)) delete fwAskSent[k]; }
// pergunta do teto de custo (sintética, id < 0): quem responde é a PESSOA — um envio automático nunca vale como resposta
function fwIsBudgetAsk(p){ return !!p && (p.kind==='budget' || +p.id<0); }
let fwFileLoading='';     // 'taskId|path' do read_file em voo (sem "editar" enquanto não chegou)
let fwReadErr='';         // read_file falhou → mostra o erro e NÃO deixa editar (salvaria o texto do erro no arquivo)
// árvore de arquivos recolhível (« / » / ⌘B). Sem escolha salva: recolhida em janela estreita.
function fwTreeHidden(){ const v=lsGet('fwTreeOff'); if(v==='1') return true; if(v==='0') return false; return window.innerWidth<1100; }
function fwToggleTree(){ lsSet('fwTreeOff', fwTreeHidden()?'0':'1'); renderWorkspace(); }
// árvore recolhida: um "»" de 18px sem rótulo não dizia nada e escondia também artefatos e custo →
// pílula clara "» Arquivos (N) · M artefatos" (mesmo atalho ⌘B)
function fwTreeOpenBtn(){
  if(!fwTreeHidden()) return '';
  const n=fwFiles.filter(f=>!f.doc).length;
  const ac=(typeof artifactsCache!=='undefined'&&fwTask)?artifactsCache[fwTask]:null;
  const na=ac&&Array.isArray(ac.list)?ac.list.filter(a=>a.name!=='requirements.json').length:0;
  return `<button class="fwtreepill" data-fwtree="on" title="mostrar arquivos, artefatos e custo (⌘B)"><span class="fwtpch">»</span>Arquivos${fwFilesLoading?'':` (${n})`}${na?` <span class="fwtpart">· ${na} artefato${na===1?'':'s'}</span>`:''}</button>`;
}
// guarda o arquivo/modo na ABA (voltar pra aba reabre onde você estava)
function fwRememberTab(){ if(!fwTask||typeof tabById!=='function') return; const tab=tabById('task:'+fwTask); if(tab){ tab.path=fwPath||null; tab.mode=fwMode; } }
function fwIsWorking(t){ return t.status!=='paused' && (ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !pendingOf(t.id).length; } // pausada = processo congelado, não "trabalhando"
function fwArtOnly(t){ return typeof taskType==='function' && ['invest','design'].includes(taskType(t)); }
// subtítulo do chat conforme o ESTADO (antes dizia "ele lembra o que fez" até em erro)
function fwChatSubText(t){
  if(pendingOf(t.id).length) return 'aguardando sua resposta';
  // fila do motor (snapshot: t.queued) — antes a mensagem "na fila" sumia sem nenhum sinal na tela
  const q=+t.queued||0;
  if(q && fwIsWorking(t)) return 'trabalhando… · '+nPl(q,'pedido','pedidos')+' na fila — ele lê quando terminar o turno atual';
  if(q) return nPl(q,'pedido parado','pedidos parados')+' na fila (o turno que ia executar foi encerrado) — mande uma mensagem pra retomar';
  if(fwIsWorking(t)) return 'trabalhando…';
  if(t.status==='error'){ const ev=lastEventOf(t.id), h=ev?humanErr(ev.text):null; // E1: diz O QUE deu errado quando é um erro conhecido
    return (h&&h.id!=='generic'?h.msg+' ':'parou com erro — ')+(h&&h.action?'('+h.action.label+') e depois mande uma mensagem pra ele seguir':'mande uma mensagem pra ele tentar seguir, ou rode de novo'); }
  if(t.status==='aborted') return 'interrompida — mande uma mensagem pra retomar, ou rode de novo';
  if(t.status==='conflict') return 'conflito com a base — resolva o conflito pra seguir';
  if(t.status==='paused') return 'pausada — clique em continuar';
  if(t.status==='draft') return 'rascunho — ainda não começou';
  if(t.status==='plan-review') return 'plano pronto — aprove pra ele começar a construir, ou peça ajustes aqui';
  if(t.status==='needs-you') return 'precisa de você — veja a decisão no topo da tarefa';
  if(t.status==='queued') return 'na fila — começa quando abrir uma vaga';
  return 'mesma sessão — ele lembra o que fez';
}
// "resolver conflito": o mesmo fluxo do botão do card (a IA mergeia a base e resolve na worktree)
async function fwResolveConflict(taskId, btn){
  if(!await askYes('A IA vai juntar a base e resolver os conflitos nesta worktree (sem push). Você revisa o resultado e integra. Continuar?')) return;
  const orig=btn?btn.innerHTML:'';
  if(btn){ btn.disabled=true; btn.textContent='resolvendo…'; }
  try{ await invoke('resolve_conflict',{ taskId }); prCache[taskId]=undefined; lastSig=''; await refresh(); }
  catch(err){ showErr(err, 'Não consegui resolver o conflito'); if(btn){ btn.disabled=false; btn.innerHTML=orig; } } // o rótulo volta (ficava "resolvendo…" pra sempre)
  renderWorkspace();
}
// pinta a seleção de linhas durante o arraste sem re-render completo (leve)
function fwPaintSel(){
  const sel=fwSelRange(); const code=$id('fwCode'); if(!code) return;
  code.querySelectorAll('.fwln').forEach(el=>{ const n=+el.dataset.ln; el.classList.toggle('sel', !!(sel&&n>=sel.a&&n<=sel.b)); });
  const bar=document.querySelector('.fwselbar'); const t=fwTaskObj();
  if(bar) bar.innerHTML = sel?`<b>linhas ${sel.a}${sel.b>sel.a?'–'+sel.b:''} selecionadas</b> · pergunte ao ${esc(t?t.agent:'agente')} no chat →`:'clique e <b>arraste</b> pra selecionar várias linhas (ou shift+clique) e pergunte no chat';
}
async function fwSaveFile(){
  const ta=$id('fwText'); if(!ta) return; const v=ta.value; const b=$id('fwSave'); if(b) b.disabled=true;
  try{ await invoke('write_file',{ taskId:fwTask, path:fwPath, content:v }); fwContent=v; fwEditing=false; lastSig=''; await refresh(); }
  catch(e){ showErr(e, 'Falha ao salvar'); if(b) b.disabled=false; return; } // falhou: o editor (e o texto) ficam
  renderWorkspace();
}
// sair do editor: se há alteração não salva, PERGUNTA antes de descartar
// E11a: tarefa de documentos com arquivos entregues que ainda não foram salvos na pasta do usuário
function fwArchiveNeedsSave(t){
  if(!t || typeof entregaArts!=='function') return false;
  if(lsGet('entregaSaved:'+t.id)) return false;
  return entregaArts(t).length>0;
}
async function fwLeaveEditor(){
  if(!fwEditing) return true;
  const ta=$id('fwText');
  if(ta && ta.value!==fwContent && !await askYes('Descartar as alterações não salvas neste arquivo?')) return false;
  fwEditing=false; return true;
}
window.addEventListener('mouseup', ()=>{ if(fwDrag){ fwDrag=false; renderWorkspace(); } });
function fwTaskObj(){ return (state.tasks||[]).find(t=>t.id===fwTask); }
let fwGroupMode='folder'; // 'folder' | 'deliverable'
function fwKeywords(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z0-9]+/).filter(w=>w.length>3); }
// agrupa arquivos por ENTREGÁVEL (vínculo heurístico por palavra-chave no caminho)
function fwGroupByDeliverable(files, dels){
  const norm=p=>String(p).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const groups=(dels||[]).map(d=>({label:d, kws:fwKeywords(d), files:[]}));
  const other={label:'outros arquivos', files:[], other:true};
  for(const f of files){ const np=norm(f.path); const hit=groups.filter(g=>g.kws.length&&g.kws.some(k=>np.includes(k))); if(hit.length) hit.forEach(g=>g.files.push(f)); else other.files.push(f); }
  return groups.filter(g=>g.files.length).concat(other.files.length?[other]:[]);
}
function fwDelivHtml(files, dels){
  const groups=fwGroupByDeliverable(files, dels);
  if(!groups.length) return '<div class="dim" style="padding:8px;font-size:var(--fs-xs)">nenhum arquivo alterado</div>';
  return `<div class="fwtreebody">`+groups.map(g=>{
    const rows=g.files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map(f=>{ const tag=f.doc?'·':((f.del===0&&f.add>0)?'A':'M');
      return `<button class="fwfile${f.path===fwPath?' on':''}" data-fwf="${escA(f.path)}" title="${escA(f.path)}" style="padding-left:20px"><span class="fwtag ${f.doc?'doc':(tag==='A'?'a':'m')}" title="${fwTagTitle(f,tag)}">${tag}</span><span class="fwfp mono">${esc(f.path.split('/').pop())}</span><span class="fwadd">+${f.add}</span></button>`;
    }).join('');
    return `<div class="fwdgrp${g.other?' other':''}"><span class="fwdmark">${g.other?'•':'✓'}</span><span class="fwdlabel">${esc(g.label)}</span><span class="fwdn">${g.files.length}</span></div>${rows}`;
  }).join('')+`</div>`;
}
// caminho no cabeçalho do Código/Revisão: a PASTA encolhe (…) e o NOME do arquivo fica sempre inteiro
// (antes cortava no fim: "src/page…" — justamente o nome sumia)
function fwPathHtml(p){ const s=String(p||'').replace(/\/+$/,''), i=s.lastIndexOf('/'); return `<span class="fwmpath mono" title="${escA(s)}">${i>=0?`<span class="fwmdir">${esc(s.slice(0,i+1))}</span>`:''}<span class="fwmname">${esc(s.slice(i+1))}</span></span>`; }
function fwTagTitle(f,tag){ return f.doc?'anexo/documento (não é alteração de código)':tag==='A'?'adicionado nesta tarefa':'modificado nesta tarefa'; }
function fwBuildTree(files){
  const root={dirs:{},files:[]};
  for(const f of files){ const parts=f.path.split('/'); let node=root;
    for(let i=0;i<parts.length-1;i++){ const d=parts[i]; node.dirs[d]=node.dirs[d]||{dirs:{},files:[],path:parts.slice(0,i+1).join('/')}; node=node.dirs[d]; }
    node.files.push(f); }
  return root;
}
function fwTreeHtml(node, depth){
  let h='';
  for(const d of Object.keys(node.dirs).sort()){ const dir=node.dirs[d]; const col=fwCollapsed.has(dir.path);
    h+=`<div class="fwdir" data-fwdir="${escA(dir.path)}" style="padding-left:${depth*13+8}px"><span class="fwchev">${col?'▸':'▾'}</span><span class="fwdname">${esc(d)}</span></div>`;
    if(!col) h+=fwTreeHtml(dir, depth+1);
  }
  for(const f of node.files.slice().sort((a,b)=>a.path.localeCompare(b.path))){ const tag=f.doc?'·':((f.del===0&&f.add>0)?'A':'M');
    h+=`<button class="fwfile${f.path===fwPath?' on':''}" data-fwf="${escA(f.path)}" title="${escA(f.path)}" style="padding-left:${depth*13+8}px"><span class="fwtag ${f.doc?'doc':(tag==='A'?'a':'m')}" title="${fwTagTitle(f,tag)}">${tag}</span><span class="fwfp mono">${esc(f.path.split('/').pop())}</span>${f.doc?'':`<span class="fwadd">+${f.add}</span>`}</button>`;
  }
  return h;
}
let fwMode='conversa';   // conversa | codigo | revisao | pr (modos da tela de execução)
let fwDiffCache={};      // taskId:path#add:del → texto do diff (Revisão e Código "só mudanças")
// R8: Código abre arquivo ALTERADO em "só mudanças" (diff) por padrão; "arquivo inteiro" é a outra opção
let fwCodeView=(lsGet('fwCodeView')==='full')?'full':'diff';
const fwDvOpen=new Set();  // trechos sem mudança expandidos ("mostrar"), por tarefa|arquivo|a-b
let fwContentFor='';       // 'taskId|path' a que fwContent pertence (pra expandir trechos com o arquivo certo)
// diff do arquivo, 1 busca por VERSÃO (chave muda quando +add/−del do arquivo muda) — o tick não rebusca
function fwDiffKey(t, path){ const f=fwFiles.find(x=>x.path===path)||{}; return t.id+':'+path+'#'+(f.add||0)+':'+(f.del||0); }
function fwDiffGet(t, path){
  if(!path) return '';
  const key=fwDiffKey(t, path);
  if(fwDiffCache[key]===undefined){
    fwDiffCache[key]=null;
    // erro também re-renderiza (antes o spinner ficava girando pra sempre)
    invoke('file_diff',{ taskId:t.id, path }).then(d=>{ fwDiffCache[key]=d||''; }).catch(e=>{ fwDiffCache[key]={ err:String(e&&e.message||e) }; })
      .finally(()=>{ if(fwTask===t.id && fwPath===path && (fwMode==='revisao'||fwMode==='codigo')) renderWorkspace(); });
  }
  return fwDiffCache[key];
}
// diff unificado de UM arquivo → hunks [{o,n,ctx,rows:[{t:'add'|'del'|'ctx',o,n,text}]}]. Arquivo novo sem
// cabeçalho @@ (o file_diff manda "+linha" pra untracked) vira um hunk só, a partir da linha 1.
function diffHunks(text){
  const hunks=[]; let h=null, o=0, n=0, isNew=false;
  for(const l of String(text||'').split('\n')){
    if(l===''||l.startsWith('\\')) continue; // fim do texto / "\ No newline at end of file"
    if(/^(diff --git|index |--- |\+\+\+ |similarity|rename |old mode|new mode|deleted file|Binary files)/.test(l)) continue;
    if(l.startsWith('new file')){ isNew=true; continue; }
    const m=l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    // contagem 0 ("-10,0" / "+4,0"): o número aponta a linha ANTERIOR — o trecho começa na seguinte
    if(m){ o=+m[1]; n=+m[3]; if(o===0&&m[2]==='0') isNew=true; h={ o:m[2]==='0'?o+1:o, n:m[4]==='0'?n+1:n, ctx:(m[5]||'').trim(), rows:[] }; hunks.push(h); continue; }
    if(!h){ o=0; n=1; isNew=true; h={ o:0, n:1, ctx:'', rows:[] }; hunks.push(h); }
    if(l[0]==='+') h.rows.push({ t:'add', n:n++, text:l.slice(1) });
    else if(l[0]==='-') h.rows.push({ t:'del', o:o++, text:l.slice(1) });
    else h.rows.push({ t:'ctx', o:o++, n:n++, text:l.slice(1) });
  }
  return { hunks, isNew };
}
// renderer ÚNICO do diff (Revisão + Código): nº antigo | nº novo | texto; cabeçalho "linhas 40–58";
// trechos sem mudança entre hunks recolhidos ("… 120 linhas sem mudança · mostrar" — só expande com o
// arquivo inteiro em mãos, `full`). Linhas com nº novo levam data-ln → seleção "perguntar no chat".
function diffViewHtml(d, o){
  o=o||{}; const full=o.full||null, sel=o.sel||null, pre=o.keyPre||'', MAX=5000; let count=0, out='';
  const row=(t, on, nn, text)=>{ count++; const inSel=sel&&nn&&nn>=sel.a&&nn<=sel.b;
    return `<div class="fwln dv ${t}${inSel?' sel':''}"${nn?` data-ln="${nn}"`:''}><span class="fwnum dvo">${on||''}</span><span class="fwnum">${nn||''}</span><span class="dvs">${t==='add'?'+':t==='del'?'−':''}</span><span class="fwtxt">${esc(text)||' '}</span></div>`; };
  const gap=(a, b, off)=>{ const k=pre+a+'-'+b, cnt=b-a+1; if(cnt<=0) return '';
    if(full && fwDvOpen.has(k)){ let r=''; for(let i=a;i<=b && i<=full.length;i++) r+=row('ctx', i+off, i, full[i-1]); return r+`<button class="dvgap" data-dvgap="${escA(k)}">▴ recolher ${cnt} ${cnt===1?'linha':'linhas'}</button>`; }
    return full ? `<button class="dvgap" data-dvgap="${escA(k)}">… ${cnt} ${cnt===1?'linha':'linhas'} sem mudança · <u>mostrar</u></button>`
      : `<div class="dvgap off">… ${cnt} ${cnt===1?'linha':'linhas'} sem mudança</div>`; };
  let nextN=1;
  for(const h of d.hunks){
    if(count>MAX){ out+=`<div class="dvgap off">…diff grande, cortado aqui — veja o arquivo inteiro</div>`; return out; }
    if(h.n>nextN && !d.isNew) out+=gap(nextN, h.n-1, h.o-h.n);
    const ns=h.rows.filter(r=>r.n).map(r=>r.n), a=ns.length?Math.min(...ns):h.n, b=ns.length?Math.max(...ns):h.n;
    const lbl=!ns.length?`linha ${a} · só remoções`:a===b?`linha ${a}`:`linhas ${a}–${b}`;
    out+=`<div class="dvhunk"><span>${lbl}</span>${h.ctx?`<span class="dvctx mono">${esc(h.ctx)}</span>`:''}</div>`;
    for(const r of h.rows) out+=row(r.t, r.o, r.n, r.text);
    const last=h.rows.reduce((m,r)=>r.n?Math.max(m,r.n):m, h.n-1); nextN=last+1;
    const lastO=h.rows.reduce((m,r)=>r.o?Math.max(m,r.o):m, h.o-1);
    h._off=(lastO+1)-(last+1);
  }
  if(full && d.hunks.length && !d.isNew && nextN<=full.length){ const lh=d.hunks[d.hunks.length-1]; out+=gap(nextN, full.length - (full[full.length-1]===''?1:0), lh._off||0); }
  return out;
}
// abre a tarefa como ABA própria (uma por tarefa) — mantém o chrome do app
function openWorkspace(taskId, path){
  // E6: abrir OUTRA tarefa com um arquivo em edição (fwOpenInner zera o editor) → pergunta antes de descartar
  if(fwEditing && fwTask && fwTask!==taskId){ fwLeaveEditor().then(ok=>{ if(ok) openWorkspace(taskId, path); }); return; }
  tabTaskPath=path||null;
  const id='task:'+taskId;
  const t=(state.tasks||[]).find(x=>x.id===taskId)||{};
  // cada aba lembra o PRÓPRIO arquivo e o PROJETO (antes: um tabTaskPath global — a aba B abria o arquivo da A,
  // e depois de trocar de projeto a aba velha abria uma tarefa que não existe no projeto atual)
  let tab=tabById(id); if(!tab){ tab={id, kind:'task', taskId, repo:state.repo, path:path||null, title:(t.title||'Tarefa').slice(0,26)}; TABS.push(tab); }
  else { if(t.title) tab.title=t.title.slice(0,26); if(path){ tab.path=path; tab.mode='codigo'; } if(!tab.repo) tab.repo=state.repo; }
  activateTab(id);
}
async function fwOpenInner(taskId, path){
  // voltando pra MESMA tarefa com o editor aberto: não joga fora o que está sendo editado
  if(fwTask===taskId && fwEditing && (path||null)===(fwPath||null) && $id('fwText')){ $id('fwOverlay').style.display='flex'; renderWorkspace(); return; }
  fwTask=taskId; fwPath=path; fwSelA=0; fwSelB=0; fwContent=''; fwAdded=[]; fwEditing=false; fwReadErr='';
  fwFiles=[]; fwEvents=[]; fwEvLast=0; fwLiveSig=''; fwAgentSel=null; fwFilesSig=''; fwFilesAt=0;
  fwFileLoading = path ? taskId+'|'+path : '';
  // modo inicial: o que a ABA lembra (voltou pra ela) › senão pela FASE da tarefa
  { const t=(state.tasks||[]).find(x=>x.id===taskId);
    const tab=(typeof tabById==='function')?tabById('task:'+taskId):null;
    // pronta pra revisar ou concluída → aba ENTREGA; rodando/perguntando → CONVERSA (é onde a ação está)
    fwMode = (tab&&tab.mode) ? tab.mode
      : path ? 'codigo'
      : (t&&pendingOf(t.id).length) ? 'conversa' // pergunta aberta: a resposta é na conversa
      : (t&&(taskIsDone(t)||['review','delivered'].includes(t.status))) ? 'entrega'
      : (t&&t.prUrl&&t.status!=='draft') ? 'pr'
      // erro, abortada, pausada, conflito, rascunho, plano: a ação e a explicação estão na CONVERSA (antes abria
      // em Código — uma coluna vazia "nenhum arquivo alterado ainda" no meio da tela)
      : 'conversa'; }
  $id('fwOverlay').style.display='flex';
  fwFilesLoading=true; fwFilesErr='';
  renderWorkspace(); // abre NA HORA (skeleton); os dados chegam em paralelo
  const pFiles = invoke('task_files',{ taskId }).then(f=>{ if(fwTask===taskId){ fwFiles=f||[]; fwFilesErr=''; } }).catch(e=>{ if(fwTask===taskId){ fwFiles=[]; fwFilesErr=String(e&&e.message||e)||'erro desconhecido'; } }).finally(()=>{ if(fwTask===taskId) fwFilesLoading=false; });
  const pEvs = fwFetchEvents();
  await pFiles;
  if(fwTask!==taskId) return; // trocou de tarefa/aba enquanto carregava: esta resposta já não vale
  if(fwPath && !fwFiles.some(f=>f.path===fwPath)) fwFiles.unshift({ path:fwPath, add:0, del:0, doc:true });
  if(!fwPath && fwFiles.length) fwPath=fwFiles[0].path;
  await Promise.all([fwLoadFile(), pEvs]);
  if(fwTask!==taskId) return;
  renderWorkspace();
}
// busca só o que é NOVO (id > último) — payload minúsculo por tick
async function fwFetchEvents(){
  if(!fwTask) return;
  const tk=fwTask;
  try{ const rows=evNormAll((await invoke('task_events',{ taskId:tk, sinceId:fwEvLast })||[]).filter(e=>e.id>fwEvLast));
    if(fwTask!==tk) return; // trocou de tarefa no meio: não mistura os eventos
    if(rows.length){ fwEvents.push(...rows); fwEvLast=rows[rows.length-1].id; } }catch(_){ }
}
async function fwLoadFile(){
  fwCodeView=(lsGet('fwCodeView')==='full')?'full':'diff'; // abriu outro arquivo: volta pra preferência (editar força "inteiro" só naquele)
  if(!fwPath){ fwContent=''; fwAdded=[]; fwReadErr=''; renderWorkspace(); return; }
  const tk=fwTask, pth=fwPath; // arquivo/tarefa trocados enquanto lia → descarta a resposta velha
  let content, added, err='';
  fwFileLoading=tk+'|'+pth; fwReadErr='';
  try{ const r=await invoke('read_file',{ taskId:tk, path:pth }); content=r.content||''; added=r.addedLines||[]; }
  catch(e){ content=''; added=[]; err=String(e&&e.message||e)||'erro desconhecido'; }
  if(fwFileLoading===tk+'|'+pth) fwFileLoading='';
  if(fwTask!==tk || fwPath!==pth) return;
  fwContent=content; fwAdded=added; fwReadErr=err; fwContentFor=err?'':tk+'|'+pth;
  fwSelA=0; fwSelB=0; renderWorkspace();
}
function closeWorkspace(){
  // painel da tela dividida (58-canvas): fechar a demanda = sair da divisão (a aba continua lá em cima)
  if(typeof SF_PANE!=='undefined' && SF_PANE){ try{ window.parent.cvPaneRequestClose(window.frameElement&&window.frameElement.dataset.tabid); }catch(_){ } return; }
  const o=$id('fwOverlay'); if(o){ o.classList.remove('astab'); o.style.display='none'; } if(typeof closeTab==='function' && fwTask) closeTab('task:'+fwTask); }
function fwSelRange(){ if(!fwSelA) return null; const a=Math.min(fwSelA,fwSelB||fwSelA), b=Math.max(fwSelA,fwSelB||fwSelA); return {a,b}; }
function fwPlan(t){
  const roles=t.roles||[]; if(!roles.length) return '';
  let cur=roles.findIndex(r=>r.role===t.stage); if(cur<0) cur=0;
  const fin=(t.status==='review'||t.status==='merged'||t.status==='done');
  return `<div class="fwplan">`+roles.map((r,i)=>{
    let cls = fin||i<cur?'done':(i===cur&&ACTIVE_ST.has(t.status)?'cur':'wait');
    const mark = cls==='done'?IC.check:cls==='cur'?'<span class="spin"></span>':(i+1);
    return `<div class="fwpstep ${cls}"><span class="fwmark">${mark}</span><span class="fwsteptx">${ROLE_PT[r.role]||r.role} · ${esc(r.name)}</span></div>`;
  }).join('')+`</div>`;
}
let fwCtxOpen=(lsGet('fwCtxOpen')==='1');
// papel da etapa em andamento, em PT e como ação (antes aparecia "BUILD" — o id do papel em inglês)
// R8: a faixa de estado é frase ("Construindo"), não rótulo em maiúsculas
function capFirst(s){ s=String(s||''); return s.charAt(0).toUpperCase()+s.slice(1); }
const ROLE_DOING={ planner:'planejando', builder:'construindo', reviewer:'revisando', tester:'testando', designer:'desenhando', investigator:'investigando' };
// barra compacta: estado da tarefa + progresso dos requisitos (expande no clique)
function fwCtxBarHtml(t){
  const asking=pendingOf(t.id);
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !asking.length;
  // estado final: selo padrão (PT + ícone certo) — antes era "✓ error" em inglês, com ✓ até em falha
  const st = asking.length?`<span class="fwctxst" style="color:var(--st-ask)"><span class="pulse" style="--pc:var(--st-ask)"></span>aguardando você</span>`
    : working?`<span class="fwctxst" style="color:var(--good)"><span class="pulse" style="--pc:var(--good)"></span>${esc(capFirst(ROLE_DOING[t.stage]||'trabalhando'))}</span>`
    : `<span class="fwctxst">${stBadge(taskSt(t))}</span>`; // R5-1: status efetivo (PR aberto igual à Central)
  const reqs=Array.isArray(t.requirements)?t.requirements:[];
  let reqPart='';
  if(reqs.length){
    const c=reqProofCache[t.id];
    if(c&&Array.isArray(c.list)){
      const matched=matchReqProofs(reqs, c.list);
      const done=matched.filter(m=>m&&m.status==='done').length;
      const pct=reqs.length?Math.round(done/reqs.length*100):0;
      reqPart=`<span class="fwctxreq">requisitos <b>${done}/${reqs.length}</b><span class="minibar"><i style="width:${pct}%"></i></span></span>`;
    } else {
      // rodando: as provas ainda vão chegar — aviso só depois que o agente parou
      // "sem provas" só depois da construção (pronta pra revisar/entregue) — no plano ou no rascunho ainda não há o
      // que provar; e sem quebrar linha (na coluna estreita virava uma torre de 5 linhas)
      const noProof=!working && !asking.length && ['review','delivered'].includes(t.status);
      reqPart=`<span class="fwctxreq">requisitos <b>${reqs.length}</b>${noProof?' <span class="fwctxnp" title="o agente ainda não gerou as provas dos requisitos — abra e use &quot;verificar requisitos agora&quot;">· sem provas</span>':''}</span>`;
    }
  }
  // seta de verdade (SVG) — o "▸" de 10px sumia e parecia um ponto solto no canto
  return `${st}${reqPart}<span class="fwctxchev${fwCtxOpen?' open':''}${reqPart?'':' solo'}" aria-hidden="true">${IC.cright}</span>`;
}
function fwNowHtml(t){
  const ev=lastEventOf(t.id);
  if(ACTIVE_ST.has(t.status)){
    const evsN=fwEvents.length?fwEvents:eventsOf(t.id);
    const lastThink=[...evsN].reverse().find(e=>e.type==='think'&&(e.text||'').trim());
    const narr=lastThink?`<div class="nowsay"><span class="nsav" aria-hidden="true" style="background:${agentColor(lastThink.agent)}">${agentBadge(lastThink.agent)}</span><div class="nowsaytx clamp4">${esc(lastThink.text)}</div></div>`:'';
    return `<div class="fwnowh"><span class="pulse" style="--pc:var(--good)"></span>O que estou fazendo agora <span class="fwnowstep">${esc(ROLE_DOING[t.stage]||'')}</span></div>${narr}<div class="fwnowtx">${ev?esc(ev.text):'iniciando…'}</div>${typeof cicloPaint==='function'?'':fwPlan(t)}${(t.roles||[]).some(r=>aiCanTalk(r.engine))?`<button class="btn sm fwsteer" id="fwSteer">${IC.hand} mudar o rumo</button>`:''}`;
  }
  // estado final: as etapas vivem na FAIXA do topo (60-ciclo, P1) — aqui só sem ela
  return typeof cicloPaint==='function'?'':fwPlan(t);
}
let fwLiveSig='';
let fwPrimShown=''; // id da ação principal que o topo está mostrando
let fwPvShown=null; // preview (ícone de globo) que o cabeçalho da tarefa está mostrando
async function fwLiveUpdate(){
  const t=fwTaskObj(); if(!t) return;
  fwAskPrune(); // pergunta que saiu do pending solta a trava (o próximo teto da mesma tarefa nasce destravado)
  if(!fwFetching){ fwFetching=true; try{ await fwFetchEvents(); }catch(_){ } fwFetching=false; }
  const evs0=fwEvents.length?fwEvents:eventsOf(t.id);
  const rp=reqProofCache[t.id];
  fwLiveTick();
  // estado das bolhas otimistas muda com o TEMPO (20s sem turno → "não começou"): atualiza antes da assinatura
  fwOptimFor(t.id, evs0, { now:Date.now(), working:(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy), queued:t.queued });
  // busy/prUrl/flag/stage entram na assinatura: mudam a ação do topo (parar ↔ enviar, "ver PR") e a barra de envio
  // sem mexer no status — antes o cabeçalho ficava velho até chegar outro evento
  const sig=[t.id,t.status,t.busy?1:0,t.prUrl||'',t.flag||'',t.stage||'',evs0.length,evs0.length?evs0[evs0.length-1].id:0,pendingOf(t.id).length,t.queued||0,(fwOptim[t.id]||[]).map(o=>o.st).join(','),(rp&&Array.isArray(rp.list))?rp.list.filter(x=>x.status==='done').length:'-'].join('|');
  // PR na tela e dados velhos (>60s) → busca de novo em segundo plano
  if(fwMode==='pr' && typeof prIsStale==='function' && prIsStale(t.id)){ loadPr(t.id,true).then(()=>{ if(fwTask===t.id&&fwMode==='pr') renderWorkspace(); }); }
  { const ag=$id('prAge'); const pi=prCache[t.id]; if(ag&&pi&&pi._at&&typeof prAgoTx==='function') ag.textContent=prAgoTx(pi._at); }
  // Prévia: requisitos por cima do app ("requisito 3 ✓ com print" — 58-canvas; guarda própria)
  if(fwMode==='previa' && typeof cvReqOverlayPaint==='function') cvReqOverlayPaint(t.id);
  if(typeof termHistTick==='function') termHistTick(t); // aba Terminal sem PTY: o histórico acompanha a sessão em segundo plano
  if(sig===fwLiveSig) return; // nada mudou → não mexe no DOM (digitação fica leve)
  fwLiveSig=sig;
  // o agente anunciou/trocou o preview DEPOIS de a aba abrir: o cabeçalho (fwReviewBar) só era montado
  // no renderWorkspace → o botão de preview nunca aparecia com a aba aberta
  if((taskPreviewTarget(t)||null)!==fwPvShown){ renderWorkspace(); return; }
  // a fase mudou (rodando → revisão, pergunta chegou…): a ação principal do topo muda junto
  if(((fwPrimaryAction(t)||{}).id||'')!==fwPrimShown){ renderWorkspace(); return; }
  const now=$id('fwNow'); if(now){ now.className='fwnow'+(ACTIVE_ST.has(t.status)?'':' done'); now.innerHTML=fwNowHtml(t); const b=$id('fwSteer'); if(b) b.onclick=()=>{ const inp=$id('fwInput'); if(inp){ inp.focus(); inp.placeholder='descreva a mudança de rumo'; } }; }
  // conversa + requisitos ao vivo (o input não é tocado — foco/texto preservados)
  const th=$id('fwThread');
  if(th && !th.dataset.term){ const atBottom=th.scrollHeight-th.scrollTop-th.clientHeight<80; th.innerHTML=fwThreadHtml(t); if(atBottom) th.scrollTop=th.scrollHeight; }
  const rq=$id('fwReqs'); if(rq) rq.innerHTML=fwReqsHtml(t);
  if(typeof tlLivePaint==='function') tlLivePaint(t); // modo terminal: barra, painel de requisitos e folha de pergunta
  const cb=$id('fwCtxBar'); if(cb) cb.innerHTML=fwCtxBarHtml(t);
  const sub=$id('fwChatSub');
  if(sub) sub.textContent=fwChatSubText(t);
  // botões de envio + dica mudam com o estado (trabalhando → "na fila" vira o principal)
  fwPaintSendRow(t);
  // árvore de arquivos AO VIVO: o agente cria/edita → aparece sem fechar o editor
  if(!fwFilesAt || Date.now()-fwFilesAt>4000){
    fwFilesAt=Date.now();
    invoke('task_files',{ taskId:t.id }).then(f=>{
      if(fwTask!==t.id) return; // trocou de tarefa enquanto buscava: não pinta os arquivos da outra
      f=f||[];
      const s=f.map(x=>x.path+':'+x.add+':'+x.del).join('|');
      if(s!==fwFilesSig||fwFilesErr){ fwFilesSig=s; fwFiles=f; fwFilesLoading=false; fwFilesErr=''; renderWorkspace(); }
    }).catch(()=>{});
  }
}
let fwFilesAt=0, fwFilesSig='';
// fase da tarefa no funil do redesign: Descoberta→Despacho→Execução→Revisão→PR
const PHASES=['Descoberta','Despacho','Execução','Revisão','PR'];
function taskPhase(t){
  if(t.prUrl) return 5;
  if(['review','delivered','merged','done','conflict'].includes(t.status)) return 4;
  // 'queued' está no ACTIVE_ST: tem que vir ANTES da checagem de execução (senão nunca caía em Despacho)
  if(['queued','plan-review'].includes(t.status)) return 2;
  if(t.status==='needs-you') return 3;
  // erro/abortada pararam NA execução (antes caíam em "Descoberta", como se nem tivessem começado)
  if(ACTIVE_ST.has(t.status)||['thinking','paused','error','aborted'].includes(t.status)) return 3;
  return 1;
}
// cabeçalho: UMA pílula de estado (crítica Impeccable P2) — antes eram 5 pontos + rótulo da fase, somados à barra
// de estado do chat e ao % do card (3 indicadores de progresso). As 5 fases ficam no tooltip.
function phasesHtml(t){
  const ph=taskPhase(t), fin=taskIsDone(t); // concluída: todas as etapas feitas
  const lbl=fin?'Concluída':PHASES[ph-1];
  const col=(typeof stColor==='function'&&typeof taskSt==='function')?stColor(taskSt(t)):'var(--good)';
  const tip='fase '+(fin?PHASES.length:ph)+' de '+PHASES.length+': '+PHASES.map((p,i)=>(fin||i+1<ph)?p+' ✓':i+1===ph?'['+p+']':p).join(' → ');
  return `<span class="fwstpill" title="${escA(tip)}"><i class="fwstd" style="background:${col}" aria-hidden="true"></i>${esc(lbl)}</span>`;
}
// barra de envio do chat: os botões e a dica mudam com o estado. Trabalhando, Enter põe NA FILA
// (não interrompe); interromper e mandar já é ⌘Enter ou o menu ▾ ao lado do envio.
// Vermelho só pra PARADA de verdade (crítica Impeccable P2, 02/10): o "■ parar" do cabeçalho. O composer tem UM
// envio neutro — antes "parar e enviar" vermelho + "na fila" verde (6 vermelhos com 3 painéis lado a lado).
// O envio só é verde quando o cabeçalho não tem ação principal (um verde por tela).
// @composer-envio-inicio (testado em app/tests/critica-impeccable.test.mjs)
function fwSendRowOf(o){
  const cls=o.headPrimary?'btn sm cc-send':'btn primary sm cc-send';
  const btns = o.asking ? `<button class="${cls}" id="fwSend" style="white-space:nowrap">responder</button>`
    : o.working ? `<button class="btn sm cc-send" id="fwQueue" style="white-space:nowrap" title="não interrompe: o agente lê quando terminar o turno atual (Enter)">na fila</button><button class="btn sm cc-sendmore" id="fwSendMore" aria-haspopup="menu" aria-expanded="false" aria-label="mais opções de envio" title="mais opções de envio (interromper e enviar já: ⌘Enter)"><span aria-hidden="true">▾</span></button>`
    : `<button class="${cls}" id="fwSend" style="white-space:nowrap">enviar</button>`;
  const hint = o.asking ? '<span class="kbd">Enter</span> responde · <span class="kbd">⇧Enter</span> quebra linha'
    : o.working ? '<span class="kbd">Enter</span> põe na fila (não interrompe) · <span class="kbd">⌘Enter</span> interrompe e envia já'
    : '<span class="kbd">Enter</span> envia · <span class="kbd">⇧Enter</span> quebra linha';
  return { btns, hint, key:(o.asking?'a':o.working?'w':'i')+(o.headPrimary?'h':'') };
}
// @composer-envio-fim
function fwSendRowHtml(t){
  const a=fwPrimaryAction(t);
  return fwSendRowOf({ asking:pendingOf(t.id).length>0, working:fwIsWorking(t), headPrimary:!!(a && !a.cls) }); // a.cls = botão não-verde (parar, PR #n)
}
// menu ▾ do envio (trabalhando): "interromper e enviar já" — mesma semântica do ⌘Enter
function fwSendMoreOpen(anchor){
  const old=$id('fwSendPop'); if(old){ old.remove(); anchor.setAttribute('aria-expanded','false'); return; }
  const pop=document.createElement('div'); pop.id='fwSendPop'; pop.className='fwmenu'; pop.setAttribute('role','menu');
  pop.innerHTML=`<button class="fwmi" role="menuitem" data-fwsend="now"><span>interromper e enviar já</span><span class="fwmh">⌘Enter · para o turno atual</span></button>`;
  document.body.appendChild(pop); anchor.setAttribute('aria-expanded','true');
  const r=anchor.getBoundingClientRect();
  pop.style.top=Math.max(8, r.top-pop.offsetHeight-6)+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.right-pop.offsetWidth))+'px';
  const close=(back)=>{ pop.remove(); anchor.setAttribute('aria-expanded','false'); document.removeEventListener('mousedown', out, true); if(back) try{ anchor.focus(); }catch(_){ } };
  const out=e=>{ if(!pop.contains(e.target) && e.target!==anchor && !anchor.contains(e.target)) close(false); };
  setTimeout(()=>document.addEventListener('mousedown', out, true), 0);
  pop.querySelector('[data-fwsend]').onclick=()=>{ close(false); fwSendMsg(false); };
  if(typeof a11yMenu==='function') a11yMenu(pop, anchor, close); else { const b=pop.querySelector('button'); if(b) b.focus(); }
}
function fwWireSendBtns(){
  bindClick('fwSend', ()=>fwSendMsg(false));
  bindClick('fwQueue', ()=>fwSendMsg(true));
  bindClick('fwSendMore', (e)=>{ e.stopPropagation(); fwSendMoreOpen(e.currentTarget); });
}
function fwPaintSendRow(t){
  const box=$id('fwSendBtns'); if(!box) return;
  const r=fwSendRowHtml(t);
  if(box.dataset.k===r.key) return; // nada mudou → não mexe no DOM
  box.dataset.k=r.key; box.innerHTML=r.btns;
  const h=$id('fwHint'); if(h) h.innerHTML=r.hint;
  fwWireSendBtns();
}
// ---- cabeçalho FIXO da tarefa: título (…) · modos · UMA ação principal por fase · menu ⋯ ----
// antes eram até 7 controles que quebravam linha/cortavam o título conforme o modo; no PR o
// "commit & push" ficava ao lado de "aprovar e abrir PR" e o vibe coder não sabia qual apertar.
function fwPrNum(t){ return (String((t&&t.prUrl)||'').match(/\/pull\/(\d+)/)||[])[1]||''; }
function fwPrimaryAction(t){
  // rascunho: o topo não tinha ação nenhuma — começar é o próximo passo óbvio (mesmo ▶ iniciar da Central)
  if(t.status==='draft') return { id:'fwStartDraft', html:`${IC.play} iniciar`, title:'começa a execução com o que já está no rascunho' };
  // exceção do ciclo (teto/rodadas/veredito): a decisão está na seção do topo — o verde leva até ela
  if(t.status==='needs-you') return { id:'fwDecide', html:`${IC.hand} decidir`, title:'a tarefa parou numa exceção (teto, rodadas de revisão ou veredito) — a decisão está no topo da tarefa' };
  if(pendingOf(t.id).length) return { id:'fwAnswer', html:`${IC.hand} responder`, title:'o agente fez uma pergunta — a resposta vai na conversa' };
  if(fwIsWorking(t)) return { id:'fwStopTop', cls:'btn sm fwstopbtn trk-stop', html:`${IC.stop} parar`, title:'interrompe o turno atual do agente (dá pra mandar outra instrução depois)' };
  if(['error','aborted'].includes(t.status)) return { id:'fwRerun', html:`${IC.retry} rodar de novo`, title:'descarta o parcial na worktree e roda o time de novo (o plano é mantido)' };
  if(t.status==='conflict') return { id:'fwResolve', html:`${IC.bolt} resolver conflito`, title:'a IA junta a base na branch e resolve os conflitos na worktree; você revisa e integra' };
  if(t.status==='paused') return { id:'fwResume', html:`${IC.play} continuar`, title:'retoma a tarefa de onde parou' };
  if(t.status==='plan-review') return { id:'fwApprovePlan', html:`${IC.play} aprovar plano`, title:'o plano está pronto — aprovar deixa o time começar a construir' };
  // PR aberto: o atalho "PR #n" fica SEMPRE à mão (na aba PR ele abre o GitHub)
  if(t.prUrl){ const n=fwPrNum(t);
    return fwMode==='pr' ? { id:'fwPrGh', cls:'btn sm', html:`${IC.extlink} PR #${n}`, title:'abrir o PR no GitHub' }
      : { id:'fwPrGo', html:`${IC.merge} ver PR #${n}`, title:'comentários, checagens e merge do PR' }; }
  if(taskIsDone(t)) return null;
  if(['review','delivered'].includes(t.status)){
    const rev=reviewOf(t.id);
    // E11a: investigação/design — o fim é "salvar entregáveis na pasta" (Entrega, FT-6) e concluir
    return fwArtOnly(t) ? ((fwArchiveNeedsSave(t))
        ? { id:'fwArchive', html:`${IC.check} salvar e concluir`, title:'salva os arquivos entregues numa pasta sua e conclui (investigação/design não abrem PR)' }
        : { id:'fwArchive', html:`${IC.check} concluir`, title:'conclui e tira da fila (investigação/design não abrem PR)' })
      // portão de prova (21: proofGate): requisito sem prova → o verde é PEDIR a prova; aprovar fica no secundário
      : (typeof proofGate==='function' && proofGate(t).st==='unproven')
        ? { id:'fwAskProof', html:`${IC.ai} pedir a prova ao agente`, title:proofMissingTip(proofGate(t))+' — manda a lista no chat' }
      : { id:'fwApprove', html:`${IC.check} aprovar e abrir PR`, title:rev?(rev.summary||'').slice(0,160):'checagens do repo, depois commit & push e cria o PR' };
  }
  return null;
}
// R8: o "push" VISÍVEL no topo (R7) saiu a pedido do dono — "commit & push" fica só no ⋯ (fwMoreItems).
function fwActionHtml(t){
  const a=fwPrimaryAction(t);
  // sem prova: o "aprovar sem prova…" fica à vista ao lado (some no cabeçalho estreito — continua no ⋯)
  const sec=(a&&a.id==='fwAskProof')?`<button class="btn sm ghost fwnoproof" id="fwNoProof" title="exige um motivo — vai na descrição do PR e fica registrado">aprovar sem prova…</button>`:'';
  if(!a) return sec;
  const lbl=String(a.html).replace(/<[^>]*>/g,'').trim();
  const html=String(a.html).replace(/([^>]*)$/, (m)=>m.trim()?`<span class="fwal">${m}</span>`:m);
  return sec+`<button class="${a.cls||'btn primary sm'}" id="${a.id}" title="${escA(a.title||'')}" aria-label="${escA(lbl)}">${html}</button>`;
}
// itens do ⋯ (secundários) — só o que faz sentido na fase atual
function fwMoreItems(t){
  const it=[], done=taskIsDone(t), nogit=document.body.classList.contains('nogit');
  const prim=(fwPrimaryAction(t)||{}).id;
  const pv=taskPreviewTarget(t), tun=(typeof tunnelUp!=='undefined')?tunnelUp[t.id]:null;
  it.push({ k:'sum', label:`resumo e progresso · ${taskPct(t)}%`, hint:'tudo que já foi feito + o que falta' });
  if(t.status==='draft' && typeof editDraft==='function') it.push({ k:'editdraft', label:'editar o rascunho', hint:'reabre a Nova demanda preenchida' });
  if(prim==='fwAskProof') it.push({ k:'noproof', label:'aprovar sem prova…', hint:'exige um motivo — vai no PR' });
  if(['review','delivered'].includes(t.status) && !t.prUrl) it.push({ k:'askfix', label:'pedir ajuste', hint:'vira instrução direta pro agente' });
  if(t.prUrl){ const n=fwPrNum(t);
    if(prim!=='fwPrGo' && fwMode!=='pr') it.push({ k:'prgo', label:`ver PR #${n} aqui` });
    if(prim!=='fwPrGh') it.push({ k:'prgh', label:`abrir PR #${n} no GitHub` });
    it.push({ k:'prcopy', label:'copiar link do PR' });
  } else if(!done && !nogit && !fwArtOnly(t) && t.status!=='draft' && !['review','delivered'].includes(t.status)){
    it.push({ k:'propen', label:'abrir PR', hint:'checagens do repo, depois commit & push e cria o PR' });
  }
  if(pv){ it.push({ k:'pv', label:'abrir o preview', hint:pv.replace(/^https?:\/\//,'').slice(0,40) });
    it.push(tun?{ k:'pvoff', label:'fechar o acesso do celular', warn:true }:{ k:'pvmob', label:'abrir o preview no celular', hint:'túnel criptografado' }); }
  // ações que moravam no painel lateral (removido) — voltam aqui, só na fase em que fazem sentido
  const ty=(typeof taskType==='function')?taskType(t):'feat';
  if(ACTIVE_ST.has(t.status)) it.push({ k:'pause', label:'pausar', hint:'congela o agente — "continuar" retoma de onde parou' });
  if((ty==='design'||ty==='invest') && ['review','delivered','merged','error','aborted'].includes(t.status))
    it.push({ k:'fromdz', label:ty==='design'?'criar entrega a partir deste design':'criar entrega a partir desta investigação', hint:ty==='design'?'mockup + DESIGN.md viram referência obrigatória':'INVESTIGATION.md + evidências viram referência' });
  if(t.kind!=='review' && ['draft','review','delivered','merged'].includes(t.status))
    it.push({ k:'breakdown', label:'desdobrar em épico', hint:'a IA propõe sub-tarefas no backlog do time' });
  if(t.kind!=='review' && ['review','delivered','merged','error','aborted','conflict'].includes(t.status))
    it.push({ k:'linkfix', label:'abrir correção linkada', hint:'algo quebrou? nova tarefa ligada a esta' });
  { const cid=(typeof tmap==='function')?tmap()[t.id]:null, ac=(typeof artifactsCache!=='undefined')?artifactsCache[t.id]:null;
    if(cid && typeof SB!=='undefined' && SB.sess() && ac && (ac.list||[]).length && typeof cloudPublishProofs==='function')
      it.push({ k:'pubproofs', label:`publicar provas no time · ${ac.list.length}`, hint:'envia os artefatos pro card do time' }); }
  (t.status!=='draft'&&Array.isArray(t.refs)?t.refs:[]).slice(0,6).forEach((r,i)=>{ const n=String(r).split('/').pop();
    it.push({ k:'ref:'+i, label:`ver referência · ${n}`, hint:'anexo da tarefa' }); });
  if(!done && t.status!=='draft' && !nogit) it.push({ k:'push', label:'commit & push', hint:'commita o que estiver solto e envia a branch — o PR atualiza na hora' });
  // o modelo NÃO mora mais aqui: é a pílula embaixo da caixa do chat (fwModelPill), como nos apps de chat
  const cost=taskCost(t.id);
  { const cap=(typeof budgetOf==='function')?budgetOf(t):0;
    it.push({ k:'cost', label:`custo · ${cost.usd>0?fmtCost(cost.usd):'—'}${cost.tok?' · '+fmtTok(cost.tok)+' tok':''}${cap>0?' · teto '+fmtCost(cap,{usdOnly:true}):''}`, info:true }); }
  // Dispositivo (57) saiu do cabeçalho — o "+ → Simulador" do topo já abre o celular; aqui fica o painel docado
  { const di=(typeof DV!=='undefined')?DV.info[t.id]:null;
    if(di && di.mobile && (di.platforms||[]).length && typeof dvToggle==='function')
      it.push({ k:'dev', label:(typeof dvIsOpen==='function'&&dvIsOpen(t.id))?'esconder o Dispositivo':'mostrar o Dispositivo ao lado', hint:'simulador/emulador desta tarefa ao vivo' }); }
  if(fwTreeHidden()) it.push({ k:'tree', label:'mostrar arquivos e artefatos', hint:'⌘B' });
  it.push({ k:'close', label:'fechar a aba', hint:'esc' });
  return it;
}
// pílula da IA no composer da tarefa: motor · modelo de AGORA; clicar abre o mesmo menu de sempre (openModelMenu,
// que grava via set_task_model). Rascunho não tem (nunca teve o item "modelo" — a IA dele é escolhida no formulário).
function fwModelPill(t){
  if(!t || t.status==='draft') return null;
  return { id:'fwModel', label:aiRunLabel(t.engine, t.model), title:CHAT_MODEL_TIP, onPick:(b)=>openModelMenu(t.id, b) };
}
function fwOpenMore(t, anchor){
  const old=$id('fwMorePop'); if(old){ old.remove(); return; }
  const pop=document.createElement('div'); pop.id='fwMorePop'; pop.className='fwmenu';
  pop.innerHTML=fwMoreItems(t).map(i=>i.info?`<div class="fwmi info">${esc(i.label)}</div>`
    :`<button class="fwmi${i.warn?' warn':''}" data-fwm="${i.k}"${i.tip?` title="${escA(i.tip)}"`:''}><span>${esc(i.label)}</span>${i.hint?`<span class="fwmh">${esc(i.hint)}</span>`:''}</button>`).join('');
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.top=(r.bottom+6)+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.right-pop.offsetWidth))+'px';
  const close=()=>{ pop.remove(); document.removeEventListener('mousedown', out, true); };
  const out=e=>{ if(!pop.contains(e.target) && e.target!==anchor) close(); };
  setTimeout(()=>document.addEventListener('mousedown', out, true), 0);
  pop.querySelectorAll('[data-fwm]').forEach(b=>b.onclick=async()=>{ const k=b.dataset.fwm; close(); await fwMoreDo(t, k, anchor); });
}
async function fwMoreDo(t, k, anchor){
  const pv=taskPreviewTarget(t);
  if(k==='sum') openTaskSummary(t.id);
  else if(k==='askfix') fwAskFix();
  else if(k==='noproof') await approveNoProof(t);
  else if(k==='editdraft') await editDraft(t);
  else if(k==='prgo'){ fwMode='pr'; fwRememberTab(); renderWorkspace(); }
  else if(k==='prgh') openExternal(t.prUrl);
  else if(k==='prcopy') copyLink(t.prUrl);
  else if(k==='propen') prPrepOpen(t.id, lsGet('prBase:'+t.id)||'main');
  else if(k==='pv' && pv) invoke('open_url',{ url:pv }).catch(e=>showErr(e, 'Não consegui abrir o preview'));
  else if(k==='pvmob' && pv){ toast('criando o túnel pro celular…'); const pub=await mobilePreview(t.id, pv); if(pub && typeof tunnelUp!=='undefined') tunnelUp[t.id]=pub; renderWorkspace(); }
  else if(k==='pvoff') await fwTunnelOff(t);
  else if(k==='push') await fwPushTask();
  else if(k==='tree') fwToggleTree();
  else if(k==='dev') dvToggle();
  else if(k==='pause') await pauseTask(t.id);
  else if(k==='fromdz') await openFromDesign(t);
  else if(k==='breakdown') await openBreakdown(t);
  else if(k==='linkfix') await openLinkedFix(t);
  else if(k==='pubproofs') await cloudPublishProofs(t, null);
  else if(k.startsWith('ref:')){ const r=(t.refs||[])[+k.slice(4)]; if(r) await openRef(t.id, String(r).split('/').pop()); }
  else if(k==='close'){ if(await fwLeaveEditor()) closeWorkspace(); }
}
function fwAskFix(){ if(fwMode!=='conversa'){ fwMode='conversa'; fwRememberTab(); renderWorkspace(); } // o chat pode estar escondido (Entrega/PR)
  // modo terminal: a pergunta mora na folha por cima do terminal (60-terminal-layout)
  { const t=fwTaskObj(); if(t && termViewOf(t) && typeof tlAskOf==='function'){ const a=tlAskOf(t); if(a){ a.st.min=false; tlAskPaint(t, true); return; } } }
  const i=$id('fwInput'); if(i){ i.placeholder='descreva o ajuste — vira instrução direta pro agente'; i.focus(); } }
async function fwTunnelOff(t){
  // falhou ao fechar: diz (antes avisava "acesso fechado" com o túnel ainda aberto pro celular)
  try{ await invoke('tunnel_stop',{ taskId:t.id }); }catch(e){ showErr(e, 'Não consegui fechar o acesso do celular'); return; }
  if(typeof tunnelUp!=='undefined') delete tunnelUp[t.id];
  if(typeof autoTunneled!=='undefined') delete autoTunneled[t.id];
  try{ const cid=tmap()[t.id]; if(cid){ const cur=(await sbGet('tasks?select=spec&id=eq.'+cid))[0]||{}; await sbFetch('/rest/v1/tasks?id=eq.'+cid,{method:'PATCH',body:JSON.stringify({spec:{...(cur.spec||{}),previewUrl:null,tunnelWanted:null,tunnelClose:null}})}); } }catch(_){ }
  toast('acesso do celular fechado','ok'); renderWorkspace();
}
// commit & push (manutenção: mora no ⋯)
async function fwPushTask(){
  const t=fwTaskObj(); if(!t) return;
  toast('commitando e enviando a branch…');
  try{ const msg=await invoke('push_task',{ taskId:t.id }); prCache[t.id]=undefined; commitsCache[t.id]=undefined; lastSig=''; toast(msg,'ok'); }
  catch(e){ showErr(e, 'Commit & push falhou'); } // recusa por histórico divergente (non-fast-forward/fetch first) → mensagem 'conflict' do ERR_CATALOG
}
const FW_SCROLLERS=['#fwCode','.fwdiff','.prleft','.prright','.fwwhyt','.rvl','.rvr','.prv'];
function fwGrabScroll(root){ const o={ _:root.scrollTop }; FW_SCROLLERS.forEach(s=>{ const el=root.querySelector(s); if(el) o[s]=[el.scrollTop, el.scrollLeft]; }); return o; }
function fwPutScroll(root, o){ if(!o) return; root.scrollTop=o._||0; FW_SCROLLERS.forEach(s=>{ const el=root.querySelector(s); if(el&&o[s]){ el.scrollTop=o[s][0]; el.scrollLeft=o[s][1]; } }); }
function fwHasDraft(){ return !!(fwTask && (String(fwDraft[fwTask]||'').trim() || (fwPend[fwTask]||[]).length)); }
// "por que este arquivo" (IA, custa créditos): SÓ sob demanda — antes rodava sozinho a cada arquivo aberto
function fwAskWhy(taskId, path){
  if(!path) return;
  const k=taskId+'|'+path; fwWhyCache[k]=null; fwWhyOpen=true;
  invoke('ai_file_why',{ taskId, path }).then(md=>{ fwWhyCache[k]={ md:md||'' }; if(fwTask===taskId) renderWorkspace(); })
    .catch(e=>{ fwWhyCache[k]={ err:String(e&&e.message||e) }; if(fwTask===taskId) renderWorkspace(); });
  renderWorkspace();
}
// ---- cabeçalho que se ajusta à LARGURA DO PAINEL (tela dividida / janela estreita) ----
// Com pouco espaço os modos viram UM botão "Conversa ▾" (menu com todos, o ativo marcado, setas/Esc), o título corta
// com "…" (inteiro no tooltip) e o que é secundário (fases, branch, chips, texto do "protegido") recolhe. Mede o
// próprio cabeçalho com ResizeObserver — nada de laço, nada de olhar a janela inteira.
// Escolha: menu em vez de "⋯ mais" — a 300–450 px nem 2 modos cabem ao lado do título e da ação principal; um botão
// só, com o nome do modo atual, lê melhor e não esconde qual é o modo ativo.
// @fw-head-puro-inicio (testado em app/tests/canvas-ui.test.mjs)
const FW_HEAD_COMPACT=980; // abaixo disso: fases/branch/chips somem e o "protegido" vira só o ícone
function fwHeadLayout(o){
  const compact=o.headW<FW_HEAD_COMPACT;
  const need=o.fixedW+o.modesW+16;
  const menu = o.cur==='menu' ? o.headW<need+32 : o.headW<need; // folga pra não ficar piscando no limite
  return { compact, modes:(menu||!(o.modesW>0)&&o.cur==='menu')?'menu':'tabs' };
}
function fwModesMenuBtnHtml(list, cur){
  const l=(list.find(([k])=>k===cur)||list[0]||['',''])[1];
  return `<button class="fwmode on fwmodedd" id="fwModeDd" aria-haspopup="menu" aria-expanded="false" title="trocar o que aparece: ${escA(list.map(x=>x[1]).join(', '))}">${esc(l)} <span class="fwddc" aria-hidden="true">▾</span></button>`;
}
function fwModesListHtml(list, cur){ return list.map(([k,l])=>`<button class="fwmi fwmodemi" role="menuitemradio" aria-checked="${k===cur}" data-fwmode="${k}"><span>${k===cur?'✓ ':''}${esc(l)}</span></button>`).join(''); }
// @fw-head-puro-fim
const FW_HEAD={ mode:'tabs', modesW:0, ro:null, head:null };
async function fwSetMode(nm){ if(nm===fwMode) return; if(fwMode==='codigo' && !await fwLeaveEditor()) return; fwMode=nm; fwRememberTab(); renderWorkspace(); }
function fwModesPaint(t){
  const m=$id('fwModes'); if(!m || !t) return;
  const list=(typeof fwModesList==='function')?fwModesList(t):[];
  const html=FW_HEAD.mode==='menu' ? fwModesMenuBtnHtml(list, fwMode) : fwModesHtml(t);
  if(m.__html!==html){ m.__html=html; m.innerHTML=html; }
  m.classList.toggle('asmenu', FW_HEAD.mode==='menu');
  m.querySelectorAll('[data-fwmode]').forEach(b=>b.onclick=()=>fwSetMode(b.dataset.fwmode));
  const dd=$id('fwModeDd'); if(dd) dd.onclick=(e)=>{ e.stopPropagation(); fwModesMenuOpen(t, dd); };
  fwHeadWatch();
}
function fwModesMenuOpen(t, anchor){
  const old=$id('fwModePop'); if(old){ old.remove(); anchor.setAttribute('aria-expanded','false'); return; }
  const pop=document.createElement('div'); pop.id='fwModePop'; pop.className='fwmenu fwmodepop';
  pop.innerHTML=fwModesListHtml(fwModesList(t), fwMode);
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect(); pop.style.top=(r.bottom+6)+'px'; pop.style.left=Math.max(8, Math.min(window.innerWidth-pop.offsetWidth-8, r.left))+'px';
  const close=(back)=>{ pop.remove(); anchor.setAttribute('aria-expanded','false'); document.removeEventListener('mousedown', out, true); if(back) try{ anchor.focus(); }catch(_){ } };
  const out=e=>{ if(!pop.contains(e.target) && e.target!==anchor) close(false); };
  setTimeout(()=>document.addEventListener('mousedown', out, true), 0);
  pop.querySelectorAll('[data-fwmode]').forEach(b=>b.onclick=()=>{ close(true); fwSetMode(b.dataset.fwmode); });
  if(typeof a11yMenu==='function') a11yMenu(pop, anchor, close);
}
// mede e decide (no ResizeObserver do cabeçalho e quando a lista de modos muda)
function fwHeadFit(){
  const head=FW_HEAD.head; if(!head || !head.isConnected || head.offsetParent===null) return;
  const headW=head.clientWidth; if(!(headW>0)) return;
  head.classList.toggle('narrow', headW<FW_HEAD_COMPACT);
  const m=$id('fwModes');
  if(FW_HEAD.mode==='tabs' && m && m.scrollWidth>0) FW_HEAD.modesW=m.scrollWidth;
  const pane=(typeof SF_PANE!=='undefined' && SF_PANE);
  let fixed=(pane?0:140)+32; // título (mínimo legível; no painel o nome mora no cabeçalho do painel) + respiro das bordas
  for(const el of head.children){ if(el===m || el.id==='fwTaskName' || String(el.style.flex||'').startsWith('1') || el.offsetParent===null) continue; fixed+=el.offsetWidth+9; }
  const r=fwHeadLayout({ headW, modesW:FW_HEAD.modesW, fixedW:fixed, cur:FW_HEAD.mode });
  if(r.modes!==FW_HEAD.mode){ FW_HEAD.mode=r.modes; const t=fwTaskObj(); if(t) fwModesPaint(t); }
  // ainda transborda (≈420 px): a ação principal vira só o ícone (aria-label com o nome) e o secundário vai pro ⋯
  // — nada fica fora da tela. Sai do modo apertado só com folga (sem piscar no limite).
  const tight=head.classList.contains('tight');
  if(!tight && head.scrollWidth>head.clientWidth+1) head.classList.add('tight');
  else if(tight && headW>=FW_HEAD_TIGHT) head.classList.remove('tight');
}
const FW_HEAD_TIGHT=560;
function fwHeadWatch(){
  const head=document.querySelector('#fwOverlay .fwhead'); if(!head) return;
  if(FW_HEAD.head!==head){ FW_HEAD.head=head; if(FW_HEAD.ro) try{ FW_HEAD.ro.disconnect(); }catch(_){ }
    if(typeof ResizeObserver==='function'){ FW_HEAD.ro=new ResizeObserver(()=>{ setTimeout(fwHeadFit, 0); }); FW_HEAD.ro.observe(head); } }
  setTimeout(fwHeadFit, 0); // timer: o rAF para com a janela coberta e o cabeçalho ficava com a medida velha
}
function renderWorkspace(){
  const t=fwTaskObj(); if(!t){ closeWorkspace(); return; }
  // modo que o TIPO esconde (ex.: Código numa investigação, guardado na aba) cai na Entrega
  if(typeof fwModesList==='function' && !fwModesList(t).some(([k])=>k===fwMode)){ fwMode='entrega'; fwRememberTab(); }
  { const p=$id('fwPhases'); if(p) p.innerHTML=phasesHtml(t); }
  if(typeof cicloPaint==='function') cicloPaint(t); // faixa de etapas + "precisa de você" (60-ciclo), com assinatura própria
  // modo da tela (conversa · código · revisão · PR · entrega) — layout muda junto; árvore recolhível em todos
  { const cols=$id('fwCols'); if(cols){ cols.classList.remove('m-conversa','m-codigo','m-revisao','m-pr','m-entrega','m-previa'); cols.classList.add('m-'+fwMode); cols.classList.toggle('notree', fwTreeHidden()); cols.classList.toggle('rv-req', fwMode==='revisao' && (typeof rvViewOf!=='function' || rvViewOf(t.id)!=='diff')); } }
  fwModesPaint(t);
  { const tn=$id('fwTaskName'); tn.textContent=t.title; tn.title=t.title; }
  // painel Dispositivo (57-dispositivo.js): barato — só o botão/visibilidade; o painel tem guarda própria
  if(typeof dvSync==='function') dvSync(t);
  // R5-7: selo do épico ao lado do título (mesmo "◆ nome · onda N" da Central); clique abre o épico
  { const te=$id('fwTaskEpic'); if(te){ const h=(typeof epTaskBadge==='function')?epTaskBadge(t):''; if(te.__html!==h){ te.__html=h; te.innerHTML=h; // R8: compara com a string guardada (o SVG serializado pelo innerHTML nunca bate)
      te.querySelectorAll('[data-epbadge]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); if(typeof epOpenById==='function') epOpenById(b.dataset.epbadge); }); } } }
  // selo do modo protegido (mesa 27/09): o que o agente NÃO pode fazer, no tooltip
  { const tp=$id('fwTaskProt'); if(tp && typeof protectBadgeHtml==='function'){ const h=protectBadgeHtml(t); if(tp.__html!==h){ tp.__html=h; tp.innerHTML=h; } } }
  $id('fwTaskBranch').textContent=t.branch+' · '+t.agent;
  if(typeof orqTaskChips==='function') orqTaskChips(t);
  // barra do topo: [preview] + UMA ação principal da fase; o resto (progresso, push, modelo, custo…) no ⋯
  { const rb=$id('fwReviewBar');
    if(rb){
      const pv=taskPreviewTarget(t); fwPvShown=pv||null;
      const pvBtn=pvGlobeHtml(t); // R8: bolinha verde (no ar) / vermelha (caiu); caiu → leva pro "subir de novo" na Entrega
      rb.innerHTML=pvBtn+fwActionHtml(t);
      fwPrimShown=(fwPrimaryAction(t)||{}).id||'';
      bindClick('fwAnswer', ()=>fwAskFix());
      bindClick('fwStopTop', ()=>stopTask(t.id));
      // FT-5: aprovar passa pelo gate de verificação (21: chkApproveClick/chkDecorateApprove)
      if(typeof chkDecorateApprove==='function') chkDecorateApprove($id('fwApprove'), t);
      bindClick('fwApprove', ()=>approveGate(t));
      bindClick('fwAskProof', (e)=>proofAsk(t, e.currentTarget));
      bindClick('fwNoProof', ()=>approveNoProof(t));
      bindClick('fwArchive', async(e)=>{ const b=e.currentTarget;
        // E11a: com entregáveis ainda não salvos, leva pra Entrega com a barra "Salvar entregáveis na pasta" (salva e conclui lá)
        if(fwArchiveNeedsSave(t)){ fwMode='entrega'; fwRememberTab(); renderWorkspace();
          setTimeout(()=>{ const s=document.querySelector('#fwOverlay .en-save'); if(s){ s.scrollIntoView(scrollOpts('center')); s.classList.add('flash'); setTimeout(()=>s.classList.remove('flash'),1600); } }, 60);
          toast('Salve os entregáveis numa pasta sua e conclua — ou use "só concluir".','info'); return; }
        b.disabled=true; try{ await invoke('set_task_flag',{ taskId:t.id, flag:'closed' }); lastSig=''; await refresh(); toast('concluída — saiu da fila','ok'); }catch(err){ showErr(err, 'Falhou'); b.disabled=false; } renderWorkspace(); });
      bindClick('fwRerun', async()=>{ await rerunTask(t.id); renderWorkspace(); });
      // 1 pedido por clique: duplo clique em "continuar" mandava dois resume_task
      bindClick('fwResume', async(e)=>{ e.currentTarget.disabled=true; await resumeTask(t.id); renderWorkspace(); });
      bindClick('fwApprovePlan', async()=>{ await startTask(t.id); renderWorkspace(); });
      bindClick('fwDecide', ()=>{ if(typeof cicloFocusDecision==='function') cicloFocusDecision(); });
      bindClick('fwStartDraft', async(e)=>{ e.currentTarget.disabled=true; await startTask(t.id); renderWorkspace(); });
      bindClick('fwResolve', (e)=>fwResolveConflict(t.id, e.currentTarget));
      bindClick('fwPrGo', ()=>{ fwMode='pr'; fwRememberTab(); renderWorkspace(); });
      bindClick('fwPrGh', ()=>openExternal(t.prUrl));
      bindClick('fwPv', (e)=>pvGlobeClick(t, e.currentTarget.dataset.url));
    }
    const mb=$id('fwMore'); if(mb) mb.onclick=(e)=>{ e.stopPropagation(); const tt=fwTaskObj(); if(tt) fwOpenMore(tt, mb); };
  }
  // ---- coluna 1: árvore de arquivos ----
  const tree=$id('fwTree');
  const treeTop = tree.dataset.tk===t.id ? tree.scrollTop : 0;
  const dels=Array.isArray(t.deliverables)?t.deliverables.filter(Boolean):[];
  const canDeliv=dels.length>0;
  const body = fwFiles.length
    ? (fwGroupMode==='deliverable'&&canDeliv ? fwDelivHtml(fwFiles, dels) : `<div class="fwtreebody">${fwTreeHtml(fwBuildTree(fwFiles),0)}</div>`)
    : fwFilesLoading ? '<div style="padding:8px">'+skeletonHtml('lista',{ n:5, compact:true, inline:true, label:'carregando os arquivos' })+'</div>'
    // texto humano fixo (o catálogo genérico lia "not a git repository" e oferecia "criar repositório" — errado aqui);
    // o erro cru fica no tooltip
    : fwFilesErr ? '<div class="fwfileserr">'+(fwFilesErrOwnAction(fwFilesErr) ? errorHtml(fwFilesErr, 'fwFilesRetry', FW_FILES_CTX) : errorHtml(humanErr(fwFilesErr, FW_FILES_CTX).msg, 'fwFilesRetry', null, { human:true }))+'</div>'
    : '<div class="dim" style="padding:8px;font-size:var(--fs-xs)">nada ainda — os arquivos que o agente alterar, os anexos e os artefatos aparecem aqui ao vivo</div>';
  const cost=taskCost(t.id);
  const treeFoot = `<div class="fwtreefoot"><div class="r"><span>custo desta tarefa</span><b>${cost.usd>0?fmtCost(cost.usd):'—'}</b></div>${typeof estChipHtml==='function'?`<div class="r"><span>previsto × real</span>${estChipHtml(t)}</div>`:''}</div>`;
  // Entregas & provas (artefatos) — sempre à mão (1 carga em voo por tarefa: antes cada render disparava outra)
  const artC=artifactsCache[t.id];
  fwArtsEnsure(t);
  const artsHtml=artC?artListHtml(artC.list):'';
  tree.innerHTML=`<div class="fwtreeh"><span>${fwMode==='revisao'?'Arquivos alterados':fwIsWorking(t)?'Arquivos sendo alterados':'Arquivos desta tarefa'}</span><button class="fwtreebtn" data-fwtree="off" title="recolher os arquivos (⌘B)">«</button></div>`+
    (canDeliv?`<div class="fwgtoggle"><button class="fwgbtn${fwGroupMode==='folder'?' on':''}" data-fwg="folder">Pastas</button><button class="fwgbtn${fwGroupMode==='deliverable'?' on':''}" data-fwg="deliverable">Entregáveis</button></div>`:'')+
    body+
    // dica de "selecionar linhas" saiu daqui: fica junto do código (barra sob o código / faixa da Revisão)
    (fwGroupMode==='deliverable'&&canDeliv?'<div class="fwtreehint">Vínculo por palavra-chave — o arquivo aparece sob o entregável que ele parece atender.</div>':'')+
    (artsHtml?`<div class="fwarts">${artsHtml}</div>`:'')+
    treeFoot;
  tree.dataset.tk=t.id; tree.scrollTop=treeTop;
  tree.querySelectorAll('[data-art]').forEach(b=>{ if(!b.title) b.title=b.dataset.art; b.onclick=(e)=>{ e.stopPropagation(); openArtifact(t.id, b.dataset.art); }; }); // nome inteiro no tooltip ("print-tot…")
  tree.querySelectorAll('[data-fwg]').forEach(b=>b.onclick=()=>{ fwGroupMode=b.dataset.fwg; renderWorkspace(); });
  if(fwFilesErr && fwFilesErrOwnAction(fwFilesErr)){ const fe=tree.querySelector('.fwfileserr'); if(fe) ldWireErr(fe, fwFilesErr, FW_FILES_CTX, null); } // botão do catálogo (ex.: entrar no GitHub)
  bindClick('fwFilesRetry', ()=>{ fwFilesErr=''; fwFilesLoading=true; fwFilesAt=Date.now(); renderWorkspace(); // o tick não dispara outra carga em paralelo
    const tk=t.id;
    invoke('task_files',{ taskId:tk }).then(f=>{ if(fwTask===tk){ fwFiles=f||[]; fwFilesSig=''; } }).catch(e=>{ if(fwTask===tk) fwFilesErr=String(e&&e.message||e)||'erro desconhecido'; }).finally(()=>{ if(fwTask===tk){ fwFilesLoading=false; renderWorkspace(); } }); });
  // status por arquivo enquanto a tarefa roda: só "editando" (tocado há <3 min) ganha texto; o resto é um
  // pontinho discreto com o detalhe no tooltip — antes um selo "CONCLUÍDO" em CADA arquivo comia a largura
  // (nomes viravam "checkou…") e mentia com a tarefa ainda rodando
  if(fwFiles.length && (ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy)){
    const touched=new Map(); const now=Date.now(); // arquivo → último edit/write (ms)
    for(const e of eventsOf(t.id).slice(-120)){
      if(!['edit','write'].includes(e.type)) continue;
      const at=+new Date(e.ts)||0;
      const m=String(e.text||'').match(/[\w@./-]+\.[A-Za-z]{1,8}/g)||[];
      m.forEach(x=>{ const k=x.replace(/^\.\//,''); if(at>(touched.get(k)||0)) touched.set(k, at); });
    }
    const agoTx=ms=>{ const s=Math.max(0,Math.round(ms/1000)); return s<60?`${s}s`:`${Math.round(s/60)} min`; };
    tree.querySelectorAll('[data-fwf]').forEach(b=>{
      const p=b.dataset.fwf||'';
      let last=0; touched.forEach((at,h)=>{ if((p.endsWith(h)||h.endsWith(p)) && at>last) last=at; });
      const isHot=last && now-last<=180000;
      b.insertAdjacentHTML('beforeend', isHot
        ? `<span class="fwst ed" title="o agente editou este arquivo há ${agoTx(now-last)}">editando</span>`
        : `<span class="fwdot" title="${escA(last?`alterado nesta tarefa — última edição do agente há ${agoTx(now-last)}`:'alterado nesta tarefa — sem edição do agente nos últimos minutos')}"></span>`);
    });
  }
  tree.querySelectorAll('[data-fwf]').forEach(b=>b.onclick=async()=>{ if(b.dataset.fwf!==fwPath && !await fwLeaveEditor()) return; fwPath=b.dataset.fwf; fwEditing=false; if(fwMode==='conversa'||fwMode==='pr'||fwMode==='entrega') fwMode='codigo'; fwRememberTab(); fwLoadFile(); renderWorkspace(); });
  tree.querySelectorAll('[data-fwdir]').forEach(b=>b.onclick=()=>{ const p=b.dataset.fwdir; if(fwCollapsed.has(p)) fwCollapsed.delete(p); else fwCollapsed.add(p); renderWorkspace(); });
  // ---- coluna 2: código (visualizar + editar inline) ----
  const main=$id('fwMain');
  // editando: o poll NÃO recria o editor (antes o re-render a cada 4s apagava o que você digitou)
  const edEl=$id('fwText');
  const keepEditor = !!(fwEditing && fwMode==='codigo' && edEl && edEl.dataset.fk===(t.id+'|'+fwPath));
  // R8: arquivo ALTERADO abre em "só mudanças" (diff); editar exige o arquivo inteiro
  const fChanged=!!(fwPath && fwFiles.some(x=>x.path===fwPath && !x.doc));
  const codeView=(fwEditing||!fChanged)?'full':fwCodeView;
  const mk=t.id+'|'+fwMode+'|'+(fwPath||'')+'|'+codeView+(fwMode==='revisao'&&typeof rvViewOf==='function'?'|'+rvViewOf(t.id):'');
  const mainMem = (!keepEditor && main.dataset.mk===mk) ? fwGrabScroll(main) : null; // mesma tela → mantém a rolagem
  const added=new Set(fwAdded); const sel=fwSelRange();
  const f=fwFiles.find(x=>x.path===fwPath)||{add:0,del:0};
  const lines=fwContent.split('\n');
  // "Por que este arquivo": explicação REAL do diff (IA) — sob demanda, cache por versão do diff
  const objShort=String(t.objective||'').split('[PLANO DO ORQUESTRADOR')[0].trim();
  const whyKey=t.id+'|'+(fwPath||'');
  const w=fwPath?fwWhyCache[whyKey]:undefined;
  const whyInner = !fwPath ? esc(objShort)
    : w===undefined ? `${esc(objShort)}<div style="margin-top:7px"><button class="btn sm" id="fwWhyAsk" title="a IA lê o diff deste arquivo e explica o que mudou e por quê (usa créditos)">${IC.ai} explicar este arquivo com IA</button></div>`
    : w===null ? `<span class="dim">lendo o diff deste arquivo e escrevendo a explicação…</span>`
    : (w&&w.md) ? mdToHtml(w.md)
    : (w&&w.err) ? `<span style="color:var(--warn)">não consegui explicar este arquivo: ${esc(errShort(w.err))}</span> <a class="lnk" id="fwWhyRetry">tentar de novo</a>`
    : `<span class="dim">sem alterações neste arquivo nesta branch.</span> ${esc(objShort)}`;
  const whyBand = `<div class="fwwhy${fwWhyOpen?' open':''}"><svg viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.3" stroke-linejoin="round"><path d="M7 2.6l1 2.6 2.6 1-2.6 1L7 9.8 6 7.2 3.4 6.2 6 5.2z"/></svg><div class="fwwhyb"><div class="fwwhyh"><span class="fwwhyl">${fwPath&&w!==undefined?'O que foi feito neste arquivo e por quê':'Objetivo da tarefa'}</span><span style="flex:1"></span>${fwPath&&w&&w.md?`<button class="fwwhyre" id="fwWhyRedo" title="gerar de novo">↻</button>`:''}<button class="fwwhytg" id="fwWhyTg">${fwWhyOpen?'▴ menos':'▾ mais'}</button></div><div class="fwwhyt">${whyInner}</div></div></div>`;
  if(keepEditor){ /* editor aberto: fica como está (texto, cursor, rolagem) */ }
  else if(fwMode==='entrega'){ fwRenderEntrega(t, main); }
  else if(fwMode==='pr'){ fwRenderPrPage(t, main); }
  else if(fwMode==='previa'){ fwRenderPrevia(t, main); } // 57-navegador: só repinta o que mudou (o iframe não é recriado pelo tick)
  else if(fwMode==='revisao'){ if(typeof rvRender==='function' && rvViewOf(t.id)!=='diff') rvRender(t, main); else fwRenderDiff(t, main); } // 63-revisao-pr: por requisito; "ver diff completo" = o diff de antes
  else if(!fwPath){ main.innerHTML=`<div class="fwmhead">${fwTreeOpenBtn()}<span class="dim" style="font-size:var(--fs-sm)">código</span></div><div class="empty">${fwFilesLoading?skeletonHtml('lista',{ n:5, compact:true, inline:true, label:'carregando os arquivos' }):fwFiles.length?(fwTreeHidden()?'abra os arquivos (» Arquivos, ou ⌘B) e escolha um':'selecione um arquivo à esquerda'):'nenhum arquivo alterado ainda'}</div>`; }
  else {
    const loadingFile = fwFileLoading===(t.id+'|'+fwPath);
    const headBtns = fwEditing
      ? `<button class="btn primary sm" id="fwSave">${IC.check} salvar</button><button class="btn sm" id="fwCancel">cancelar</button>`
      : (fwReadErr||loadingFile) ? '' // sem conteúdo real → sem "editar" (salvaria o erro/vazio por cima do arquivo)
      : `<button class="btn sm" id="fwEditBtn" title="edita o arquivo inteiro">${IC.pencil} editar</button>`;
    const viewTg = (fChanged && !fwEditing) ? `<span class="fwvtg" role="group" aria-label="como ver o arquivo"><button class="${codeView==='diff'?'on':''}" data-fwview="diff" title="só as linhas adicionadas e removidas, com um pouco de contexto">só mudanças</button><button class="${codeView==='full'?'on':''}" data-fwview="full" title="o arquivo inteiro, com as linhas novas em verde">arquivo inteiro</button></span>` : '';
    const dvRaw = codeView==='diff' ? fwDiffGet(t, fwPath) : undefined;
    const dvBody = codeView!=='diff' ? ''
      : dvRaw==null ? skeletonHtml('tabela',{ n:8, cols:2, inline:true, label:'carregando as mudanças' })
      : typeof dvRaw==='object' ? `<div class="empty" style="display:flex;flex-direction:column;gap:10px;align-items:center"><div style="color:var(--warn)">não consegui gerar o diff deste arquivo</div><div class="dim" style="font-size:var(--fs-sm);white-space:pre-wrap" title="${escA(String(dvRaw.err||'').slice(0,400))}">${esc(errShort(dvRaw.err))}</div><button class="btn sm" data-fwview="full">ver o arquivo inteiro</button></div>`
      : !dvRaw.trim() ? `<div class="empty" style="display:flex;flex-direction:column;gap:10px;align-items:center"><div>sem diferenças neste arquivo em relação à base</div><button class="btn sm" data-fwview="full">ver o arquivo inteiro</button></div>`
      : `<div class="fwcode fwdv" id="fwCode">${diffViewHtml(diffHunks(dvRaw), { full:fwContentFor===t.id+'|'+fwPath?lines:null, sel, keyPre:t.id+'|'+fwPath+'|' })}</div>`;
    const body = fwEditing
      ? `<div class="fveditwrap fwedit"><div class="fvgutter" id="fwGutter" aria-hidden="true"></div><textarea class="fvedit mono" id="fwText" data-tab-indent spellcheck="false" wrap="off" data-fk="${escA(t.id+'|'+fwPath)}"></textarea></div>`
      : codeView==='diff' ? dvBody
      : loadingFile ? skeletonHtml('lista',{ n:10, compact:true, inline:true, label:'abrindo o arquivo' })
      : fwReadErr ? `<div class="empty" style="display:flex;flex-direction:column;gap:10px;align-items:center"><div style="color:var(--warn)">não consegui abrir este arquivo</div><div class="dim" style="font-size:var(--fs-sm);white-space:pre-wrap" title="${escA(fwReadErr.slice(0,400))}">${esc(errShort(fwReadErr))}</div><button class="btn sm" id="fwReload">tentar de novo</button></div>`
      : `<div class="fwcode" id="fwCode">${lines.map((ln,i)=>{const n=i+1;const inSel=sel&&n>=sel.a&&n<=sel.b;return `<div class="fwln${added.has(n)?' add':''}${inSel?' sel':''}" data-ln="${n}"><span class="fwnum">${n}</span><span class="fwtxt">${esc(ln)||' '}</span></div>`;}).join('')}</div>`;
    const bar = fwEditing
      ? `<div class="fwselbar">editando <b>${esc(fwPath.split('/').pop())}</b> — <b>salvar</b> grava direto na worktree · <span class="kbd">esc</span> cancela</div>`
      : `<div class="fwselbar">${sel?`<b>linhas ${sel.a}${sel.b>sel.a?'–'+sel.b:''} selecionadas</b> · pergunte ao ${esc(t.agent)} no chat →`:'clique e <b>arraste</b> pra selecionar várias linhas (ou shift+clique) e pergunte no chat'}</div>`;
    main.innerHTML = `
      <div class="fwmhead">${fwTreeOpenBtn()}${fwPathHtml(fwPath)}<span class="fwmadd">+${f.add} <span style="color:var(--crit)">−${f.del}</span></span><span class="fwmby" title="escrito por ${escA(t.agent)}"><span class="fwav" aria-hidden="true" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span><span class="fwmbytx">${esc(t.agent)}</span></span><span style="flex:1"></span>${viewTg}${headBtns}</div>
      ${whyBand}
      ${body}
      ${bar}`;
  }
  if(!keepEditor){ main.dataset.mk=mk; fwPutScroll(main, mainMem); }
  if(keepEditor||fwMode==='pr'||fwMode==='revisao'||fwMode==='entrega'||fwMode==='previa'){ /* wiring próprio nas funções de página (ou editor intacto) */ }
  else if(fwEditing){
    const ta=$id('fwText'), gut=$id('fwGutter');
    if(ta){ ta.value=fwContent; const sg=()=>{ const n=ta.value.split('\n').length||1; let s=''; for(let i=1;i<=n;i++) s+=i+'\n'; gut.textContent=s; }; sg(); ta.addEventListener('input',sg); ta.addEventListener('scroll',()=>gut.scrollTop=ta.scrollTop); ta.addEventListener('keydown',e=>{ if(e.key==='Tab'){ e.preventDefault(); const s=ta.selectionStart; ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(ta.selectionEnd); ta.selectionStart=ta.selectionEnd=s+2; sg(); } }); try{ ta.setSelectionRange(0,0); }catch(_){ } ta.focus({preventScroll:true}); requestAnimationFrame(()=>{ ta.scrollTop=0; ta.scrollLeft=0; gut.scrollTop=0; }); } // abre no TOPO: o caret ia pro fim e o focus rolava o texto todo
    const sv=$id('fwSave'); if(sv) sv.onclick=fwSaveFile;
    const cc=$id('fwCancel'); if(cc) cc.onclick=async()=>{ if(await fwLeaveEditor()) renderWorkspace(); };
  } else {
    const codeEl=$id('fwCode');
    if(codeEl){
      // seleção por ARRASTE (várias linhas) + shift-clique; sem native text-select
      codeEl.addEventListener('mousedown',e=>{ const ln=e.target.closest('.fwln[data-ln]'); if(!ln)return; e.preventDefault(); const n=+ln.dataset.ln; if(e.shiftKey&&fwSelA){ fwSelB=n; } else { fwSelA=n; fwSelB=n; } fwDrag=true; fwPaintSel(); });
      codeEl.addEventListener('mouseover',e=>{ if(!fwDrag)return; const ln=e.target.closest('.fwln[data-ln]'); if(!ln)return; fwSelB=+ln.dataset.ln; fwPaintSel(); });
    }
    const eb=$id('fwEditBtn'); if(eb) eb.onclick=()=>{ fwCodeView='full'; fwEditing=true; renderWorkspace(); }; // editar = arquivo inteiro
    main.querySelectorAll('[data-fwview]').forEach(b=>b.onclick=()=>{ fwCodeView=b.dataset.fwview==='full'?'full':'diff'; lsSet('fwCodeView', fwCodeView); renderWorkspace(); });
    fwWireGaps(main);
    bindClick('fwReload', ()=>fwLoadFile());
    bindClick('fwWhyTg', ()=>{ fwWhyOpen=!fwWhyOpen; renderWorkspace(); });
    bindClick('fwWhyAsk', ()=>fwAskWhy(t.id, fwPath));
    bindClick('fwWhyRedo', async()=>{ try{ await invoke('ai_file_why_reset',{ taskId:t.id, path:fwPath }); }catch(_){ } fwAskWhy(t.id, fwPath); });
    bindClick('fwWhyRetry', ()=>fwAskWhy(t.id, fwPath));
  }
  // ---- coluna 3: chat com o agente (estilo Cursor: requisitos + conversa real) ----
  const chat=$id('fwChatCol');
  // antes de recriar: guarda o rascunho (da tarefa DONA do input), o checkbox e a rolagem da conversa
  const ai=document.activeElement, inEl=$id('fwInput');
  if(inEl && inEl.dataset.tk) fwDraft[inEl.dataset.tk]=inEl.value;
  const keepInput=!!(ai&&ai===inEl&&inEl.dataset.tk===t.id), inCaret=(keepInput&&inEl.selectionStart!=null)?inEl.selectionStart:null;
  { const ar=$id('fwAsReq'); if(ar&&ar.dataset.tk) fwAsReqOn[ar.dataset.tk]=ar.checked; }
  const th0=$id('fwThread');
  // "preso no fim" é INTENÇÃO, não posição medida: a 1ª pintura acontece com a coluna escondida (scrollTop
  // ignorado → 0) e a 2ª lia esse 0 como "a pessoa rolou pra cima" — a conversa abria no topo. Só um scroll
  // de verdade (com layout) muda a intenção (fwThreadPinned, atualizado no listener abaixo).
  const thMem=(th0 && chat.dataset.tk===t.id) ? { top:th0.scrollTop, bottom:fwThreadPinned[t.id]!==false } : null;
  const nowBox = `<div class="fwnow${ACTIVE_ST.has(t.status)?'':' done'}" id="fwNow">${fwNowHtml(t)}</div>`;
  const askingW=pendingOf(t.id);
  const workingW=fwIsWorking(t);
  const sel2=fwSelRange();
  const sr=fwSendRowHtml(t);
  const isTerm=termViewOf(t);
  // compositor de sempre (anexos, "/" skills, IA, "vira requisito"): o MESMO no chat e no modo terminal (layout A)
  const composer=`
    <div class="fwinput cc"><div class="atmenu" id="fwMenu" style="display:none"></div>${sel2?`<div class="fwselchip">${IC.chevR} ${esc((fwPath||'').split('/').pop())}:${sel2.a}${sel2.b>sel2.a?'–'+sel2.b:''}<button class="fwselx" id="fwSelX">${IC.x}</button></div>`:''}
      <div class="attrow attpend" id="fwPend" style="display:${(fwPend[t.id]||[]).length?'flex':'none'}">${(fwPend[t.id]||[]).map((a,i)=>attChipHtml(a,i,true)).join('')}</div>
      <textarea class="in fwta cc-ta" id="fwInput" rows="2" data-tk="${escA(t.id)}" placeholder="${isTerm&&document.documentElement.classList.contains('sfpane')&&window.innerHeight<=420&&!askingW.length?'mensagem pro terminal…':askingW.length?(askingW[0].kind==='budget'?'pra seguir: valor e motivo (ex.: liberar 2 porque falta o teste) — ou toque em Parar aqui':'responda a pergunta — o turno continua'):isTerm?((TERM[t.id]&&TERM[t.id].mode==='live')||fwIsWorking(t)?'mande pro terminal…  (Enter = na fila se ele estiver ocupado · ⌘Enter = Esc e manda · / skills · ⌘V print)':(TERM[t.id]&&TERM[t.id].hinfo&&TERM[t.id].hinfo.resumes===false)?'peça um ajuste…  ( / abre as skills · ⌘V cola um print )':'mande uma mensagem — retoma a sessão no terminal  ( / skills · ⌘V print)'):'peça um ajuste…  ( / abre as skills · ⌘V cola um print )'}"></textarea>
      <div class="fwinrow cc-row"><button class="btn sm cc-clip" id="fwAttach" title="anexar print, PDF ou doc — ou cole (⌘V) / arraste">${CHAT_CLIP_SVG}</button>${chatModelPillHtml(fwModelPill(t))}<label class="fwreqtoggle" style="margin:0"><input type="checkbox" id="fwAsReq" data-tk="${escA(t.id)}"${fwAsReqOn[t.id]?' checked':''}><span>vira <b>requisito</b></span></label><span class="cc-sp"></span>${isTerm?`<button type="button" class="btn sm cc-compmore${fwAsReqOn[t.id]?' on':''}" id="fwCompMore" aria-haspopup="menu" aria-expanded="false" title="IA e vira requisito">${IC.more||'⋯'}</button>`:''}<span id="fwSendBtns" data-k="${sr.key}" style="display:flex;gap:7px">${sr.btns}</span></div>
      <div class="fwhint chathint" id="fwHint">${sr.hint}</div></div>`;
  // foco no terminal (xterm) sobrevive ao re-render: o host é movido pro slot novo e o foco volta pra ele
  const termHadFocus=isTerm && typeof TERM!=='undefined' && TERM[t.id] && TERM[t.id].host.contains(document.activeElement);
  const sheetGrab=isTerm && typeof tlSheetFocusGrab==='function' ? tlSheetFocusGrab(t.id) : null; // digitando na "outra resposta"
  chat.classList.toggle('tl', isTerm);
  chat.innerHTML=isTerm ? tlChatHtml(t, composer) : `
    <div class="fwchath">${fwMode==='conversa'?fwTreeOpenBtn():''}<span class="fwav" aria-hidden="true" style="background:${agentColor(fwAgentSel||t.agent)}">${agentBadge(fwAgentSel||t.agent)}</span><div style="min-width:0;flex:1"><div class="fwchatt">${esc(fwAgentSel||t.agent)}</div><div class="fwchatd" id="fwChatSub">${esc(fwChatSubText(t))}</div></div></div>
    <div class="fwctx"><button class="fwctxbar" id="fwCtxBar" aria-expanded="${fwCtxOpen?'true':'false'}" title="${fwCtxOpen?'recolher':'ver'} o que ele está fazendo e os requisitos">${fwCtxBarHtml(t)}</button><div class="fwctxbody" id="fwCtxBody" style="display:${fwCtxOpen?'block':'none'}">${nowBox}<div class="fwreqs" id="fwReqs">${fwReqsHtml(t)}</div></div></div>
    <div class="fwthread" id="fwThread">${fwThreadHtml(t)}</div>${composer}`;
  chat.dataset.tk=t.id;
  // MODO TERMINAL (60-terminal.js + layout A em 60-terminal-layout.js): terminal, painel de requisitos e folha de pergunta
  if(isTerm){ termMount(t); tlWire(t, sheetGrab); if(termHadFocus && !chat.querySelector('.tlsheet:focus-within')) setTimeout(()=>tlFocusTerm(t.id), 0); } else termSweep();
  bindClick('fwSteer', ()=>{ const inp=$id('fwInput'); if(inp){ inp.focus(); inp.placeholder='descreva a mudança de rumo'; } });
  bindClick('fwCtxBar', ()=>{ fwCtxOpen=!fwCtxOpen; lsSet('fwCtxOpen', fwCtxOpen?'1':'0'); renderWorkspace(); });
  bindClick('fwSelX', ()=>{ fwSelA=0; fwSelB=0; renderWorkspace(); });
  bindClick('fwCompMore', (e)=>{ e.stopPropagation(); if(typeof tlCompMoreOpen==='function') tlCompMoreOpen(t, e.currentTarget); }); // painel baixo: IA e "vira requisito" num menu
  fwWireSendBtns();
  { const ar=$id('fwAsReq'); if(ar) ar.onchange=()=>{ fwAsReqOn[t.id]=ar.checked; }; }
  attWireComposer({ input:'fwInput', attach:'fwAttach', pend:()=>(fwPend[t.id]=fwPend[t.id]||[]), taskId:()=>t.id, rerender:renderWorkspace });
  chatModelPillWire(fwModelPill(t));
  { const pp=$id('fwPend'); if(pp) pp.querySelectorAll('[data-attrm]').forEach(x=>x.onclick=()=>{ (fwPend[t.id]||[]).splice(+x.dataset.attrm,1); renderWorkspace(); }); }
  chat.onclick=(e)=>{
    if(e.target.closest('#fwLiveTg')){ fwLiveOpen=!fwLiveOpen; fwPaintThread(fwTaskObj()||t); return; }
    const rt=e.target.closest('[data-fwretry],[data-fwedit]');
    if(rt){ const at=+(rt.dataset.fwretry||rt.dataset.fwedit), o=(fwOptim[t.id]||[]).find(x=>x.at===at); if(!o) return;
      fwOptim[t.id]=(fwOptim[t.id]||[]).filter(x=>x!==o);
      if(rt.dataset.fwretry) fwSendText(t.id, o.text);
      else { const i=$id('fwInput'); if(i){ i.value=o.text+(i.value?'\n'+i.value:''); fwDraft[t.id]=i.value; i.focus(); } fwPaintThread(fwTaskObj()||t); }
      return; }
    const ao=e.target.closest('[data-askopt]');
    if(ao){ const p=pendingOf(t.id)[0]; if(p && !fwAskIsSent(p)){ const ans=ao.dataset.askopt, k=fwAskKey(p); fwAskSent[k]=ans; fwPaintThread(t);
        resolvePending(p.id, ans).catch(err=>{ delete fwAskSent[k]; if(fwTask===t.id) fwPaintThread(fwTaskObj()); showErr(err, 'Não consegui enviar a resposta'); }); } return; }
    const cp=e.target.closest('.ccopy');
    if(cp){ const bub=cp.parentElement; const cl=bub.cloneNode(true); cl.querySelectorAll('.ccopy').forEach(x=>x.remove()); try{ navigator.clipboard.writeText(cl.innerText.trim()); cp.textContent='✓'; setTimeout(()=>{cp.textContent='⧉';},900); }catch(_){} return; }
    const a=e.target.closest('[data-art]'); if(a){ openArtifact(t.id, a.dataset.art); return; }
    const ext=e.target.closest('[data-ext]'); if(ext){ e.preventDefault(); openExternal(ext.dataset.ext); return; }
    if(e.target.closest('#fwReqCheck')){ fwSendText(t.id, 'Verifique AGORA cada requisito do TASK.yaml, um a um: diga se está cumprido, linke a evidência real (print e/ou teste) e gere/atualize .cardume/artifacts/requirements.json. Se algum não estiver cumprido, me pergunte via ask_human antes de finalizar.'); return; }
  };
  { const i=$id('fwInput'); if(i){
    i.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&$id('fwMenu').style.display!=='none'){ e.stopPropagation(); fwHideMenu(); return; }
      if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); fwHideMenu();
        // trabalhando: Enter = NA FILA (não interrompe); ⌘/Ctrl+Enter = parar e enviar
        const tt=fwTaskObj(); const busy=!!(tt&&fwIsWorking(tt));
        fwSendMsg(busy && !(e.metaKey||e.ctrlKey)); } });
    i.addEventListener('input',()=>{ fwDraft[t.id]=i.value; const v=i.value, last=v.slice(-1), ws=(v.length===1||/\s/.test(v.slice(-2,-1)));
      if(last==='/'&&ws) fwShowMenu(t,'req'); else if(last==='@'&&ws) fwShowMenu(t,'ref'); else fwHideMenu(); });
    i.value=fwDraft[t.id]||'';
    if(keepInput){ i.focus(); if(inCaret!=null){ try{ i.setSelectionRange(inCaret,inCaret); }catch(_){} } } } }
  // conversa: só gruda no fim se você JÁ estava no fim (lendo lá em cima, a rolagem fica onde está)
  const th=$id('fwThread'); if(th){
    if(!thMem||thMem.bottom){
      th.scrollTop=th.scrollHeight;
      // abrir a atividade / trocar pra "Código": a coluna do chat ainda pode estar escondida neste instante
      // (o navegador ignora scrollTop de elemento sem altura) e a conversa abria no TOPO. Reaplica o "fim"
      // quando ela já tem layout — só se ninguém rolou pra cima no meio tempo.
      fwStickBottom(th);
    } else th.scrollTop=thMem.top;
    th.addEventListener('scroll', ()=>{ if(th.clientHeight>0) fwThreadPinned[t.id]=(th.scrollHeight-th.scrollTop-th.clientHeight<80); }, { passive:true });
  }
  // abrir/recolher a árvore (« no cabeçalho dela, » na coluna ao lado)
  document.querySelectorAll('#fwOverlay [data-fwtree]').forEach(b=>b.onclick=()=>fwToggleTree());
}
// ---- Revisão: diff de verdade por arquivo (redesign p12) ----
let fwRevOpen=false; // explicação da revisão expandida
function fwRenderDiff(t, main){
  if(!fwPath && fwFiles.length) fwPath=fwFiles.filter(f=>!f.doc)[0]?.path||fwFiles[0].path;
  const key=fwPath?fwDiffKey(t, fwPath):'';
  const rev=reviewOf(t.id);
  const f=fwFiles.find(x=>x.path===fwPath)||{add:0,del:0};
  // explicação inteira (antes cortava no meio da palavra: "Movi a soma d") — 2 linhas + "ver mais"
  const revTx=rev?`<b>${esc(rev.summary||'')}</b>${rev.howToTest?`<span class="dim"> · como testar: ${esc(rev.howToTest)}</span>`:''}`:'<b>revisão da entrega</b>';
  const revLong=!!(rev && ((rev.summary||'').length+(rev.howToTest||'').length)>160);
  const band=`<div class="fwrevband"><div class="fwrevtx${fwRevOpen?' open':''}">${revTx}</div>${revLong?`<button class="lnk fwrevmore" id="fwRevMore">${fwRevOpen?'ver menos':'ver mais'}</button>`:''}${typeof rvViewOf==='function'?'<button class="btn sm" id="fwRevByReq">ver por requisito</button>':''}<button class="btn sm" id="fwBackConv">← conversa</button></div>`;
  // perguntar sobre linhas é no modo Código — a dica mora aqui, junto do código (antes ficava no painel de arquivos)
  const askHint=fwPath?`<div class="fwrevask">quer perguntar sobre um trecho? <button class="lnk" id="fwRevToCode">abra em Código</button> e selecione as linhas — a pergunta vai pro agente que escreveu</div>`:'';
  let rows='';
  const diff=fwPath?fwDiffGet(t, fwPath):'';
  if(!fwPath) rows='<div class="empty">nenhum arquivo alterado</div>';
  else if(diff==null) rows=skeletonHtml('tabela',{ n:8, cols:2, inline:true, label:'carregando o diff' });
  else if(typeof diff==='object') rows=`<div class="empty" style="display:flex;flex-direction:column;gap:10px;align-items:center"><div style="color:var(--warn)">não consegui gerar o diff deste arquivo</div><div class="dim" style="font-size:var(--fs-sm);white-space:pre-wrap" title="${escA(String(diff.err||'').slice(0,400))}">${esc(errShort(diff.err))}</div><button class="btn sm" id="fwDiffRetry">tentar de novo</button></div>`;
  else if(!diff.trim()) rows='<div class="empty">sem diferenças neste arquivo em relação à base</div>';
  else rows=diffViewHtml(diffHunks(diff), { full:fwContentFor===t.id+'|'+fwPath?fwContent.split('\n'):null, keyPre:t.id+'|'+fwPath+'|' });
  main.innerHTML=`<div class="fwmhead">${fwTreeOpenBtn()}${fwPathHtml(fwPath)}<span class="fwmadd">+${f.add} <span style="color:var(--crit)">−${f.del}</span></span><span style="flex:1"></span></div>${band}<div class="fwdiff fwdv" id="fwRevDiff">${rows}</div>${askHint}`;
  bindClick('fwBackConv', ()=>{ fwMode='conversa'; fwRememberTab(); renderWorkspace(); });
  bindClick('fwRevByReq', ()=>{ rvViewM[t.id]='req'; fwRememberTab(); renderWorkspace(); });
  bindClick('fwRevMore', ()=>{ fwRevOpen=!fwRevOpen; renderWorkspace(); });
  bindClick('fwRevToCode', ()=>{ fwMode='codigo'; fwRememberTab(); fwLoadFile(); renderWorkspace(); });
  bindClick('fwDiffRetry', ()=>{ fwDiffCache[key]=undefined; renderWorkspace(); });
  fwWireGaps(main);
}
function fwWireGaps(root){ root.querySelectorAll('[data-dvgap]').forEach(b=>b.onclick=()=>{ const k=b.dataset.dvgap; if(fwDvOpen.has(k)) fwDvOpen.delete(k); else fwDvOpen.add(k); renderWorkspace(); }); }
// ---- página do PR dentro da execução (redesign p14) ----
function fwRenderPrPage(t, main){
  const info=prCache[t.id];
  if(info===undefined||info===null){
    if(info===undefined) loadPr(t.id).then(()=>{ if(fwTask===t.id&&fwMode==='pr') renderWorkspace(); });
    ldPaint(main, skeletonHtml('lista',{ head:true, n:5, inline:true, label:'carregando o PR' })); return; }
  if(!info.exists && info.error){
    // gh/rede falhou ≠ "não tem PR" — antes caía em "nenhum PR" e oferecia abrir OUTRO
    // sem acesso ao repo (conta errada no gh) ≠ sem rede: diz o que fazer, sem o texto cru do GraphQL
    const noAcc=info.errKind==='access';
    const head=noAcc?'o GitHub logado aqui (gh) não tem acesso a este repositório':'não consegui falar com o GitHub';
    const det=noAcc?String(info.error).replace(/^GH_NO_ACCESS:\s*/,''):String(info.error);
    main.innerHTML=`<div class="empty" style="display:flex;flex-direction:column;gap:12px;align-items:center"><div style="color:var(--warn)">${head}</div><div class="mono dim" style="font-size:var(--fs-xs);max-width:560px;white-space:pre-wrap">${esc(det.slice(0,300))}</div><div style="display:flex;gap:8px"><button class="btn sm" id="prPgRefresh">↻ tentar de novo</button>${noAcc?'<button class="btn sm" id="prPgEnv">abrir Ambiente (conta do GitHub)</button>':''}</div></div>`;
    bindClick('prPgEnv', ()=>{ if(window.openTab) window.openTab('env'); });
    bindClick('prPgRefresh', async(e)=>{ const b=e.currentTarget; b.disabled=true; b.textContent='tentando…'; await loadPr(t.id,true); renderWorkspace(); });
    return;
  }
  if(!info.exists){
    main.innerHTML=`<div class="empty" style="display:flex;flex-direction:column;gap:14px;align-items:center"><div>nenhum PR aberto ainda pra <b>${esc(t.branch)}</b></div><button class="btn primary" id="prPgCreate">${IC.merge} preparar e abrir o PR</button><div class="dim" style="font-size:var(--fs-xs)">roda as checagens do repo, faz commit &amp; push e cria o PR</div></div>`;
    bindClick('prPgCreate', ()=>approveGate(t));
    return;
  }
  // PR existe: "pronto pra integrar?" (63-revisao-pr) — 5 portões, cada vermelho com a saída; o que entra; linha do tempo
  prvRender(t, main, info);
}
// markdown leve nas bolhas (bold, `code`, títulos, listas) — sem ** cru na tela
// bloco [ELEMENTOS DA PÁGINA] (modo design da Prévia, 57-navegador) vira um resumo curto — o agente recebe o bloco inteiro
function chatMd(t){ try{ const sp=attSplit(t); const nv=(typeof nvSplit==='function')?nvSplit(sp.text):{ text:sp.text, sels:[] }; return mdToHtml(nv.text)+(nv.sels.length?nvSummaryHtml(nv.sels):'')+attRowHtml(sp.atts); }catch(_){ return esc(String(t||'')); } }
const mdMemo=new Map(); // evId:len → html (evita re-parsear a thread toda a cada tick)
function chatMdEv(id, t){ const k=id+':'+String(t||'').length; let v=mdMemo.get(k); if(v===undefined){ v=chatMd(t); if(mdMemo.size>800) mdMemo.clear(); mdMemo.set(k,v); } return v; }
// notas "de sistema" (não são fala do agente) viram linha discreta central
// link nas notas ("PR aberto: https://…") vira clicável — antes era texto cru que nem dava pra abrir
// (acha as URLs no texto CRU e escapa cada pedaço — no texto já escapado a URL engolia "&lt;b&gt")
function fwLinkify(tx){ const s=String(tx||''), re=/https?:\/\/[^\s<>"']+[^\s<>"'.,;:)]/g; let out='', last=0, m;
  while((m=re.exec(s))){ out+=esc(s.slice(last,m.index))+`<a class="lnk" href="#" data-ext="${escA(m[0])}">${esc(m[0].replace(/^https?:\/\//,''))}</a>`; last=m.index+m[0].length; }
  return out+esc(s.slice(last)); }
function isMetaNote(txt){ return /^(claude finalizou|\d+ artefato\(s\)|resumo técnico|sessão iniciada|requisito adicionado:|stderr:|PR aberto|PR NÃO aberto|falha ao finalizar)/i.test(String(txt||'')); }
// thread REAL (dos eventos do banco — persiste) + pergunta aberta destacada
// rótulo do modelo do agente na conversa (redesign p6: "VEGA · Opus")
// `ran` = o modelo que o MOTOR relatou ao iniciar a sessão ("sessão iniciada · <id>" / Route AI) — vale
// mais que o configurado; sem isso, usa o motor+modelo do papel (antes: "Claude" fixo até em tarefa Codex).
function agentModelLabel(t, name, ran){
  if(ran) return ran;
  const r=(t.roles||[]).find(x=>x.name===name);
  return aiRunLabel((r&&r.engine)||t.engine, (r&&r.model)||t.model);
}
// ---- chip de tool: nome técnico de ferramenta vira algo legível e bonito ----
const TOOL_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.4 2.6a3 3 0 0 0 3.9 3.9l2.7 2.7a1.15 1.15 0 0 1-1.6 1.6L8.7 8.1A3 3 0 0 1 4.8 4.2l1.7 1.7 1.1-1.1z" stroke-linejoin="round"/></svg>';
const TOOL_DONE_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 8.5l3 3 6-6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// parece nome técnico de ferramenta? (um token só, com __ ou CamelCase interno)
function looksLikeTool(tx){ const s=String(tx||'').trim(); return !/\s/.test(s) && s.length>1 && (s.includes('__') || /[a-z][A-Z]/.test(s)); }
function toolChip(label, done){
  return `<div class="ctool${done?' done':''}"><span class="ctool-ic">${done?TOOL_DONE_IC:TOOL_IC}</span><span class="ctool-tx">${esc(label)}</span></div>`;
}
// ---- várias ações seguidas (ler/rodar/editar) viram UMA linha, tipo Claude ----
const ACT_IC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 5.2l2.2 1.8L3 8.8M7.3 9.2h5.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function actSummary(evs){
  const c={}; for(const e of evs) c[e.type]=(c[e.type]||0)+1;
  const plu=(n,s,p)=>`${n} ${n>1?(p||s+'s'):s}`;
  const parts=[];
  if(c.read) parts.push(plu(c.read,'arquivo lido','arquivos lidos'));
  if(c.bash) parts.push(plu(c.bash,'comando','comandos'));
  if(c.edit) parts.push(plu(c.edit,'edição','edições'));
  if(c.write) parts.push(plu(c.write,'arquivo criado','arquivos criados'));
  if(c.claim) parts.push(plu(c.claim,'reivindicação','reivindicações'));
  const known=(c.read||0)+(c.bash||0)+(c.edit||0)+(c.write||0)+(c.claim||0);
  const other=evs.length-known; if(other>0) parts.push(plu(other,'ação','ações'));
  return parts.join(' · ') || plu(evs.length,'ação','ações');
}
function actLine(evs){
  const details=evs.slice(-10).map(e=>String(e.text||'').replace(/\s+/g,' ').slice(0,70)).join('\n');
  return `<div class="cact cactsum" title="${escA(details)}"><span class="cg">${ACT_IC}</span><span class="ct">${esc(actSummary(evs))}</span></div>`;
}
// ---- "o que o agente está fazendo agora" na conversa da tarefa (29/09) ----
// Antes a conversa só mostrava "N edições" depois do fato; o planner e o chat do projeto já mostravam cada passo
// ("lendo X", "rodando npm test"). Aqui o mesmo, alimentado pelos EVENTOS da tarefa (read/bash/edit/… do motor).
function fwRelPath(p){ const s=String(p||'').trim().replace(/\s*\((read|write)\)$/,''); const parts=s.split('/').filter(Boolean); return parts.slice(-2).join('/')||s; }
// comando sem o ruído de ambiente ("export A=b; cd x && npm test" → "npm test")
function fwBashShort(cmd){
  let c=String(cmd||'').replace(/\s+/g,' ').trim();
  for(let i=0;i<6;i++){ const c2=c.replace(/^export\s+[^;&]*(?:;|&&)\s*/,'').replace(/^cd\s+[^;&]+(?:;|&&)\s*/,'').replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/,''); if(c2===c) break; c=c2; }
  return c.length>70?c.slice(0,70)+'…':c;
}
const FW_BROWSER_PT={ navigate:'abrindo a página', click:'clicando na página', take_screenshot:'tirando print', snapshot:'lendo a página', evaluate:'rodando script na página', type:'digitando na página', fill_form:'preenchendo formulário', press_key:'apertando tecla', wait_for:'esperando a página', hover:'passando o mouse', select_option:'escolhendo opção', console_messages:'lendo o console', network_requests:'lendo a rede' };
// PURA — evento do motor → frase curta em pt-BR ('' = não é uma ação)
function fwActLabel(e){
  const ty=e&&e.type, tx=String((e&&e.text)||'').replace(/\s+/g,' ').trim();
  if(ty==='read'){
    if(/^(buscando|listando|consultando) /.test(tx)) return tx.slice(0,90);
    if(/[*?]/.test(tx)) return 'listando '+tx.slice(0,60); // evento antigo: padrão cru do Glob
    if(tx && !tx.includes('/') && !/\.\w{1,6}$/.test(tx)) return 'buscando "'+tx.slice(0,60)+'"'; // …e do Grep
    return tx?'lendo '+fwRelPath(tx):'lendo um arquivo';
  }
  if(ty==='edit') return 'editando '+fwRelPath(tx);
  if(ty==='write') return 'criando '+fwRelPath(tx);
  if(ty==='bash') return tx?'rodando '+fwBashShort(tx):'rodando um comando';
  if(ty==='claim') return 'reservando '+fwRelPath(tx);
  if(ty==='note'){
    if(/^subagente: /.test(tx)) return tx.slice(0,90);
    if(tx==='atualizou o plano') return 'atualizando o plano';
    const m=tx.match(/^mcp__(.+?)__(.+)$/);
    if(m && !/\s/.test(tx)){ const act=m[2].replace(/^browser_/,'');
      if(m[1]==='playwright') return FW_BROWSER_PT[act]||('navegador: '+act.replace(/_/g,' '));
      return (m[1]==='cardume'?'':m[1]+': ')+act.replace(/_/g,' '); }
  }
  return '';
}
// PURA — ações do turno ATUAL (depois da última fala sua / resposta / início de sessão / pedido da fila)
function fwTurnActs(evs){
  const L=evs||[]; let start=-1;
  for(let i=L.length-1;i>=0;i--){ const e=L[i], tx=String(e.text||'');
    if(evIsUserMsg(e) || tx.startsWith('humano respondeu:') || /^sessão iniciada/.test(tx) || /^▶ executando pedido/.test(tx)){ start=i; break; } }
  const acts=[]; for(let i=start+1;i<L.length;i++){ const l=fwActLabel(L[i]); if(l) acts.push({ label:l, ts:fwEvTs(L[i]) }); }
  const since=start>=0?fwEvTs(L[start]):(acts.length?acts[0].ts:0);
  return { acts, since };
}
function fwTempo(ms){ const s=Math.max(0, Math.round((+ms||0)/1000)); return s<60?s+'s':Math.floor(s/60)+'min '+String(s%60).padStart(2,'0')+'s'; }
function fwLiveHead(since, n, now){ return 'trabalhando'+(since?' · '+fwTempo(now-since):'')+(n?' · '+nPl(n,'ação','ações'):''); }
let fwLiveOpen=false; // lista de passos aberta (sobrevive aos re-renders do poll)
function fwLiveHtml(t, evs, now){
  const a=fwTurnActs(evs), n=a.acts.length;
  const cur=n?a.acts[n-1].label:'começando — lendo a conversa e o código…';
  const list=fwLiveOpen&&n>1?`<div class="placts fwlivel">${a.acts.slice(-12,-1).map(x=>`<div>${esc(x.label)}</div>`).join('')}</div>`:'';
  return `<div class="cmsg bot fwlive" id="fwLive"><span class="cav" aria-hidden="true" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span><div class="cbub think"><div class="fwliveh"><span class="pulse" style="--pc:var(--good)"></span><span id="fwLiveHead" data-since="${a.since||0}" data-n="${n}">${esc(fwLiveHead(a.since, n, now))}</span>${n>1?`<button class="fwlivetg" id="fwLiveTg" aria-expanded="${fwLiveOpen?'true':'false'}">${fwLiveOpen?'esconder passos':'ver passos'}</button>`:''}</div><div class="fwlivecur"><span class="cg">${ACT_IC}</span><span>${esc(cur)}</span></div>${list}</div></div>`;
}
// tique de 1s: só o tempo do cabeçalho (sem re-render da conversa)
function fwLiveTick(){ const h=$id('fwLiveHead'); if(!h) return; const tx=fwLiveHead(+h.dataset.since||0, +h.dataset.n||0, Date.now()); if(h.__html!==tx){ h.textContent=tx; h.__html=tx; } }
function fwThreadHtml(t){
  const evs=fwEvents.length?fwEvents:eventsOf(t.id); // completos (fallback: snapshot)
  const asking=pendingOf(t.id);
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy) && !asking.length;
  let lastWho='', lastAsk='';
  const ranBy={}; // agente → modelo que o motor relatou (o que RODOU de fato)
  const out=[]; let act=[];
  const flush=()=>{ if(act.length){ out.push(actLine(act)); act=[]; } };
  for(let e of evs){
    let tx=e.text||'';
    { const m=tx.match(/^sessão iniciada · ([^\s·]+)/); if(m) ranBy[e.agent]=aiRunLabel('claude', m[1]);
      const ra=tx.match(/^Route AI: rodando na (.+) \(([^)]+)\)$/); if(ra) ranBy[e.agent]=ra[1]+' · '+ra[2]; }
    // P10: "skills ativas · agente@vN · motor" é medição — fica no "ver detalhes" da faixa, não na conversa
    if(e.type==='papel') continue;
    if(evIsUserMsg(e)){ flush(); lastWho=''; out.push(`<div class="cmsg you"><div class="cbub">${chatMdEv(e.id, evUserText(tx))}<button class="ccopy" title="copiar">⧉</button></div></div>`); continue; }
    if(tx.startsWith('humano respondeu:')){ flush(); lastWho=''; out.push(`<div class="cmsg you"><div class="cbub">${chatMdEv(e.id, tx.replace(/^humano respondeu:\s*/,''))}<button class="ccopy" title="copiar">⧉</button></div></div>`); continue; }
    if(isMetaNote(tx)){ flush(); out.push(`<div class="csys">${fwLinkify(tx)}</div>`); continue; }
    // nota de sistema do motor (fila, limite de uso, sessão retomada, rota de IA): linha de sistema com ícone
    if(e.agent==='Sistema' && e.type==='note'){ const ic=evSysIcon(tx); if(ic){ flush(); out.push(`<div class="csys">${ic} ${esc(tx)}</div>`); continue; } }
    // pergunta ABERTA já aparece no card destacado; a que ficou pra trás (respondida ou órfã) entra no histórico
    // como fala do agente — senão a resposta dele ficava solta, sem a pergunta. Dedup: o motor grava 2x (stream + MCP).
    if(tx.startsWith('perguntou ao humano:')){ if(asking.length || tx===lastAsk) continue; lastAsk=tx; e={...e, type:'think', text:tx.replace(/^perguntou ao humano:\s*/,'')}; tx=e.text; }
    // outro agente (ou este) mudou a SPEC desta tarefa (47-edicoes-agente): card com antes → depois + desfazer
    if((e.type==='spec-edit'||e.type==='spec-proposal') && typeof aeEventHtml==='function'){ flush(); lastWho=''; out.push(aeEventHtml(t, e)); continue; }
    // chamada de ferramenta crua (ToolSearch, mcp__…): é ruído interno — o valor
    // está no RESULTADO (entregável/issue registrados, abaixo). Esconde a chamada, igual o Claude faz.
    if(e.type==='note' && looksLikeTool(tx)) continue;
    // resultado de tool (entregável/issue/"pronto quando" registrados; os antigos vinham com emoji → e.tool) → linha sutil "concluído"
    if(e.type==='note' && (e.tool || /^(entregável novo registrado|issue registrada|pronto quando |tarefa atualizada|épico atualizado)/.test(tx))){ flush(); lastWho=''; out.push(toolChip(tx.replace(/\s*\(ref\s+\w+\)\s*$/i,''), true)); continue; }
    if(['think','note','done'].includes(e.type) && tx.trim()){
      flush();
      const who=e.agent!==lastWho?`<div class="cwho"><b>${esc(e.agent||'')}</b><span class="cwho-m"> · ${esc(agentModelLabel(t,e.agent,ranBy[e.agent]))}</span></div>`:'';
      lastWho=e.agent;
      out.push(`<div class="cmsg bot"><span class="cav" aria-hidden="true" style="background:${agentColor(e.agent)}">${agentBadge(e.agent)}</span><div style="min-width:0;flex:1">${who}<div class="cbub">${chatMdEv(e.id, tx)}<button class="ccopy" title="copiar">⧉</button></div></div></div>`);
      continue;
    }
    if(e.type==='error'){ flush(); out.push(`<div class="cmsg bot"><span class="cav" aria-hidden="true" style="background:var(--crit)">!</span><div class="cbub err">${esc(tx)}</div></div>`); continue; }
    // atividade (ler/rodar/editar/…) — acumula pra virar UMA linha de raciocínio
    act.push(e);
  }
  // trabalhando: os passos do turno atual vivem na faixa ao vivo (abaixo) — não repete o resumo na conversa
  if(working) act=[]; else flush();
  // eco otimista: mensagens enviadas que o banco ainda não confirmou (ver fwOptim)
  for(const o of fwOptimFor(t.id, evs, { now:Date.now(), working:(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy), queued:t.queued })) out.push(fwOptimHtml(o));
  return out.join('')
  + (asking.length?`<div class="cmsg bot"><span class="cav" aria-hidden="true" style="background:${agentColor(asking[0].agent||t.agent)}">${agentBadge(asking[0].agent||t.agent)}</span><div style="min-width:0;flex:1"><div class="cwho" style="color:var(--warn)">${asking[0].kind==='budget'?'<b>Teto de custo</b><span class="cwho-m"> · sua decisão</span>':'<b>'+esc((asking[0].agent||t.agent)||'')+'</b><span class="cwho-m"> · pergunta pra você</span>'}</div><div class="cbub asknow">${chatMd(asking[0].prompt||'aguardando sua resposta')}${(()=>{ const sent=fwAskSent[fwAskKey(asking[0])];
      return (Array.isArray(asking[0].options)&&asking[0].options.length?`<div class="askopts${sent!=null?' sent':''}">${asking[0].options.map(o=>`<button data-askopt="${escA(o)}"${sent!=null?` disabled${sent===o?' class="on" aria-pressed="true"':''}`:''}>${esc(o)}</button>`).join('')}</div>`:'')
        +(sent!=null?'<div class="asknote"><span class="spin"></span> resposta enviada — o agente retoma o turno</div>':`<div class="asknote">${asking[0].kind==='budget'?'escreva o valor e o motivo aqui ou na seção do topo — o agente fica parado até você decidir':'responda abaixo (ou toque numa opção) — o turno continua'}</div>`); })()}</div></div></div>`:'')
  + (working?fwLiveHtml(t, evs, Date.now()):'');
}
// requisitos com status ao vivo (o "no que ele está trabalhando")
function fwReqsHtml(t){
  const reqs=Array.isArray(t.requirements)?t.requirements:[]; if(!reqs.length) return '';
  const c=reqProofCache[t.id];
  if(c===undefined) fwReqProofsEnsure(t.id);
  const matched=matchReqProofs(reqs, c&&c.list);
  const rows=reqs.map((r,ri)=>{ const m=matched[ri]; const st=m?(m.status==='done'?'ok':'blk'):'na';
    const icon= st==='ok'?`<span class="reqst ok">${IC.check}</span>`:st==='blk'?'<span class="reqst blk">!</span>':'<span class="reqst na">·</span>';
    const ev=(m&&Array.isArray(m.evidence)&&m.evidence.length)?`<span class="reqev">${m.evidence.map(e=>`<button class="reqevb mono" data-art="${escA(e)}">${esc(e)}</button>`).join('')}</span>`:'';
    return `<div class="critrow2 ${st}">${icon}<div class="crt"><div>${esc(r)} ${ev}</div></div></div>`; }).join('');
  const canCheck=(!c||c.list===null)&&['review','error','aborted'].includes(t.status);
  const checkBtn=canCheck?'<button class="btn sm" id="fwReqCheck" style="margin-top:6px;width:100%">verificar requisitos agora (gera as provas)</button>':'';
  return `<div class="fwreqh">Requisitos <span class="dim">${(c&&Array.isArray(c.list))?c.list.filter(x=>x.status==='done').length+'/'+reqs.length:reqs.length}</span></div>${rows}${checkBtn}`;
}
function fwHideMenu(){ const m=$id('fwMenu'); if(m){ m.style.display='none'; m.innerHTML=''; } }
// "/" lista os REQUISITOS (pedir revisão de um específico) · "@" referencia arquivos/artefatos
async function fwShowMenu(t, kind){
  const m=$id('fwMenu'); if(!m) return;
  let items=[];
  if(kind==='req'){
    for(const s of CHAT_SKILLS) items.push({label:'/'+s.label+' — '+s.desc, kind:'skill', skill:s});
    const ags=(t.roles||[]).filter(r=>aiCanTalk(r.engine));
    if(ags.length>1) for(const r of ags) items.push({label:r.name+' · '+(ROLE_PT[r.role]||r.role), kind:'falar com', agent:r.name});
    const reqs=Array.isArray(t.requirements)?t.requirements:[];
    for(const r of reqs) items.push({label:r, kind:'requisito', ins:null, req:r});
    if(reqs.length>1) items.push({label:'TODOS os requisitos (verificação completa)', kind:'ação', req:'__all__'});
  } else {
    let files=[]; let arts=[];
    try{ files=await invoke('task_files',{ taskId:t.id }); }catch(_){ }
    try{ arts=await invoke('list_artifacts',{ taskId:t.id }); }catch(_){ }
    items=[...files.slice(0,12).map(f=>({label:f.path, ins:f.path, kind:'arquivo'})),
           ...arts.filter(a=>a.name!=='requirements.json').slice(0,8).map(a=>({label:a.name, ins:'.cardume/artifacts/'+a.name, kind:'artefato'}))];
  }
  if(!items.length){ fwHideMenu(); return; }
  m.innerHTML=`<div class="ath">${kind==='req'?'skills · agentes · requisitos':'referenciar'}</div>`+items.map((it,i)=>`<button class="atit" data-mi="${i}"><span class="${kind==='req'?'':'mono'}"${it.kind==='skill'?' style="color:var(--accent)"':''}>${esc(it.label)}</span><span class="atk">${it.kind}</span></button>`).join('');
  m.style.display='block';
  m.querySelectorAll('.atit').forEach(b=>b.onclick=()=>{
    const it=items[+b.dataset.mi]; const i=$id('fwInput');
    if(it.skill){
      i.value=i.value.replace(/\/$/,''); fwDraft[t.id]=i.value; // tira só o "/" — o que já estava escrito fica
      fwHideMenu();
      fwSendText(t.id, it.skill.prompt());
      return;
    }
    if(it.agent){
      const t2=fwTaskObj();
      const deflt=((t2&&t2.roles)||[]).find(r=>aiCanTalk(r.engine));
      fwAgentSel = (deflt && it.agent===deflt.name) ? null : it.agent;
      i.value=i.value.replace(/[@/]$/,'');
      fwHideMenu(); renderWorkspace(); const ni=$id('fwInput'); if(ni) ni.focus();
      return;
    }
    if(kind==='req'){
      i.value = it.req==='__all__'
        ? 'Verifique TODOS os requisitos do TASK.yaml um a um: status real, evidência (print/teste) linkada e requirements.json atualizado; me pergunte se algum não estiver cumprido.'
        : `Revisar o requisito: "${it.req}" — confira se está REALMENTE cumprido; se não estiver, cumpra agora; e linke a evidência (print e/ou teste) no requirements.json.`;
    } else {
      i.value=i.value.replace(/[@/]$/,'')+'`'+it.ins+'` ';
    }
    fwHideMenu(); i.focus();
  });
}
// envio "programático" (skill do "/", verificar requisitos, aplicar correção do PR, pedir o preview): mesmo
// caminho do composer — eco otimista na hora e, com o agente TRABALHANDO, vai NA FILA. Antes parava o turno
// em curso sem perguntar (um clique numa skill matava o trabalho do agente) e engolia o resultado: quem
// chamou trocava de tela/avisava "enviado" mesmo com falha. Devolve true/false.
async function fwSendText(taskId, text){
  const t=(state.tasks||[]).find(x=>x.id===taskId); if(!t||!String(text||'').trim()) return false;
  const pend=pendingOf(t.id).filter(p=>!fwAskIsSent(p));
  // teto de custo aberto: skill/verificar/aplicar correção/pedir preview NÃO podem virar a resposta — qualquer texto
  // que não seja "parar" amplia o teto e retoma o gasto. A tarefa fica pausada até a pessoa decidir.
  if(pend.some(fwIsBudgetAsk)){ toast('a tarefa está pausada no teto de custo — responda a pergunta do teto primeiro','warn'); return false; }
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy);
  const op={ text, at:Date.now(), st:'enviando' };
  (fwOptim[t.id]=fwOptim[t.id]||[]).push(op);
  if(fwTask===t.id) fwPaintThread(t);
  try{
    if(t.status==='paused' && t.busy && !pend.length){ try{ await invoke('resume_task',{ taskId:t.id }); }catch(e){ console.error('retomar antes de enviar', e); } }
    if(pend.length){ fwAskSent[fwAskKey(pend[0])]=text; await resolvePending(pend[0].id, text); }
    else { await invoke('talk_task',{ taskId:t.id, message:text, asReq:false, agent:fwTask===t.id?fwAgentSel:null }); commitsCache[t.id]=undefined; prCache[t.id]=undefined; }
    op.st=(working&&!pend.length)?'fila':'enviada';
    fwInvalidate(t.id); lastSig=''; refresh().catch(()=>{});
    if(fwTask===t.id) renderWorkspace();
    return true;
  }catch(e){
    if(pend.length) delete fwAskSent[fwAskKey(pend[0])];
    fwOptim[t.id]=(fwOptim[t.id]||[]).filter(x=>x!==op);
    if(fwTask===t.id) fwPaintThread(fwTaskObj());
    showErr(e, 'Falha ao enviar'); return false;
  }
}
const fwPend={}; // taskId → anexos importados ainda não enviados
// ---- ECO OTIMISTA do envio (travamento 28/09) ----
// Antes: o campo ficava desabilitado e a mensagem só aparecia depois de parar + talk_task + refresh
// completo — com o snapshot ocupado eram 8,5s de tela "congelada" (medido no harness) e, se o
// refresh estourava, nada aparecia. Agora a bolha entra NA HORA com o estado do envio e some quando
// o evento real chega (fala "Você: …", resposta a pergunta, ou o aviso "Na fila (…)" do motor).
const fwOptim={}; // taskId → [{ text, at, st:'enviando'|'lento'|'enviada'|'fila' }]
function fwOptimFor(taskId, evs, ctx){
  const list=fwOptim[taskId]; if(!list||!list.length) return [];
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
  // só confirma com evento DEPOIS do envio (2s de folga de relógio) e cada evento confirma UMA bolha — antes a
  // janela era "até 60s antes" e comparava ts ISO (texto) com número: um texto fixo repetido ("verificar requisitos")
  // era dado como confirmado pelo evento do clique anterior e a 2ª bolha sumia na hora
  const used=new Set();
  const seen=o=>(evs||[]).some((e,i)=>{ if(used.has(i)) return false; const ts=fwEvTs(e); if(ts && ts<o.at-2000) return false; const tx=String(e.text||'');
    const hit = evIsUserMsg(e) ? norm(evUserText(tx))===norm(o.text)
      : tx.startsWith('humano respondeu:') ? norm(tx.replace(/^humano respondeu:\s*/,''))===norm(o.text)
      : (/^Na fila \(/.test(tx) && tx.includes(norm(o.text).slice(0,60)));
    if(hit) used.add(i); return hit; });
  // estado da bolha segue a VERDADE (29/09: ficava "enviada · aguardando o agente" com nenhum turno rodando)
  if(ctx) for(const o of list){ o.st=fwEchoNext(o, { now:ctx.now, working:!!ctx.working, queued:+ctx.queued||0, agentAfter:fwAgentAfter(evs, o.at) }); if(o.st==='fila'||o.st==='fila-parada') o.q=+ctx.queued||0; }
  // confirmada pelo banco → sai. Envio em voo esquecido (3 min) ou turno que começou e acabou sem eco → sai.
  // "não começou"/"na fila" FICAM (até 30 min): antes sumiam em 3 min e a mensagem se perdia sem aviso.
  const now=ctx?ctx.now:Date.now();
  fwOptim[taskId]=list.filter(o=>!seen(o) && o.st!=='fim' && now-o.at<(['enviando','lento','enviada','comecou'].includes(o.st)?180000:1800000));
  return fwOptim[taskId];
}
function fwEvTs(e){ const v=e&&e.ts; return typeof v==='number'?v:(Date.parse(v||'')||0); }
// algum AGENTE fez algo depois do envio? (fala, ferramenta) — o turno começou mesmo sem o eco da mensagem
function fwAgentAfter(evs, at){ return (evs||[]).some(e=>{ const ts=fwEvTs(e); return ts>=at-2000 && !evIsUserMsg(e) && e.agent!=='Sistema' && e.agent!=='Você'; }); }
// PURA — máquina de estados do eco: enviando/lento (invoke em voo) → enviada → comecou → (some com o evento real)
// · sem turno em 20s → parou ("tentar de novo") · na fila → fila (turno atual) / fila-parada (turno que ia rodar morreu)
const FW_ECHO_WAIT_MS=20000;
function fwEchoNext(o, c){
  const age=c.now-o.at;
  if(o.st==='enviando'||o.st==='lento') return o.st;
  if(o.st==='fila'||o.st==='fila-parada'){
    if(c.working) return 'fila';
    if(c.queued>0) return 'fila-parada';
    return age>FW_ECHO_WAIT_MS?'parou':o.st;
  }
  if(o.st==='comecou') return (!c.working && age>FW_ECHO_WAIT_MS)?'fim':'comecou';
  if(c.working || c.agentAfter) return 'comecou';
  return age>FW_ECHO_WAIT_MS?'parou':o.st;
}
function fwOptimCap(o){
  return o.st==='lento' ? 'ainda enviando — o app está ocupado; pode continuar escrevendo'
    : o.st==='fila' ? `na fila${o.q?' ('+o.q+'º)':''} — o agente está no meio de um turno; lê assim que terminar`
    : o.st==='fila-parada' ? 'parada na fila — o turno que ia ler foi encerrado. Mande outra mensagem que ele retoma e lê esta em seguida'
    : o.st==='comecou' ? 'o agente começou'
    : o.st==='parou' ? 'não começou — nenhum turno pegou esta mensagem'
    : o.st==='enviada' ? 'enviada · esperando o agente começar'
    : 'enviando…';
}
function fwOptimHtml(o){
  const spin=['enviando','lento','enviada'].includes(o.st), bad=o.st==='parou'||o.st==='fila-parada';
  const act=o.st==='parou'?`<span class="optim-act"><button class="btn sm" data-fwretry="${o.at}">${IC.refresh||''} tentar de novo</button><button class="btn sm ghost" data-fwedit="${o.at}">editar</button></span>`:'';
  return `<div class="cmsg you optim${bad?' bad':''}"><div class="cbub">${chatMd(o.text)}<div class="optim-st">${spin?'<span class="spin"></span> ':o.st==='comecou'?'<span class="pulse" style="--pc:var(--good)"></span> ':''}${esc(fwOptimCap(o))}</div>${act}</div></div>`;
}
// repinta SÓ a conversa (não mexe no campo de texto) e desce pro fim
const fwThreadPinned={}; // tarefa → a conversa está presa no fim? (ausente = sim)
// gruda a conversa no fim assim que ela tiver altura (até ~10 quadros); para se a pessoa rolar pra cima
function fwStickBottom(th){
  let n=0; th.__fwStick=(th.__fwStick||0)+1; const id=th.__fwStick;
  const tick=()=>{ if(id!==th.__fwStick || !th.isConnected) return;
    if(th.clientHeight>0){ if(th.scrollHeight-th.scrollTop-th.clientHeight>2) th.scrollTop=th.scrollHeight; return; }
    if(++n<10) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  th.addEventListener('wheel', ()=>{ th.__fwStick=(th.__fwStick||0)+1; }, { once:true, passive:true }); // rolou: não puxa mais
}
function fwPaintThread(t){ const th=$id('fwThread'); if(!th||!t||th.dataset.term) return; th.innerHTML=fwThreadHtml(t); th.scrollTop=th.scrollHeight; }
async function fwSendMsg(queueOnly){
  const t=fwTaskObj(); if(!t) return;
  const inp=$id('fwInput'); if(!inp) return; const typed=inp.value; let v=typed.trim();
  const atts=(fwPend[t.id]||[]).splice(0);
  if(!v && atts.length) v='Anexei estes arquivos — leia e considere.';
  if(!v) return;
  // modo terminal com pergunta aberta: o texto vira a resposta da pergunta da vez (a folha manda pro hook)
  // (anexo não cabe numa resposta: volta pro compositor e vai depois, quando a pergunta fechar)
  if(typeof termViewOf==='function' && termViewOf(t) && typeof tlAskFromComposer==='function' && typed.trim() && pendingOf(t.id).some(p=>!fwIsBudgetAsk(p)) && tlAskFromComposer(t, typed.trim())){ inp.value=''; fwDraft[t.id]=''; if(atts.length){ (fwPend[t.id]=fwPend[t.id]||[]).unshift(...atts); toast('os anexos ficaram no compositor — mande depois que a pergunta fechar','info'); renderWorkspace(); } return; }
  // aba Terminal de tarefa integrada cuja worktree foi apagada: não há sessão pra retomar — diz numa linha e o
  // botão da barra abre a tarefa nova de ajuste (o texto e os anexos ficam no compositor)
  if(typeof termWtGone==='function' && termWtGone(t.id) && !pendingOf(t.id).length){ (fwPend[t.id]=fwPend[t.id]||[]).unshift(...atts); termSayLine(t.id, TERM_WT_GONE+' (botão na barra acima)'); toast(TERM_WT_GONE,'warn'); if(atts.length) renderWorkspace(); return; }
  const sel=fwSelRange();
  // só amarra ao arquivo quando o usuário SELECIONOU linhas — mensagem sem seleção vai pura
  const ctx = sel ? `Sobre ${fwPath}:${sel.a}${sel.b>sel.a?'-'+sel.b:''}: ` : '';
  const asReq=!!($id('fwAsReq')&&$id('fwAsReq').checked);
  const full = ctx+v+attPromptBlock(atts);
  const working=(ACTIVE_ST.has(t.status)||t.status==='thinking'||t.busy);
  // pergunta já respondida (opção clicada, snapshot ainda não chegou) não conta: a mensagem vai como conversa
  const pend0=pendingOf(t.id).filter(p=>!fwAskIsSent(p));
  const asking=pend0.length>0;
  const op={ text:full, at:Date.now(), st:'enviando' }; let answered=null;
  (fwOptim[t.id]=fwOptim[t.id]||[]).push(op);
  inp.value=''; inp.disabled=true; fwDraft[t.id]='';
  fwPaintThread(t);
  // o campo NUNCA fica preso: se o backend demorar (runtime/banco ocupado), libera em 4s e avisa na bolha
  const slow=setTimeout(()=>{ if(op.st!=='enviando') return; op.st='lento'; const i=$id('fwInput'); if(i) i.disabled=false; if(fwTask===t.id) fwPaintThread(fwTaskObj()); }, 4000);
  // tarefa PAUSADA (processo congelado): sem retomar, a mensagem entrava numa fila que nunca andava
  // …MAS não quando há pergunta aberta: a pausa do TETO DE CUSTO é uma pergunta — responder "parar aqui" pelo
  // campo retomava o agente (gastando) antes de parar; quem retoma nesse caso é a própria resposta
  if(t.status==='paused' && t.busy && !asking){ try{ await invoke('resume_task',{ taskId:t.id }); lastSig=''; }catch(e){ console.error('retomar antes de enviar', e); } }
  try{
    // pergunta já respondida (opção clicada, snapshot ainda não chegou) não recebe 2ª resposta: vai como mensagem
    const pend=pendingOf(t.id).filter(p=>!fwAskIsSent(p));
    if(pend.length){
      // pergunta aberta → responder CONTINUA o mesmo turno
      answered=pend[0]; fwAskSent[fwAskKey(answered)]=full;
      await resolvePending(pend[0].id, full);
    } else if(!queueOnly && working){
      // trabalhando → para o turno atual (inclusive turno de fundo) e manda já
      // (o stop_task só volta com o turno MORTO — senão a mensagem caía na fila do processo que morria)
      try{ await stopTask(t.id); }catch(_){ }
      await invoke('talk_task',{ taskId:t.id, message:full, asReq, agent: fwAgentSel }); commitsCache[t.id]=undefined; prCache[t.id]=undefined;
    } else {
      // livre, ou o usuário escolheu "na fila" → o motor enfileira se ocupado
      await invoke('talk_task',{ taskId:t.id, message:full, asReq, agent: fwAgentSel }); commitsCache[t.id]=undefined; prCache[t.id]=undefined;
    }
    op.st=(queueOnly && working && !asking)?'fila':'enviada';
    // aba Terminal: a mensagem pode ter RETOMADO a sessão no PTY (talk_task → term::route) — o xterm vira o vivo
    if(!answered && typeof termViewOf==='function' && termViewOf(t) && typeof termGoLive==='function') termGoLive(t.id);
    // pergunta sintética (teto de custo, id < 0) não gera o evento "humano respondeu" que apagaria a bolha:
    // sem isto ela ficava 3 min "aguardando o agente"
    if(answered && fwIsBudgetAsk(answered)) fwOptim[t.id]=(fwOptim[t.id]||[]).filter(x=>x!==op);
    fwInvalidate(t.id); fwAsReqOn[t.id]=false;
    // a seleção de linhas foi usada NESTA mensagem: sai (antes ficava e prefixava "Sobre arquivo:linhas" em
    // todas as mensagens seguintes). Se o usuário já marcou outro trecho durante o envio, esse fica.
    { const s2=fwSelRange(); if(sel && s2 && s2.a===sel.a && s2.b===sel.b){ fwSelA=0; fwSelB=0; } }
    // refresh SEM await: a bolha já está na tela; o estado real chega no próximo snapshot
    lastSig=''; refresh().catch(()=>{});
  }catch(e){
    // falhou: o texto e os anexos VOLTAM pro composer (antes a mensagem sumia)
    fwOptim[t.id]=(fwOptim[t.id]||[]).filter(x=>x!==op); if(answered) delete fwAskSent[fwAskKey(answered)];
    // (se ele já começou outra mensagem durante um envio lento, as duas ficam no campo)
    const cur=(($id('fwInput')||{}).value||'').trim(); fwDraft[t.id]=cur?typed+'\n'+cur:typed; (fwPend[t.id]=fwPend[t.id]||[]).unshift(...atts);
    showErr(e, 'Não consegui enviar — o texto voltou pro campo'); }
  finally{
    clearTimeout(slow);
    const i0=$id('fwInput'); if(i0) i0.disabled=false;
    if(fwTask===t.id){ renderWorkspace(); const i=$id('fwInput'); if(i) i.focus(); }
  }
}
// fechar pelo botão: pergunta antes de jogar fora uma edição não salva
$id('fwClose').onclick=async()=>{ if(!await fwLeaveEditor()) return; closeWorkspace(); };
$id('fwOverlay').addEventListener('click', e=>{ if(e.target.id==='fwOverlay') closeWorkspace(); });
$id('sumOverlay').addEventListener('click', e=>{ if(e.target.id==='sumOverlay') e.target.style.display='none'; });
function fwVisible(){ const o=$id('fwOverlay'); return !!(o && o.style.display!=='none'); }
// Esc: no editor → cancela a edição (perguntando se há alteração); fora dele só fecha a aba se
// NADA está sendo digitado e não há rascunho/anexo pendente (antes um Esc perdido fechava a tarefa)
document.addEventListener('keydown', async e=>{ if(e.key==='Escape' && fwVisible()){
  if(fwEditing){ e.preventDefault(); if(await fwLeaveEditor()) renderWorkspace(); return; }
  if(escBusy(e)) return; // digitando no chat ou com modal por cima: o Esc não fecha a aba da tarefa
  if(fwHasDraft()) return;
  // Prévia: Esc desliga a mira; com seleções pendentes não fecha a aba (perderia os prints escolhidos)
  if(fwMode==='previa' && typeof nvEscape==='function' && nvEscape(fwTask)) return;
  closeWorkspace(); } });
// ⌘B / Ctrl+B com a tarefa na tela: recolhe/mostra a árvore de arquivos (captura: não deixa o atalho
// global de recolher a barra lateral agir junto)
document.addEventListener('keydown', e=>{
  if(!(e.metaKey||e.ctrlKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase()!=='b' || !fwVisible()) return;
  e.preventDefault(); e.stopPropagation(); fwToggleTree();
}, true);
// sem escolha salva, a árvore acompanha a largura da janela (recolhe abaixo de ~1100px)
{ let last=fwTreeHidden(), tmr=null;
  window.addEventListener('resize', ()=>{ clearTimeout(tmr); tmr=setTimeout(()=>{ const now=fwTreeHidden(); if(now!==last){ last=now; if(fwVisible()&&fwTask) renderWorkspace(); } }, 150); }); }
// atualiza SÓ o "O que estou fazendo agora" ao vivo (não mexe no código/input)
// (o refresh de 1s chama fwLiveUpdate quando o workspace está aberto — sem timer duplicado)
