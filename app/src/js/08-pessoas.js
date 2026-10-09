// Starfork — 08-pessoas: NOME DE PESSOA, fonte única (mesa 09/10 "como tudo se liga", D1).
// Antes cada tela resolvia gente do seu jeito: tmName devolvia o e-mail CRU ou "alguém do time" enquanto o perfil não
// chegava; Ajustes e o planner cortavam o id (String(uid).slice(0,8)); o painel de Issues mostrava "id 1a2b"; as
// preferências diziam "alguém". Agora TODA tela que mostra gente passa por aqui:
//   personName(ref)   → "você" (eu) · nome do perfil · parte do e-mail antes do @ · "pessoa sem nome" — NUNCA o id
//   personShort(ref)  → o primeiro nome (listas apertadas); o fallback fica inteiro ("pessoa sem nome")
//   personAv(ref,o)   → avatar (iniciais + cor estável por pessoa; o .tsav de sempre) — e-mail completo só no tooltip
//   personChip(ref,o) → avatar + nome, o chip "com Fulano" igual em todo lugar
// ref = id do usuário (uuid), e-mail, ou { user_id, name, email }. Perfil que falta é buscado em LOTE (uma query
// `in (...)`, a RLS profiles_coworkers da 0001 já deixa ler quem divide org comigo) e a tela redesenha quando chega;
// enquanto isso aparece "carregando…" (nunca um texto inventado). O lote falhou (rede) → tenta de novo depois de 60 s.

// @puro-pessoas-inicio (testado em app/tests/pessoas.test.mjs)
const PESSOA_SEM_NOME='pessoa sem nome', PESSOA_CARREGANDO='carregando…';
// cara de id: uuid, hash longo, ou o "id 1a2b" que o painel antigo inventava — nada disso vira rótulo
function personLooksId(s){
  s=String(s==null?'':s).trim();
  // hash longo = 16+ hex COM letra e dígito (um telefone "5511999998888@…" é gente, não id)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || (/^[0-9a-f]{16,}$/i.test(s) && /[a-f]/i.test(s) && /\d/.test(s)) || /^id [0-9a-f]{3,}$/i.test(s);
}
const PERSON_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // só id INTEIRO vai pro lote
function personEmailLocal(e){ e=String(e==null?'':e).trim(); const i=e.indexOf('@'); const l=i>0?e.slice(0,i):''; return personLooksId(l)?'':l; }
// p = perfil {name,email} (ou null) · o = { me, pending, email, hint, noYou }
//   me: é a pessoa logada → "você" (salvo noYou) · email: o que se sabe além do perfil · hint: nome gravado em outro lugar
//   (ex.: shared_by_name) · pending: o lote ainda vai buscar → "carregando…"
function personLabel(p, o){
  o=o||{};
  if(o.me && !o.noYou) return 'você';
  const nm=String((p&&p.name)||'').trim(); if(nm && !personLooksId(nm) && !nm.includes('@')) return nm;
  const ln=personEmailLocal((p&&p.email)||o.email||(nm.includes('@')?nm:'')); if(ln) return ln;
  const h=String(o.hint||'').trim(); if(h && !personLooksId(h)) return h.includes('@')?(personEmailLocal(h)||PESSOA_SEM_NOME):h;
  return o.pending?PESSOA_CARREGANDO:PESSOA_SEM_NOME;
}
// primeiro nome; fallback ("pessoa sem nome", "carregando…") e "você" ficam inteiros
function personFirst(label){ const l=String(label||''); if(l===PESSOA_SEM_NOME||l===PESSOA_CARREGANDO||l==='você') return l; return l.split(/\s+/)[0]||l; }
// iniciais do NOME (o meu avatar mostra as minhas iniciais, mesmo com o rótulo "você")
function personInitials(name){
  const n=String(name||''); if(!n || n===PESSOA_SEM_NOME) return '?'; if(n===PESSOA_CARREGANDO) return '·';
  const w=n.replace(/@.*/,'').split(/[\s._-]+/).filter(Boolean);
  return ((w.length>1?w[0][0]+w[1][0]:(w[0]||'?').slice(0,2))).toUpperCase();
}
// cor estável pela CHAVE da pessoa (id/e-mail) — não muda quando o nome chega
function personHue(key, pal){ let h=0; const s=String(key||''); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return pal&&pal.length?pal[h%pal.length]:'hsl('+(h%360)+' 45% 42%)'; }
// texto que vale pra tela: nada de uuid, "alguém do time" ou "id 1a2b" (os testes de render usam isto)
function personBadText(s){ return /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(String(s||'')) || /alguém do time|\bid [0-9a-f]{4}\b/i.test(String(s||'')); }
// @puro-pessoas-fim

// ---------- perfis: o que a nuvem já trouxe (cloudData/teamProfiles) + o lote sob demanda ----------
const pplCache={};               // user_id → perfil buscado aqui
const pplTried={};               // user_id → quando o lote buscou (achou ou não)
const pplPending=new Set(), pplFlyingIds=new Set(); let pplTimer=null, pplEpoch=0, pplVer=0, pplMemo=null;
const PPL_RETRY_FAIL=60000, PPL_RETRY_MISS=10*60000; // rede caiu: 1 min · a nuvem não tem o perfil: 10 min
// troca de conta (40-conta-escopo): nada do lote antigo entra no cache novo
function personReset(){ if(pplTimer){ clearTimeout(pplTimer); pplTimer=null; } pplEpoch++; pplVer++; pplMemo=null;
  [pplCache, pplTried].forEach(o=>{ for(const k in o) delete o[k]; }); pplPending.clear(); pplFlyingIds.clear(); }
// mapa fundido, memorizado: só refaz quando a nuvem troca o objeto de perfis ou o lote traz algo (lista com 40 linhas
// chamava isto ~3× por linha a cada render)
function personProfiles(){
  const a=(typeof cloudData!=='undefined'&&cloudData&&cloudData.profileByUser)||null;
  const b=(typeof teamProfiles!=='undefined'&&teamProfiles)||null;
  if(pplMemo && pplMemo.a===a && pplMemo.b===b && pplMemo.v===pplVer && pplMemo.na===(a?Object.keys(a).length:0) && pplMemo.nb===(b?Object.keys(b).length:0)) return pplMemo.o;
  const o={}, byMail={};
  [a||{}, pplCache, b||{}].forEach(src=>Object.keys(src).forEach(k=>{ if(src[k]) o[k]=Object.assign({}, o[k]||{}, src[k]); }));
  Object.keys(o).forEach(k=>{ const m=String(o[k].email||'').toLowerCase(); if(m && !byMail[m]) byMail[m]=k; });
  pplMemo={ a, b, v:pplVer, na:a?Object.keys(a).length:0, nb:b?Object.keys(b).length:0, o, byMail };
  return o;
}
function personMeId(){ try{ return typeof cloudUserId==='function'?cloudUserId():''; }catch(_){ return ''; } }
function personMeEmail(){ try{ const s=typeof SB!=='undefined'&&SB.sess(); return String((s&&s.user&&s.user.email)||'').toLowerCase(); }catch(_){ return ''; } }
function personByEmail(email){
  const m=String(email||'').trim().toLowerCase(); if(!m) return null;
  const all=personProfiles(), k=pplMemo&&pplMemo.byMail[m];
  return k?Object.assign({ user_id:k }, all[k]):null;
}
// resolve a referência: { uid, prof, email, me, pending }
function personResolve(ref){
  if(ref && typeof ref==='object'){
    const base=personResolve(ref.user_id||ref.email||''), prof=Object.assign({}, base.prof||{});
    if(ref.name) prof.name=ref.name; if(ref.email) prof.email=ref.email;
    return Object.assign(base, { prof:Object.keys(prof).length?prof:null, pending:base.pending && !ref.name && !ref.email });
  }
  const s=String(ref==null?'':ref).trim(); if(!s) return { uid:'', prof:null, email:'', me:false, pending:false };
  if(s.includes('@')){ const p=personByEmail(s); return { uid:p?p.user_id:'', prof:p, email:s, me:s.toLowerCase()===personMeEmail() || (!!p && p.user_id===personMeId()), pending:false }; }
  const prof=personProfiles()[s]||null, me=s===personMeId();
  let pending=false;
  if(!prof && !me && PERSON_UUID.test(s)) pending=personQueue(s);
  return { uid:s, prof, email:'', me, pending };
}
// pede o perfil que falta no próximo lote; devolve se ainda vale "carregando…"
function personQueue(uid){
  if(pplFlyingIds.has(uid) || pplPending.has(uid)) return true;
  if(!(typeof SB!=='undefined' && SB.sess && SB.sess())) return false;
  const t=pplTried[uid]; if(t && Date.now()-t.at<(t.miss?PPL_RETRY_MISS:PPL_RETRY_FAIL)) return false; // já tentou: "pessoa sem nome" até a próxima janela
  pplPending.add(uid); if(!pplTimer) pplTimer=setTimeout(personFetchMissing, 200);
  return true;
}
function personFetchMissing(){
  pplTimer=null; const ids=[...pplPending].filter(u=>!personProfiles()[u] && !pplFlyingIds.has(u)); pplPending.clear();
  if(!ids.length || !(typeof SB!=='undefined' && SB.sess())) return Promise.resolve();
  const ep=pplEpoch; ids.forEach(u=>pplFlyingIds.add(u));
  return sbGet('profiles?select=user_id,name,email,last_seen_at&user_id=in.('+ids.map(u=>encodeURIComponent('"'+u+'"')).join(',')+')').then(rows=>{
    if(ep!==pplEpoch) return; // a conta trocou no meio do caminho
    const got=new Set(); (rows||[]).forEach(p=>{ if(p&&p.user_id){ pplCache[p.user_id]=p; got.add(p.user_id); } });
    ids.forEach(u=>{ pplTried[u]={ at:Date.now(), miss:!got.has(u) }; });
    pplVer++; personRepaint(); // chegou nome OU saiu do "carregando…" (vira "pessoa sem nome")
  }).catch(e=>{ if(ep!==pplEpoch) return; ids.forEach(u=>{ pplTried[u]={ at:Date.now(), miss:false }; }); if(typeof tickErr==='function') tickErr('personFetchMissing', e); pplVer++; personRepaint(); })
    .finally(()=>{ if(ep===pplEpoch) ids.forEach(u=>pplFlyingIds.delete(u)); });
}
// pra texto que vai GRAVADO ou numa caixa de uma vez só (toast, pergunta, mensagem salva): espera o lote antes
async function personEnsure(ids){
  const want=(Array.isArray(ids)?ids:[ids]).map(x=>String(x||'')).filter(u=>PERSON_UUID.test(u) && !personProfiles()[u]);
  if(!want.length) return;
  want.forEach(u=>personQueue(u));
  if(pplTimer){ clearTimeout(pplTimer); pplTimer=null; }
  try{ await personFetchMissing(); }catch(_){ }
}
// a tela que pediu o nome redesenha quando o lote volta (mesmo caminho do antigo tmFetchMissing) + quem desenha uma vez
// só escuta 'sf:pessoas'
function personRepaint(){
  try{ if(typeof lastSig!=='undefined') lastSig=''; if(typeof teamPaintSig!=='undefined') teamPaintSig='';
    if(typeof renderFlow==='function') renderFlow(); if(typeof render==='function') render();
    window.dispatchEvent(new CustomEvent('sf:pessoas')); }catch(_){ }
}
// o = { noYou, hint, you:'suffix' → "Ana Souza (você)" pra listas de escolha, settled → nunca "carregando…" (texto gravado) }
function personName(ref, o){
  o=o||{}; const r=personResolve(ref);
  if(!r.uid && !r.email && !(ref&&typeof ref==='object')) return o.hint?personLabel(null,{ hint:o.hint }):'—';
  if(o.you==='suffix' && r.me) return personLabel(r.prof, { email:r.email||personMeEmail(), noYou:true, hint:o.hint })+' (você)';
  return personLabel(r.prof, { me:r.me, noYou:o.noYou, email:r.email||(r.me?personMeEmail():''), hint:o.hint, pending:r.pending && !o.settled });
}
// começo de frase ("Você atribuiu…" no feed)
function personCap(s){ s=String(s||''); return s==='você'?'Você':s; }
function personShort(ref, o){ return personFirst(personName(ref, o)); }
// e-mail completo SÓ no tooltip (mesa D1)
function personTip(ref){ const r=personResolve(ref); const nm=personName(ref,{ noYou:true }); const em=String((r.prof&&r.prof.email)||r.email||'');
  return (r.me?nm+' (você)':nm)+(em&&!nm.includes('@')?' · '+em:''); }
function personAv(ref, o){
  o=o||{}; const r=personResolve(ref), real=personName(ref,{ noYou:true });
  const key=r.uid||String(r.email||'').toLowerCase()||real;
  const pal=(typeof FLOW_PAL!=='undefined'&&FLOW_PAL)||null;
  const bg=(real===PESSOA_SEM_NOME||real===PESSOA_CARREGANDO)?'var(--muted)':personHue(key, pal);
  // sozinho (sem o nome do lado) o avatar É a informação: leitor de tela ouve o nome; dentro do chip é enfeite
  return `<span class="tsav pav${o.on?' on':''}${o.cls?' '+o.cls:''}" style="background:${bg}" title="${escA(personTip(ref))}"${o.decor?' aria-hidden="true"':` role="img" aria-label="${escA(personName(ref))}"`}>${esc(personInitials(real))}</span>`;
}
function personChip(ref, o){
  o=o||{}; const nm=o.short?personShort(ref, o):personName(ref, o);
  return `<span class="pchip${nm===PESSOA_CARREGANDO?' loading':''}" title="${escA(personTip(ref))}">${personAv(ref, { on:o.on, decor:true })}<span class="pnm">${esc(nm)}</span></span>`;
}
// texto da atividade do cartão: 'assigned' guarda o ID de quem recebeu no body → "pra Fulano" (antes: o uuid cru)
function personActBody(a, max){
  if(!a || !a.body) return '';
  if(a.kind==='assigned') return 'pra '+personName(a.body); // só o 'assigned' guarda um id; comentário com SHA continua texto
  return String(a.body).slice(0, max||120);
}
window.personActBody=personActBody; window.personEnsure=personEnsure; window.personReset=personReset;
window.personCap=personCap; window.personName=personName; window.personShort=personShort; window.personChip=personChip; window.personAv=personAv; window.personTip=personTip;
