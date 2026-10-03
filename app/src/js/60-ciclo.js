// Starfork — 60-ciclo
// O CICLO DA TAREFA (decisão da mesa de 03/10/2026): teto sempre ligado (P6) e a decisão "precisa de você" como
// SEÇÃO da aba da tarefa (nunca modal). Espelho das funções puras de src/lifecycle.ts — a paridade é conferida pelos
// fixtures de tests/fixtures/ciclo-golden/ (app/tests/ciclo.test.mjs e src/ciclo-*.test.ts).

// @ciclo-puro-inicio
const CAP_PAUSE_AT=0.8, CAP_DEFAULT_USD=5, RELEASE_MIN_WORDS=3;
function effectiveCap(taskCap, settingsCap){ const ok=v=>{ const n=Number(v); return Number.isFinite(n)&&n>0?n:0; }; return ok(taskCap)||ok(settingsCap)||CAP_DEFAULT_USD; }
function capCheck(spentUsd, capUsd){ const cap=effectiveCap(capUsd); return (Number(spentUsd)||0) >= cap*CAP_PAUSE_AT-1e-9 ? 'pausa' : 'ok'; }
function releaseCheck(usd, reason){
  const n=typeof usd==='number'?usd:Number(String(usd==null?'':usd).trim().replace(/^US\$\s*/i,'').replace(',','.'));
  if(!Number.isFinite(n) || n<=0) return { ok:false, why:'escreva quanto liberar, em dólares (ex.: 2 ou 1,50)' };
  if(n>1000) return { ok:false, why:'valor alto demais pra uma tarefa — confira (máximo US$ 1.000 por liberação)' };
  const r=String(reason==null?'':reason).replace(/\s+/g,' ').trim();
  const words=r.split(' ').filter(w=>/[\p{L}\p{N}]{2,}/u.test(w));
  if(words.length<RELEASE_MIN_WORDS) return { ok:false, why:'escreva o motivo em uma frase (pelo menos 3 palavras) — ele vai pro PR' };
  return { ok:true, usd:Math.round(n*100)/100, reason:r.slice(0,400) };
}
function parseRelease(text){
  const t=String(text==null?'':text).replace(/\s+/g,' ').trim();
  const m=t.match(/(?:US\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  if(!m) return { ok:false, why:'escreva quanto liberar e o motivo (ex.: "liberar 2 porque falta o teste de login")' };
  const FILLER=/^(liberar|libera|libere|liberando|mais|continuar|continua|seguir|com|de|us\$|usd|d[óo]lares?|reais|porque|pois|motivo:?|j[áa]|que|[—–:,;.-]+)$/i;
  const words=(t.slice(0,m.index)+' '+t.slice(m.index+m[0].length)).split(' ').filter(Boolean);
  while(words.length && FILLER.test(words[0])) words.shift();
  return releaseCheck(m[1], words.join(' '));
}
// @ciclo-puro-fim

// ---------- a decisão "precisa de você" (seção inline no topo da aba da tarefa) ----------
// O que a pessoa precisa decidir agora — null quando nada. Fonte: spec.needsYou (motor) ou spec.budgetHit (teto
// pausado no meio do turno pelo app, 53-teto-protecao).
// @ciclo-decisao-inicio
function cicloDecision(t){
  if(!t) return null;
  const sp=t.spec||{}, ny=sp.needsYou||null, hit=sp.budgetHit||null;
  if(hit && (t.status==='paused' || t.status==='needs-you' || (hit.mode==='stopped' && t.status==='review'))) return { kind:'teto', text:(ny&&ny.kind==='teto'&&ny.text)||'', hit };
  if(ny && t.status==='needs-you') return { kind:ny.kind, text:ny.text||'' };
  return null;
}
const CICLO_DEC_TITLE={ teto:'Teto de custo', rodadas:'Revisão pediu a 3ª rodada', veredito:'Revisão sem veredito legível' };
function cicloDecisionHtml(t, d, ui){
  if(!d) return '';
  ui=ui||{};
  const cap=typeof budgetOf==='function'?budgetOf(t):0, spent=typeof taskCost==='function'?taskCost(t.id).usd:0;
  const head=`<div class="cicdec-h"><span class="cicdec-dot" aria-hidden="true"></span><b>Precisa de você</b><span class="cicdec-k">${esc(CICLO_DEC_TITLE[d.kind]||'decisão')}</span></div>`;
  const text=`<p class="cicdec-t">${esc(d.text || (d.kind==='teto'&&typeof budgetPrompt==='function'&&d.hit ? budgetPrompt(t, d.hit).split('\n\n')[0] : ''))}</p>`;
  const err=`<p class="cicdec-err" id="cicErr" role="alert">${esc(ui.err||'')}</p>`;
  if(d.kind==='teto'){
    return `<section class="cicdec" id="cicDecide" aria-label="Precisa de você: teto de custo">${head}${text}
      <p class="cicdec-sub">Gasto até agora <b>${esc(fmtCost(spent,{usdOnly:true}))}</b> de <b>${esc(fmtCost(cap,{usdOnly:true}))}</b>. Liberar mais pede o valor e o motivo — o motivo vai pro PR.</p>
      <div class="cicdec-form">
        <label class="cicdec-f cicdec-usd"><span>liberar US$</span><input class="in" id="cicUsd" inputmode="decimal" autocomplete="off" value="${escA(ui.usd||'')}" placeholder="2"></label>
        <label class="cicdec-f cicdec-why"><span>motivo</span><input class="in" id="cicWhy" autocomplete="off" value="${escA(ui.why||'')}" placeholder="ex.: falta o teste de login"></label>
        <div class="cicdec-acts"><button class="btn primary sm" id="cicRelease">liberar e seguir</button><button class="btn sm" id="cicStop">parar aqui</button></div>
      </div>${err}</section>`;
  }
  // rodadas / veredito (P3): seguir sem mais revisão (com motivo), mais uma rodada (conta no teto) ou parar
  return `<section class="cicdec" id="cicDecide" aria-label="Precisa de você: ${escA(CICLO_DEC_TITLE[d.kind]||'decisão')}">${head}${text}
    <div class="cicdec-form">
      <label class="cicdec-f cicdec-why"><span>motivo (se seguir sem nova revisão)</span><input class="in" id="cicWhy" autocomplete="off" value="${escA(ui.why||'')}" placeholder="ex.: os itens que faltam ficam pra outra tarefa"></label>
      <div class="cicdec-acts"><button class="btn primary sm" id="cicGo">seguir pra prova</button><button class="btn sm" id="cicRound">mais uma rodada</button><button class="btn sm" id="cicStop">parar aqui</button></div>
    </div>${err}</section>`;
}
// @ciclo-decisao-fim
const cicUi={}; // taskId → { usd, why, err } — o que a pessoa digitou sobrevive a um repaint
function cicloFocusDecision(){ const el=$id('cicUsd')||$id('cicWhy'); const s=$id('cicDecide'); if(s){ s.scrollIntoView(scrollOpts('center')); s.classList.add('flash'); setTimeout(()=>s.classList.remove('flash'),1400); } if(el) el.focus(); }
async function cicloAct(t, kind){
  const ui=cicUi[t.id]=cicUi[t.id]||{};
  const usd=($id('cicUsd')||{}).value, why=($id('cicWhy')||{}).value;
  ui.usd=usd; ui.why=why; ui.err='';
  const btns=[...document.querySelectorAll('#cicDecide button')]; btns.forEach(b=>b.disabled=true);
  try{
    if(kind==='release') await budgetRelease(t, usd, why);
    else if(kind==='stop'){
      if(!await askYes('Parar a tarefa aqui? O trabalho fica como está, pra você revisar.')) return;
      if(typeof budgetQuiet!=='undefined') budgetQuiet.add(t.id);
      await invoke('stop_task',{ taskId:t.id });
      await invoke('patch_task_spec',{ taskId:t.id, patch:{ budgetHit:null, needsYou:null } });
      toast('Parada — o trabalho ficou como está','ok');
    }
    else if(kind==='go' || kind==='round') await cicloReviewDecide(t, kind, why);
    delete cicUi[t.id];
    lastSig=''; await refresh();
  }catch(e){ ui.err=(typeof errShort==='function')?errShort(e):String(e&&e.message||e); const el=$id('cicErr'); if(el) el.textContent=ui.err; }
  finally{ btns.forEach(b=>{ if(b.isConnected) b.disabled=false; }); }
}
// Pinta a área do ciclo (#fwCiclo, fora do re-render do chat): só quando o conteúdo muda — os campos não perdem o foco.
function cicloPaint(t){
  const host=$id('fwCiclo'); if(!host || !t) return;
  const d=cicloDecision(t);
  const strip=(typeof cicloStripHtml==='function')?cicloStripHtml(t):'';
  const ui=cicUi[t.id]||{};
  const sig=t.id+'|'+strip+'|'+JSON.stringify(d)+'|'+(typeof taskCost==='function'?taskCost(t.id).usd.toFixed(4):'');
  if(host.__sig===sig) return;
  const keep=document.activeElement && host.contains(document.activeElement) ? document.activeElement.id : '';
  host.__sig=sig;
  host.innerHTML=strip+cicloDecisionHtml(t, d, ui);
  host.hidden=!host.innerHTML;
  ['cicUsd','cicWhy'].forEach(id=>{ const el=$id(id); if(el) el.oninput=()=>{ const u=cicUi[t.id]=cicUi[t.id]||{}; u[id==='cicUsd'?'usd':'why']=el.value; }; });
  const on=(id, k)=>{ const b=$id(id); if(b) b.onclick=()=>cicloAct(t, k); };
  on('cicRelease','release'); on('cicStop','stop'); on('cicGo','go'); on('cicRound','round');
  const why=$id('cicWhy'); if(why) why.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); const b=$id('cicRelease')||$id('cicGo'); if(b) b.click(); } };
  if(typeof cicloStripWire==='function') cicloStripWire(host, t);
  if(keep){ const el=$id(keep); if(el){ el.focus(); try{ el.setSelectionRange(el.value.length, el.value.length); }catch(_){ } } }
}
