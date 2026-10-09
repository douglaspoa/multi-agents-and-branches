// Starfork — 08-corrente: "cada coisa mostra a CORRENTE inteira" (mock aprovado pelo dono, mesa 09/10 D2–D5).
// issue → épico → tarefa (com quem) → PR → provas → entrega, em chips clicáveis IGUAIS em todo lugar (painel de Issues,
// cabeçalho da tarefa, Entregas por dia). Fonte única: chainOf(tarefa local OU cartão da nuvem) → elos; chainHtml(elos)
// → chips. O clique é um só (delegado no documento): issue abre no painel (ou o link), épico abre a página dele, tarefa
// abre a tarefa (a minha) ou a página de entrega (a do colega), PR abre no GitHub, provas abrem a entrega.

// @puro-corrente-inicio (testado em app/tests/corrente.test.mjs)
// x = tarefa local ({ id, title, issueCode, issueUrl, epic:{epicId}, prUrl, status, flag }) ou cartão ({ id, team_id,
// title, spec:{issueCode,issueUrl}, issue_url, epic_id, pr_url, assignee, created_by, status, local_id })
// k = { card(localId)→cartão|null, local(cardId)→tarefa|null, epicName(id)→nome, me, proofs(x)→n|null }
function chainIsCard(x){ return !!x && (x.team_id!==undefined || x.created_by!==undefined || x.issue_url!==undefined); }
function chainIssueCode(s){ const m=String(s||'').match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/); return m?m[1]:''; }
function chainOf(x, k){
  k=k||{}; if(!x) return null;
  const isCard=chainIsCard(x);
  const card=isCard?x:(k.card?k.card(x.id):null), local=isCard?(k.local?k.local(x.id):null):x;
  const sp=(card&&card.spec)||{};
  const code=String(sp.issueCode||sp.issue||(local&&(local.issueCode||local.issue))||'').trim()
    || chainIssueCode((card&&card.issue_url)||(local&&local.issueUrl)||'') || chainIssueCode(((local&&local.branch)||'')+' '+((local&&local.title)||''));
  const url=String(sp.issueUrl||(card&&card.issue_url)||(local&&local.issueUrl)||'').trim();
  const epicId=(card&&card.epic_id)||(local&&local.epic&&local.epic.epicId)||'';
  const pr=String((local&&local.prUrl)||(card&&card.pr_url)||'').trim();
  const num=(pr.match(/\/pull\/(\d+)/)||[])[1]||'';
  const who=card?(card.assignee||null):(k.me||null); // tarefa só local: é minha
  return {
    issue:(code||/^https?:\/\//i.test(url))?{ code, url:/^https?:\/\//i.test(url)?url:'' }:null,
    epic:epicId?{ id:epicId, name:(k.epicName&&k.epicName(epicId))||'épico' }:null,
    task:{ title:String((local&&local.title)||(card&&card.title)||''), localId:local?local.id:'', cloudId:card?card.id:'' },
    who, createdBy:(card&&card.created_by)||null,
    pr:pr?{ url:pr, num }:null,
    proofs:k.proofs?k.proofs(card||local):null,
  };
}
// o = { omit:['task',…], arrows:true, st:{ label, color }, who:'html do chip da pessoa' }
function chainHtml(c, o){
  o=o||{}; if(!c) return '';
  const E=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const om=new Set(o.omit||[]), parts=[];
  const chip=(kind, attrs, label, code, ext, tip)=>`<button type="button" class="chn chn-${kind}" data-chain="${kind}"${attrs} title="${E(tip)}"><i aria-hidden="true"></i>${label?E(label):''}${label&&code?' ':''}${code?`<b>${E(code)}</b>`:''}${ext?'<span class="chn-ext" aria-hidden="true">↗</span>':''}</button>`;
  if(c.issue && !om.has('issue')) parts.push(chip('issue', ` data-code="${E(c.issue.code)}" data-url="${E(c.issue.url)}"`, c.issue.code?'':'issue', c.issue.code, !!c.issue.url, 'issue '+(c.issue.code||'')+' — abrir no painel'));
  if(c.epic && !om.has('epic')) parts.push(chip('epic', ` data-id="${E(c.epic.id)}"`, c.epic.name, '', false, 'épico '+c.epic.name+' — abrir a página do épico'));
  if(c.task && c.task.title && !om.has('task')) parts.push(chip('task', ` data-local="${E(c.task.localId)}" data-cloud="${E(c.task.cloudId)}"`, c.task.title, '', false, 'abrir a tarefa'));
  if(o.who && !om.has('who')) parts.push(o.who);
  if(c.pr && !om.has('pr')) parts.push(chip('pr', ` data-url="${E(c.pr.url)}"`, 'PR', c.pr.num?'#'+c.pr.num:'', true, 'abrir o PR no GitHub'));
  if(c.proofs && !om.has('proof')) parts.push(chip('proof', ` data-local="${E(c.task&&c.task.localId)}" data-cloud="${E(c.task&&c.task.cloudId)}"`, c.proofs+(c.proofs===1?' prova':' provas'), '', false, 'ver as provas da entrega'));
  if(o.st && !om.has('st')) parts.push(`<span class="chn-st" style="--stc:${E(o.st.color||'var(--muted)')}">${E(o.st.label)}</span>`);
  return parts.join(o.arrows===false?'':'<span class="chn-ar" aria-hidden="true">→</span>');
}
// @puro-corrente-fim

// ---- contexto do app (tarefas desta máquina × cartões do time) ----
function chainCtx(){
  const m=(typeof tmap==='function'?tmap():{})||{};
  const cards=(typeof teamTasks!=='undefined'&&teamTasks)||[];
  const tasks=(typeof state!=='undefined'&&state.tasks)||[];
  return {
    card:lid=>{ const cid=m[lid]; return cid?(cards.find(c=>c.id===cid)||null):null; },
    local:cid=>{ const lid=Object.keys(m).find(k=>m[k]===cid); return lid?(tasks.find(t=>t.id===lid)||null):null; },
    epicName:id=>(typeof epNameOf==='function'&&epNameOf(id))||'épico',
    me:(typeof cloudUserId==='function'&&cloudUserId())||null,
  };
}
function chainOfNow(x, extra){ return chainOf(x, Object.assign(chainCtx(), extra||{})); }
// um clique só pra corrente inteira, em qualquer tela
document.addEventListener('click', e=>{
  const b=e.target&&e.target.closest&&e.target.closest('[data-chain]'); if(!b) return;
  e.preventDefault(); e.stopPropagation();
  const d=b.dataset, kind=d.chain;
  try{
    if(kind==='issue'){
      const inPanel=d.code && typeof trkIssues!=='undefined' && (trkIssues||[]).some(i=>i.code===d.code) && typeof trkSelect==='function';
      if(inPanel){ if(window.openTab) window.openTab('issues'); trkSelect(d.code); }
      else if(d.url) openExternal(d.url);
      else if(window.openTab){ window.openTab('issues'); if(typeof trkSelect==='function' && d.code) setTimeout(()=>{ try{ if((trkIssues||[]).some(i=>i.code===d.code)) trkSelect(d.code); }catch(_){ } }, 900); }
    } else if(kind==='epic'){ if(typeof epOpenById==='function') epOpenById(d.id); }
    else if(kind==='pr'){ if(d.url) openExternal(d.url); }
    else if(kind==='task' || kind==='proof'){
      const local=d.local && ((typeof state!=='undefined'&&state.tasks)||[]).some(t=>t.id===d.local);
      if(local) openWorkspace(d.local, kind==='proof'?'entrega':undefined);
      else if(d.cloud){ const ct=((typeof teamTasks!=='undefined'&&teamTasks)||[]).find(c=>c.id===d.cloud); if(ct && typeof openCloudTaskPage==='function') openCloudTaskPage(ct); }
    }
  }catch(err){ if(typeof showErr==='function') showErr(err, 'Não consegui abrir'); }
}, true);
window.chainOf=chainOf; window.chainHtml=chainHtml; window.chainOfNow=chainOfNow;
