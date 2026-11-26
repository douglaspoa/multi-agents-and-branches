// ── COMANDO PELO CELULAR: o que a pessoa FALA no iPhone chega aqui pela nuvem (tabela comando_msgs), o agente do
// Comando atende neste Mac — com o projeto que estiver aberto — e a resposta volta em texto curto pro celular ler em
// voz alta. É a MESMA conversa do Comando: aparece no chat daqui, usa as mesmas ferramentas e a mesma confirmação
// (o "sim"/"não" falado no celular vale como o clique no cartão). Sem a tabela (migration 0034) fica quieto.

// @celular-puro-inicio
const CMD_CEL_JANELA_MS=3*60000;   // fala mais velha que isso não é atendida (o celular já desistiu de esperar)
const CMD_CEL_TETO_MS=4*60000;     // quanto o agente pode levar antes de eu responder "ainda estou fazendo"
/** Texto que o celular vai LER EM VOZ ALTA: sem markdown, sem código, sem link, curto. Puro. */
function cmdCelFala(tx, max){
  let s=String(tx||'');
  s=s.replace(/```[\s\S]*?```/g,' ').replace(/`([^`]*)`/g,'$1').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,' ').replace(/^\s{0,3}#{1,6}\s*/gm,'').replace(/^\s*[-*•]\s+/gm,'').replace(/^\s*\|?[-: |]{3,}\|?\s*$/gm,' ').replace(/\|/g,', ')
    .replace(/[*_~>]+/g,'').replace(/\s*\n+\s*/g,'. ').replace(/\s+/g,' ').replace(/(\. ?){2,}/g,'. ').replace(/([:;,])\. /g,'$1 ').trim();
  const lim=max||600; if(s.length>lim){ const c=s.slice(0,lim), p=Math.max(c.lastIndexOf('. '), c.lastIndexOf('? '), c.lastIndexOf('! ')); s=(p>lim*0.5?c.slice(0,p+1):c.replace(/\s+\S*$/,'')+'…')+' O resto está no Starfork do Mac.'; }
  return s;
}
/** Das mensagens novas do chat (depois da fala da pessoa) → { body, confirma }. `tx(m)` = texto de uma mensagem. Puro. */
function cmdCelResposta(novas, tx, espera, rotulos){
  const partes=[]; let confirma=false;
  for(const m of (novas||[])){ if(!m || m.r!=='bot') continue;
    if(m.k==='plano' && !m.done){ if(m===espera || !espera){ confirma=true; const p=((m.plan||{}).passos||[])[0]||{}, al=(p.alvos||[]).map(x=>x.code||x.ref).filter(Boolean).join(', ');
        partes.push('Preciso da sua confirmação: '+String((rotulos&&rotulos[p.acao])||p.acao||'essa ação').toLowerCase()+(al?' '+al:p.titulo?': '+p.titulo:'')+'. Diga sim ou não.'); } continue; }
    if(m.k==='agente'){ if(m.text) partes.push(m.text); continue; }
    const t=tx?tx(m):''; if(t) partes.push(String(t).replace(/^Comando( propôs)?: /,'')); }
  const body=cmdCelFala(partes.join('\n'), confirma?400:600);
  return { body: body||(confirma?'Preciso da sua confirmação. Diga sim ou não.':'Feito.'), confirma };
}
/** Há uma fala nova pra atender? Devolve a 1ª que ainda está dentro da janela. Puro. */
function cmdCelEscolhe(rows, agora){ for(const r of (rows||[])){ const t=Date.parse(r.created_at||''); if(r && r.id && r.body && isFinite(t) && agora-t<=CMD_CEL_JANELA_MS) return r; } return null; }
// @celular-puro-fim

const CMDCEL={ rodando:false, semTabela:0, atendidas:0 };
function cmdCelLog(tx){ try{ console.log('[celular] '+tx); }catch(_){ } }
async function cmdCelPatch(id, de, body){ return sbFetch('/rest/v1/comando_msgs?id=eq.'+id+(de?'&state=eq.'+de:''), { method:'PATCH', headers:{ Prefer:'return=representation' }, body: JSON.stringify(body) }); }
async function cmdCelResponde(id, body, meta){ await sbFetch('/rest/v1/comando_msgs', { method:'POST', body: JSON.stringify({ role:'bot', body:String(body).slice(0,3900), reply_to:id, state:'pronto', meta:meta||{} }) }); }
/** Uma volta: pega UMA fala nova da pessoa, entrega ao Comando e devolve a resposta. */
async function cmdCelTick(){
  if(CMDCEL.rodando || typeof SB==='undefined' || !SB.sess() || (typeof cloudAllowed==='function' && !cloudAllowed())) return;
  if(CMDCEL.semTabela && Date.now()-CMDCEL.semTabela<10*60000) return; // sem a migration: tenta de novo só de 10 em 10 min
  if(typeof cmdSay!=='function' || !cmdRepo()) return;
  // enquanto um cartão espera o "sim", o Comando está "ocupado" de propósito — a próxima fala é a resposta dele
  if(CMD.busy && !(CMDAG && CMDAG.espera)) return;
  CMDCEL.rodando=true;
  try{
    const desde=new Date(Date.now()-CMD_CEL_JANELA_MS).toISOString();
    let rows; try{ rows=await sbGet('comando_msgs?select=id,body,created_at&role=eq.user&state=eq.novo&user_id=eq.'+cloudUserId()+'&created_at=gt.'+encodeURIComponent(desde)+'&order=id&limit=3'); }
    catch(e){ const m=String((e&&e.message)||e); if(/comando_msgs|does not exist|404|PGRST205|schema cache/i.test(m)){ if(!CMDCEL.semTabela) cmdCelLog('a tabela comando_msgs ainda não existe na nuvem (migration 0034)'); CMDCEL.semTabela=Date.now(); } return; }
    CMDCEL.semTabela=0;
    const r=cmdCelEscolhe(rows, Date.now()); if(!r) return;
    // só UM Mac atende: quem conseguir trocar 'novo' → 'atendendo' fica com a fala
    const meu=await cmdCelPatch(r.id, 'novo', { state:'atendendo' }).catch(()=>null); if(!Array.isArray(meu) || !meu.length) return;
    const texto=String(r.body).trim().slice(0,2000); cmdCelLog('fala #'+r.id+' · '+texto.length+' letras');
    const ms=cmdMsgs(), n0=ms.length, t0=Date.now();
    try{
      const pend=CMDAG && CMDAG.espera && !CMDAG.espera.done ? CMDAG.espera : null;
      const decidiu=pend && typeof cmdAgDecide==='function' && cmdAgDecide(texto);
      if(!decidiu){ if(pend){ await cmdCelResponde(r.id, 'Ainda estou esperando a sua confirmação. Diga sim ou não.', { confirma:true }); await cmdCelPatch(r.id, '', { state:'pronto' }); return; }
        cmdSay(texto); }
      // espera o Comando terminar — ou parar num cartão de confirmação NOVO
      await new Promise(ok=>{ const iv=setInterval(()=>{ const esp=CMDAG && CMDAG.espera && !CMDAG.espera.done ? CMDAG.espera : null;
        if((!CMD.busy && ms.length>n0) || (esp && esp!==pend) || Date.now()-t0>CMD_CEL_TETO_MS){ clearInterval(iv); ok(); } }, 300); });
      await new Promise(ok=>setTimeout(ok, 250)); // deixa o último texto assentar
      const esp=CMDAG && CMDAG.espera && !CMDAG.espera.done ? CMDAG.espera : null;
      const lento=CMD.busy && !esp;
      const novas=ms.slice(decidiu?Math.max(0, ms.indexOf(pend)+1):n0);
      const R=lento?{ body:'Ainda estou fazendo isso no Mac. Pergunte de novo daqui a pouco que eu conto como ficou.', confirma:false }:cmdCelResposta(novas, typeof cmdAgMsgTx==='function'?cmdAgMsgTx:null, esp, typeof CMD_ACAO_TX!=='undefined'?CMD_ACAO_TX:null);
      await cmdCelResponde(r.id, R.body, { confirma:R.confirma, ms:Date.now()-t0, projeto:pathBase(cmdRepo()) });
      await cmdCelPatch(r.id, '', { state:'pronto' }); CMDCEL.atendidas++;
      cmdCelLog('respondi #'+r.id+' em '+Math.round((Date.now()-t0)/1000)+'s'+(R.confirma?' · pedindo confirmação':'')+(lento?' · ainda trabalhando':''));
    }catch(e){ cmdCelLog('falhou #'+r.id+': '+String((e&&e.message)||e).slice(0,120));
      try{ await cmdCelResponde(r.id, 'Não consegui atender agora no Mac. Tente de novo.', { erro:true }); await cmdCelPatch(r.id, '', { state:'erro' }); }catch(_){ } }
  } finally { CMDCEL.rodando=false; }
}
setInterval(()=>{ cmdCelTick().catch(e=>tickErr('cmdCelTick', e)); }, 2500);
