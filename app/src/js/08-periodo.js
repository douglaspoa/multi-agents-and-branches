// Starfork — 08-periodo: PERÍODO e ORDEM POR MODIFICAÇÃO, fonte única (pedido do dono, 09/10).
// Período: Hoje · Ontem · Últimos 7 dias (padrão) · Últimos 30 dias · Este mês · Personalizado (de–até) — lembrado POR
// PESSOA e por tela (painel de Issues, Entregas, relatório). Contadores e listas filtram pelo mesmo intervalo.
// Ordem: SEMPRE pela data de modificação (o evento mais recente do item: atividade, mudança no painel, PR, comentário,
// troca de responsável), mais recente primeiro. Clicar noutra coluna vale enquanto a tela está aberta (memória da
// sessão, nunca gravada); ao abrir de novo volta pra modificação. "atualizado há X" usa a MESMA data.

// @puro-periodo-inicio (testado em app/tests/periodo.test.mjs)
const PERIODOS=[['hoje','Hoje'],['ontem','Ontem'],['7d','Últimos 7 dias'],['30d','Últimos 30 dias'],['mes','Este mês'],['custom','Personalizado']];
const PERIODO_PADRAO='7d';
function perDay0(ms){ const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function perAddDays(ms, n){ const d=new Date(ms); d.setDate(d.getDate()+n); return d.getTime(); }
// "2026-10-05" (data local do <input type=date>) → meia-noite local
function perParseDay(s){ const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m) return 0; return new Date(+m[1], +m[2]-1, +m[3]).getTime(); }
function perFmtDay(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
// p = { key, from:'aaaa-mm-dd', to:'aaaa-mm-dd' } → { from, to } em ms (to EXCLUSIVO). Dias inteiros, hora local.
function periodRange(p, now){
  p=p&&typeof p==='object'?p:{ key:p }; now=now||Date.now();
  const t0=perDay0(now), tom=perAddDays(t0, 1);
  switch(p.key){
    case 'hoje': return { from:t0, to:tom };
    case 'ontem': return { from:perAddDays(t0,-1), to:t0 };
    case '30d': return { from:perAddDays(t0,-29), to:tom };
    case 'mes': { const d=new Date(t0); d.setDate(1); return { from:d.getTime(), to:tom }; }
    case 'custom': {
      let a=perParseDay(p.from), b=perParseDay(p.to);
      if(!a && !b) return periodRange(PERIODO_PADRAO, now);
      if(!a) a=b; if(!b) b=a; if(b<a){ const x=a; a=b; b=x; }
      return { from:a, to:perAddDays(b,1) };
    }
    default: return { from:perAddDays(t0,-6), to:tom }; // últimos 7 dias, hoje incluso
  }
}
function periodNorm(p){ const k=p&&typeof p==='object'?p.key:p; return PERIODOS.some(x=>x[0]===k)?(k==='custom'?{ key:k, from:String(p.from||''), to:String(p.to||'') }:{ key:k }):{ key:PERIODO_PADRAO }; }
function periodLabel(p, now){
  p=periodNorm(p); const lb=(PERIODOS.find(x=>x[0]===p.key)||[])[1]||'';
  if(p.key!=='custom') return lb;
  const r=periodRange(p, now), f=ms=>new Date(ms).toLocaleDateString('pt-BR',{ day:'2-digit', month:'2-digit' });
  return r.to-r.from<=86400000+3600000?f(r.from):f(r.from)+'–'+f(perAddDays(r.to,-1));
}
function periodHas(r, ms){ return !!ms && ms>=r.from && ms<r.to; }
// modificação = o MAIOR carimbo entre os que o item tem (iso, número em s ou ms)
function modMs(v){ const n=typeof v==='number'?v:Date.parse(v||''); return n>0?(n<1e12?n*1000:n):0; }
function modTs(...vals){ let m=0; vals.flat().forEach(v=>{ const n=modMs(v); if(n>m) m=n; }); return m; }
// ordena SEM mudar a lista original: por modificação (padrão) ou pela coluna clicada nesta sessão
// sort = { col, dir:'asc'|'desc' } · val(item, col) devolve o valor da coluna; ts(item) a modificação
function sortRows(list, ts, sort, val){
  const out=list.slice();
  if(sort && sort.col && sort.col!=='mod' && val){
    const d=sort.dir==='asc'?1:-1;
    out.sort((a,b)=>{ const x=val(a,sort.col), y=val(b,sort.col);
      const ex=x==null||x==='', ey=y==null||y===''; if(ex||ey){ if(ex&&ey) return ts(b)-ts(a); return ex?1:-1; } // vazio sempre no fim
      const c=(typeof x==='number'&&typeof y==='number')?x-y:String(x==null?'':x).localeCompare(String(y==null?'':y),'pt-BR',{ numeric:true });
      return c*d || (ts(b)-ts(a)); });
    return out;
  }
  const d=sort&&sort.col==='mod'&&sort.dir==='asc'?-1:1;
  return out.sort((a,b)=>(ts(b)-ts(a))*d);
}
function modAgoTx(ms, now){
  if(!ms) return ''; const s=((now||Date.now())-ms)/1000; if(s<60) return 'agora';
  if(s<3600) return 'há '+Math.floor(s/60)+' min'; if(s<86400) return 'há '+Math.floor(s/3600)+' h';
  const d=Math.floor(s/86400); return d===1?'ontem':'há '+d+' dias';
}
// @puro-periodo-fim

// ---- lembrado por PESSOA e por tela ----
function periodKey(screen){ return (typeof userKey==='function'?userKey('per:'+screen, (typeof cloudUserId==='function'&&cloudUserId())||''):'per:'+screen); }
function periodGet(screen){ try{ return periodNorm(JSON.parse(lsGet(periodKey(screen))||'null')); }catch(_){ return periodNorm(null); } }
function periodSet(screen, p){ lsSet(periodKey(screen), JSON.stringify(periodNorm(p))); }
// ordem clicada: só nesta sessão da tela (ao abrir de novo, volta pra modificação)
const sortSession={};
function sortGet(screen){ return sortSession[screen]||{ col:'mod', dir:'desc' }; }
function sortToggle(screen, col){ const s=sortGet(screen); sortSession[screen]=s.col===col?{ col, dir:s.dir==='desc'?'asc':'desc' }:{ col, dir:col==='mod'?'desc':'asc' }; return sortSession[screen]; }
function sortReset(screen){ delete sortSession[screen]; }
// seletor de período (mesmo em toda tela): <select> + de/até quando "Personalizado"
// where: sufixo do id quando a mesma tela de período aparece em dois lugares abertos ao mesmo tempo (Time e Central)
function periodPickerHtml(screen, p, where){
  p=p||periodGet(screen); const id='per-'+screen+(where?'-'+where:'');
  const ic=(typeof IC!=='undefined'&&IC.cal)||''; // calendário: o seletor tem cara de controle (dono 09/10: "nem tenho como alterar a data")
  return `<span class="perpick" data-perscreen="${escA(screen)}">${ic?`<span class="perpick-ic" aria-hidden="true">${ic}</span>`:''}<select class="sel perpick-sel" id="${escA(id)}" aria-label="período" title="período — muda o que a tela mostra e os números">${PERIODOS.map(([k,l])=>`<option value="${k}"${p.key===k?' selected':''}>${esc(l)}</option>`).join('')}</select>${p.key==='custom'?`<input type="date" class="in perpick-d" data-per="from" value="${escA(p.from||perFmtDay(Date.now()-6*86400000))}" aria-label="de"><span class="dim">até</span><input type="date" class="in perpick-d" data-per="to" value="${escA(p.to||perFmtDay(Date.now()))}" aria-label="até">`:''}</span>`;
}
function periodPickerWire(root, onChange){
  (root||document).querySelectorAll('.perpick').forEach(w=>{
    const screen=w.dataset.perscreen, sel=w.querySelector('select');
    const save=()=>{ const cur=periodGet(screen); const nx={ key:sel.value };
      if(nx.key==='custom'){ const f=w.querySelector('[data-per="from"]'), t=w.querySelector('[data-per="to"]');
        nx.from=(f&&f.value)||cur.from||perFmtDay(Date.now()-6*86400000); nx.to=(t&&t.value)||cur.to||perFmtDay(Date.now()); }
      periodSet(screen, nx); if(onChange) onChange(periodGet(screen)); };
    if(sel) sel.onchange=save;
    w.querySelectorAll('[data-per]').forEach(i=>i.onchange=save);
  });
}
window.periodGet=periodGet; window.periodSet=periodSet; window.periodRange=periodRange; window.periodLabel=periodLabel;
window.periodPickerHtml=periodPickerHtml; window.periodPickerWire=periodPickerWire; window.sortRows=sortRows; window.modTs=modTs;
window.sortGet=sortGet; window.sortToggle=sortToggle; window.sortReset=sortReset; window.modAgoTx=modAgoTx;
