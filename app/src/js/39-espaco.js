// Starfork — 39-espaco: ESPAÇO LOCAL (Grátis) × ESPAÇO NA NUVEM (Pro/Empresa) — plano Grátis, onda F1.
// Decisão do dono (party-preco, seções 9–13): o Grátis é 100% local — abre sem login e sem rede, cria demanda, roda agente,
// anexa prova, passa no portão e exporta. A nuvem (quadro do time, sync, celular, push, provas na nuvem, links, memória
// sincronizada, convites) é do Pro/Empresa. Nenhum caminho LOCAL consulta plano: só as superfícies de nuvem perguntam
// cloudAllowed()/isLocalSpace().
// cloudAllowed = servidor configurado + sessão + billingActive(). billingActive() é true com a cobrança DESLIGADA, então
// hoje todo logado continua com nuvem (o time Enterprise não muda nada).
// @puro-espaco-inicio — regras PURAS (testadas em app/tests/plano-gratis.test.mjs)
function espacoNuvem(configured, hasSess, billingOk){ return !!configured && !!hasSess && !!billingOk; }
// localStorage do Grátis (`base:-`) → da conta (`base:<uid>`) no 1º login: só copia quando o destino está VAZIO (nunca
// sobrescreve o que a conta já tinha) e só o que é preferência local — cursores e mapas da nuvem (sb:*, ep:mirrored,
// ep:ownWarn) são da conta e não existem sem ela.
const ESPACO_MIG_NAO=/^(sb:|ep:mirrored|ep:ownWarn)/;
function espacoMigPlan(keys, uid, has){
  const out=[]; if(!uid || uid==='-') return out;
  for(const k of (keys||[])){
    if(typeof k!=='string' || !k.endsWith(':-')) continue;
    const base=k.slice(0,-2); if(!base || ESPACO_MIG_NAO.test(base)) continue;
    const to=base+':'+uid; if(has(to)) continue;
    out.push([k, to]);
  }
  return out;
}
// canal de atualização: com sessão, o bucket privado do Supabase (URL assinada, como sempre); sem sessão, o canal
// PÚBLICO — os downloads da landing no GitHub Releases (mesmo latest.json: buildMs, version, file, size, notes, publishedAt).
const UPD_PUB_BASE='https://github.com/douglaspoa/multi-agents-and-branches/releases/latest/download/';
const UPD_PUB_ZIP='Starfork-portable.zip';
function updCanal(hasSess){ return hasSess ? { tipo:'conta' } : { tipo:'publico', manifest:UPD_PUB_BASE+'latest.json', zip:UPD_PUB_BASE+UPD_PUB_ZIP }; }
// latest.json do canal público: só serve com buildMs numérico (404 / HTML de erro / JSON torto = em silêncio, null)
function updPubParse(txt){
  if(!txt || typeof txt!=='string') return null;
  let j=null; try{ j=JSON.parse(txt); }catch(_){ return null; }
  return (j && typeof j==='object' && Number(j.buildMs)>0) ? j : null;
}
// @puro-espaco-fim

function cloudAllowed(){
  try{
    if(typeof SB==='undefined') return false;
    return espacoNuvem(SB.configured(), !!SB.sess(), typeof billingActive==='function' ? billingActive() : true);
  }catch(_){ return false; }
}
function isLocalSpace(){ return !cloudAllowed(); }
// avisa quem desenha superfície de nuvem quando o espaço muda (login, sair, sessão caiu, billingSync)
let espacoLast=null;
function espacoSync(){
  const now=cloudAllowed()?'nuvem':'local';
  if(now===espacoLast) return;
  const was=espacoLast; espacoLast=now;
  if(was===null) return; // 1ª leitura do boot: nada mudou ainda
  try{ window.dispatchEvent(new CustomEvent('sf:espaco-mudou', { detail:{ espaco:now, antes:was } })); }catch(_){ }
}
// 1º login neste computador: o que a pessoa fez no Grátis não some (idempotente: marca por conta + só copia pra vazio)
function espacoMigrar(uid){
  if(!uid) return 0;
  const flag='sf:migLocal:'+uid;
  try{ if(localStorage.getItem(flag)==='1') return 0; }catch(_){ return 0; }
  let n=0;
  try{
    const keys=Object.keys(localStorage);
    for(const [from,to] of espacoMigPlan(keys, uid, k=>localStorage.getItem(k)!==null)){ localStorage.setItem(to, localStorage.getItem(from)); n++; }
    localStorage.setItem(flag,'1');
  }catch(_){ }
  return n;
}
window.cloudAllowed=cloudAllowed; window.isLocalSpace=isLocalSpace; window.espacoSync=espacoSync;
