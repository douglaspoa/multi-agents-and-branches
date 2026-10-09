// Starfork — 72-gestao-time: GESTÃO DO TIME, o que mais atrapalha (mesa 09/10, D6).
//   1. Quem PERDEU o cartão na reatribuição é avisado (veto da mesa: reatribuição silenciosa). Sem migration: a máquina
//      de quem perdeu guarda (localStorage, por pessoa) os cartões que estavam no nome dela no último teamFetch — isso
//      sobrevive a fechar e abrir o app. Quando um deles aparece com OUTRO responsável (ou livre) e a troca foi feita por
//      outra pessoa ('assigned'/'released' no task_activity), avisa UMA vez (notificação + toast; dedupe pelo id da atividade):
//      "Fulano passou ‘título’ pra Beltrano" / "Fulano tirou ‘título’ de você — ficou livre".
//   2. Motivo da trava: a regra mora no 70 (entMotivo/entTravaCtx/entTravaTx) — aqui só o CSS/telas chamam.
//   3. Ordem por modificação na Central (tarefas e épicos): caModOf/caEpModOf = o evento mais recente do item
//      (updated_at, atividade do cartão, fim/último evento da tarefa local); coluna clicada vale só com a tela aberta.

// @gestao-puro-inicio (testado em app/tests/gestao-time.test.mjs)
// foto "cartões no meu nome": { [cardId]: quando vi por último no meu nome (ms) }. Cartão que NÃO veio nesta busca (outro
// time/alcance, fora do limite) fica como estava — não dá pra saber; os que vieram valem como estão agora.
function gtMineSnap(prev, tasks, me, now){
  const out={}, loaded=new Set((tasks||[]).map(t=>t&&t.id));
  Object.keys(prev||{}).forEach(id=>{ if(!loaded.has(id)) out[id]=+prev[id]||0; });
  (tasks||[]).forEach(t=>{ if(t && me && t.assignee===me) out[t.id]=now||Date.now(); });
  const ids=Object.keys(out).sort((a,b)=>out[b]-out[a]).slice(0, 400); // teto: os 400 mais recentes
  const cap={}; ids.forEach(id=>{ cap[id]=out[id]; }); return cap;
}
// cartões que estavam no meu nome e, nesta busca, não estão mais
function gtLostCards(prev, tasks, me){ const p=prev||{}; return (tasks||[]).filter(t=>t && Object.prototype.hasOwnProperty.call(p, t.id) && t.assignee!==me); }
// a troca que tirou o cartão de mim: a 1ª mudança de dono feita por OUTRA pessoa depois do último evento que o deu pra mim
// (assigned pra mim / claimed por mim); sem esse evento na lista, as trocas desde a última vez que o vi no meu nome
// (folga de 10 min pro relógio do Mac × carimbo da nuvem). acts = atividades do cartão, qualquer ordem.
const GT_KINDS=['assigned','released','claimed'];
function gtLostAct(acts, taskId, me, since){
  const lim=(+since||0)-600000;
  const ms=a=>{ const n=Date.parse(a&&a.at||''); return n>0?n:0; };
  const xs=(acts||[]).filter(a=>a && a.task_id===taskId && GT_KINDS.includes(a.kind)).sort((a,b)=>ms(a)-ms(b) || (+a.id||0)-(+b.id||0));
  let ini=-1; xs.forEach((a,i)=>{ if((a.kind==='assigned' && a.body===me) || (a.kind==='claimed' && a.user_id===me)) ini=i; });
  const depois=ini>=0 ? xs.slice(ini+1) : xs.filter(a=>ms(a)>=lim);
  for(const a of depois){
    if(!a.user_id) continue;           // sem autor (sistema): não inventa nome
    if(a.user_id===me) return null;    // eu mesmo passei/devolvi — nada a avisar
    return a;
  }
  return null;
}
// perdido SEM a troca achada: desiste quando eu mesmo mexi nele depois (devolvi/passei) ou a foto tem mais de 1 dia
function gtLostAcaba(acts, taskId, me, since, now){
  if((now||Date.now())-(+since||0)>86400000) return true;
  return (acts||[]).some(a=>a && a.task_id===taskId && a.user_id===me && GT_KINDS.includes(a.kind) && Date.parse(a.at||'')>=(+since||0)-600000);
}
// o aviso pra quem perdeu o cartão (ou null). nameOf(uid) → nome (fonte única 08-pessoas)
function gtLostNotif(a, t, me, nameOf){
  if(!a || !me || !a.user_id || a.user_id===me) return null;
  nameOf=nameOf||(u=>u);
  const tit='‘'+String((t&&t.title)||'um cartão do time').slice(0,70)+'’', who=nameOf(a.user_id);
  if(a.kind==='assigned' && a.body && a.body===a.user_id) return { title:'Tarefa passada pra outra pessoa', body:who+' ficou com '+tit+' (era sua)' }; // líder pegou pra si
  if(a.kind==='assigned' && a.body && a.body!==me) return { title:'Tarefa passada pra outra pessoa', body:who+' passou '+tit+' pra '+nameOf(a.body) };
  if(a.kind==='claimed') return { title:'Tarefa passada pra outra pessoa', body:who+' assumiu '+tit+' (era sua)' }; // nuvem sem a 0032: assumir tomava o cartão
  if(a.kind==='released') return { title:'Tarefa tirada de você', body:who+' tirou '+tit+' de você — ficou livre' };
  return null;
}
// @gestao-puro-fim

// ---- 1. aviso pra quem perdeu o cartão (chamado pelo teamNotifTick do 43, depois do teamFetch) ----
function gtSnapKey(me){ return userKey('sb:minecards', me); }
function gtSnapGet(me){ try{ const v=JSON.parse(lsGet(gtSnapKey(me))||'null'); return (v && typeof v==='object' && !Array.isArray(v))?v:null; }catch(_){ return null; } }
// devolve o conjunto de ids de atividade já avisados nesta volta (o 43 não repete o "Sua demanda mudou de mãos")
let gtLostBusy=false;
async function gtLostTick(me, tasks){
  const told=new Set();
  if(!me || !Array.isArray(tasks) || gtLostBusy) return told; // duas voltas ao mesmo tempo repetiriam o aviso
  gtLostBusy=true;
  try{ return await gtLostRun(me, tasks, told); } finally{ gtLostBusy=false; }
}
async function gtLostRun(me, tasks, told){
  const prev=gtSnapGet(me);
  if(!prev){ lsSet(gtSnapKey(me), JSON.stringify(gtMineSnap({}, tasks, me))); return told; } // 1ª vez nesta máquina: só semeia
  const lost=gtLostCards(prev, tasks, me), keep={};
  if(lost.length){
    let acts;
    try{ acts=await sbGet('task_activity?select=id,task_id,user_id,kind,body,at&task_id=in.('+lost.map(t=>'"'+t.id+'"').join(',')+')&kind=in.(assigned,released,claimed)&order=id.desc&limit=200'); }
    catch(e){ if(typeof tickErr==='function') tickErr('gtLostTick', e); told.fail=new Set(lost.map(t=>t.id)); return told; } // sem a atividade: tenta na próxima volta (foto intacta; o 43 não avisa essas trocas por outro caminho)
    const avisos=[];
    for(const t of lost){
      const a=gtLostAct(acts, t.id, me, prev[t.id]);
      if(!a){ if(gtLostAcaba(acts, t.id, me, prev[t.id], Date.now())) continue; keep[t.id]=prev[t.id]; continue; } // a atividade ainda não chegou: confere de novo na próxima volta (até 1 dia)
      const key=String(a.id||(a.task_id+':'+a.at)); told.add(key); if(seenSet('sb:seenlost').has(key)) continue;
      seenAdd('sb:seenlost', key); avisos.push({ a, t });
    }
    if(avisos.length){
      try{ await personEnsure([...new Set(avisos.flatMap(({ a })=>[a.user_id, a.kind==='assigned'?a.body:'']).filter(Boolean))]); }catch(_){ }
      const ks=avisos.map(({ a, t })=>gtLostNotif(a, t, me, u=>personCap(tmName(u)))).filter(Boolean);
      if(ks.length>2){ // reorganização em lote: UM aviso, não uma pilha
        const quem=[...new Set(avisos.map(({ a })=>personCap(tmName(a.user_id))))].join(', ');
        const tx=quem+' tirou '+ks.length+' tarefas do seu nome: '+avisos.slice(0,3).map(({ t })=>'‘'+String(t.title||'').slice(0,40)+'’').join(', ')+(ks.length>3?'…':'');
        pushNotif('Tarefas passadas pra outras pessoas', tx, 'view:team'); toast(tx, 'warn');
      } else ks.forEach(k=>{ pushNotif(k.title, k.body, 'view:team'); toast(k.body, 'warn'); });
    }
  }
  lsSet(gtSnapKey(me), JSON.stringify(Object.assign(gtMineSnap(prev, tasks, me), keep)));
  return told;
}
window.gtLostTick=gtLostTick;

// ---- 3. modificação do item (Central) ----
let gtActIdx={ src:null, m:{} };
function gtActAt(taskId){
  const src=(typeof teamActivity!=='undefined'&&teamActivity)||[];
  if(gtActIdx.src!==src){ const m={}; src.forEach(a=>{ if(a && a.task_id && (!m[a.task_id] || String(a.at)>String(m[a.task_id]))) m[a.task_id]=a.at; }); gtActIdx={ src, m }; }
  return gtActIdx.m[taskId]||0;
}
// cartão: o mais recente entre updated_at, a última atividade dele e (tarefa desta máquina) o fim / o último evento local.
// Memo por id enquanto os dados não mudam (o sort chama isto em cada comparação — render sem trabalho repetido)
let gtModMemo={ k:null, m:new Map() };
function caModOf(t){
  if(!t) return 0;
  const ev=(typeof state!=='undefined'&&state&&state.events)||null;
  const k=[(typeof teamTasks!=='undefined'&&teamTasks)||null, (typeof teamActivity!=='undefined'&&teamActivity)||null, (typeof state!=='undefined'&&state&&state.tasks)||null, ev, ev?ev.length:0];
  if(!gtModMemo.k || gtModMemo.k.some((x,i)=>x!==k[i])) gtModMemo={ k, m:new Map() };
  let v=gtModMemo.m.get(t.id); if(v===undefined){ v=caModCalc(t); gtModMemo.m.set(t.id, v); }
  return v;
}
function caModCalc(t){
  const l=(typeof caLocalOf==='function')?caLocalOf(t):null;
  const ev=(l && typeof lastEventOf==='function')?lastEventOf(l.id):null;
  return modTs(t.updated_at, t.created_at, gtActAt(t.id), l&&l.finishedAt, ev&&ev.ts);
}
// épico: o próprio carimbo ou o da tarefa dele mexida por último
function caEpModOf(e, tasks){ return modTs(e&&e.updated_at, e&&e.created_at, (tasks||[]).map(caModOf)); }
// ao VOLTAR pra Central (de outra aba), a coluna clicada esquece — abre de novo pela modificação (15: activateTab chama)
function sortOnScreenOpen(tab){
  if(!tab || tab.kind!=='flow') return;
  const tinha=['central:tarefas','central:epicos'].some(k=>{ const s=sortGet(k); return s.col!=='mod'||s.dir!=='desc'; })
    || (typeof CT!=='undefined' && CT && (CT.sort.key!=='upd' || CT.sort.dir!=='desc'));
  ['central:tarefas','central:epicos'].forEach(sortReset);
  if(typeof CT!=='undefined' && CT) CT.sort={ key:'upd', dir:'desc' };
  // a Central não se repinta sozinha ao voltar (o quadro "já aparece"): com coluna clicada, repinta já na ordem por modificação
  if(tinha){ try{ lastSig=''; if(typeof flowLastHtml!=='undefined') flowLastHtml=null; if(typeof renderFlow==='function') renderFlow(); }catch(_){ } }
}
window.sortOnScreenOpen=sortOnScreenOpen; window.caModOf=caModOf; window.caEpModOf=caEpModOf;
