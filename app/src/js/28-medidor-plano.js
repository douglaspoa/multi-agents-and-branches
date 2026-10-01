// Starfork — 28-medidor-plano: widget fixo no menu lateral com o uso do plano de cada IA configurada.
// Dados: comando Rust ÚNICO plan_usage (async) — Claude (estado/limite/reinício do rate_limit_event + uso que o
// Starfork registrou em 5 h NESTE projeto), Codex (% real das janelas da última sessão local), DeepSeek (saldo da
// API oficial). Formato fixado por tests/fixtures/plan-usage-golden/payload.json. Nada vai pra nuvem.
// A % do Claude só existe quando o próprio Claude Code manda (perto do limite) — nunca inventada.
// Atualização leve: no boot, no fim de um turno de tarefa (10-core detectNotifs) e no máximo a cada 2 min com a
// janela visível; config da Sua IA mudou → planMeterReset. Minimizado (uma linha: a IA padrão) ou expandido (uma
// linha por IA, com os detalhes em texto) — lembrado no localStorage. Clique numa IA → painel "Sua IA".
let pmData=null, pmAt=0, pmErr='', _pmP=null, _pmTurnT=0;
const PM_MIN_KEY='planMeterMin';
const PM_EVERY=120000;
const PM_TURN_WAIT=3000;
// @medidor-puro-inicio
const PM_ORDER=['claude','codex','deepseek'];
const PM_NAME={ claude:'Claude', codex:'Codex', deepseek:'DeepSeek' };
const PM_WIN={ five_hour:'5h', seven_day:'semana', seven_day_opus:'semana Opus', seven_day_sonnet:'semana Sonnet', overage:'uso extra' };
const PM_CUR={ USD:'US$', CNY:'¥', BRL:'R$', EUR:'€' };
const PM_LVL_TXT={ ok:'normal', warn:'atenção', crit:'crítico', idle:'sem dados' };
const PM_RANK={ idle:0, ok:1, warn:2, crit:3 };
// verde < 70 %, amarelo 70–90 %, vermelho > 90 % (ou bloqueado)
function pmLevel(pct, blocked){
  if(blocked) return 'crit';
  if(pct==null || !isFinite(pct)) return 'idle';
  return pct>90?'crit':pct>=70?'warn':'ok';
}
function pmMaxLevel(a, b){ return PM_RANK[a]>=PM_RANK[b]?a:b; }
// rótulo da janela pelos minutos (o Codex manda window_minutes): 300→5h, 10080→semana, senão Nh/Nd
function pmWinMin(m){
  m=Number(m)||0;
  if(m===300) return '5h';
  if(m===10080) return 'semana';
  if(m>0 && m%1440===0) return (m/1440)+'d';
  if(m>0) return Math.round(m/60)+'h';
  return 'janela';
}
const _pm2=n=>String(n).padStart(2,'0');
// hoje: "18:00"; outro dia: "02/10 18:00"
function pmWhen(ms, now){
  if(!ms) return '';
  const d=new Date(ms), n=new Date(now||Date.now());
  const hm=_pm2(d.getHours())+':'+_pm2(d.getMinutes());
  return d.toDateString()===n.toDateString()?hm:_pm2(d.getDate())+'/'+_pm2(d.getMonth()+1)+' '+hm;
}
function pmTok(n){
  n=Number(n)||0;
  if(n>=1e6) return (Math.round(n/1e5)/10).toLocaleString('pt-BR')+'M';
  if(n>=1e3) return Math.round(n/1e3)+'k';
  return String(n);
}
function pmPct(p){ return Math.round(Number(p)||0)+' %'; }
function pmMoney(b){
  const v=Number(b.total);
  const num=isFinite(v)?v.toLocaleString('pt-BR',{ minimumFractionDigits:2, maximumFractionDigits:2 }):String(b.total);
  return (PM_CUR[b.currency]||b.currency||'')+' '+num;
}
const PM_NOTE_CLAUDE='A % exata do Claude só aparece perto do limite (o Claude Code só manda o número aí).';
// uma linha por IA: { id, name, level, text, short, detail (visível no expandido), tip }
function pmRowClaude(c, now){
  if(!c) return { id:'claude', name:PM_NAME.claude, level:'idle', text:'sem dados ainda', short:'sem dados', detail:PM_NOTE_CLAUDE, tip:PM_NOTE_CLAUDE };
  const win=PM_WIN[c.window]||c.window||'';
  const sf=c.starfork||{}; const tok=(Number(sf.inTok)||0)+(Number(sf.outTok)||0);
  const used=c.starforkError?'uso do Starfork indisponível':sf.turns>0?'Starfork usou '+pmTok(tok)+' tok em 5h neste projeto':'';
  const reset=c.resetsAt?pmWhen(c.resetsAt, now):'';
  let text, short, level;
  if(c.state==='blocked'){ text='limite atingido'+(reset?' · volta '+reset:''); short='limite atingido'; level='crit'; }
  else if(c.pct!=null){
    text=pmPct(c.pct)+(win?' ('+win+')':''); short=pmPct(c.pct);
    // perto do limite nunca fica verde: no mínimo amarelo
    level=c.state==='warn'?pmMaxLevel(pmLevel(c.pct),'warn'):pmLevel(c.pct);
  }
  else if(c.state==='warn'){ text='perto do limite'+(win?' ('+win+')':'')+(reset?' · reinicia '+reset:''); short='perto do limite'; level='warn'; }
  else if(c.state==='ok'){ text=['ok', reset?'reinicia '+reset:'', used].filter(Boolean).join(' · '); short='ok'; level='ok'; }
  else { text=used||'sem dados ainda'; short=used&&!c.starforkError?'ok':'sem dados'; level='idle'; }
  const sfLine=c.starforkError?'Uso do Starfork indisponível agora.'
    :'Neste projeto, últimas 5 h: '+(sf.turns>0?pmTok(sf.inTok)+' tok de entrada, '+pmTok(sf.outTok)+' de saída, '+sf.turns+' turno(s)'+(sf.ms?', '+Math.round(sf.ms/60000)+' min':''):'nada registrado')+'.';
  const resetLine=reset?(c.state==='blocked'?'Volta às '+reset:'Janela '+(win||'')+' reinicia às '+reset)+'.':'';
  const detail=[resetLine, sfLine, PM_NOTE_CLAUDE].filter(Boolean).join(' ');
  return { id:'claude', name:PM_NAME.claude, level, text, short, detail, tip:detail };
}
function pmRowCodex(x, now){
  if(!x || !x.hasData) return { id:'codex', name:PM_NAME.codex, level:'idle', text:'sem dados ainda', short:'sem dados', detail:'Os limites aparecem depois do 1º turno do Codex.', tip:'Ainda não há limites nas suas últimas sessões do Codex — aparecem depois do 1º turno.' };
  const ws=[x.primary, x.secondary].filter(Boolean);
  const parts=ws.map(w=>pmWinMin(w.windowMinutes)+' '+pmPct(w.usedPercent));
  if(x.plan) parts.push(x.plan);
  const det=ws.filter(w=>w.resetsAt).map(w=>pmWinMin(w.windowMinutes)+' reinicia '+pmWhen(w.resetsAt, now)+(w.reset?' (já reiniciou)':''));
  const top=Math.max(0, ...ws.map(w=>Number(w.usedPercent)||0));
  const detail=det.join(' · ');
  const first=ws[0];
  return { id:'codex', name:PM_NAME.codex, level:pmLevel(top), text:parts.join(' · '), short:first?pmWinMin(first.windowMinutes)+' '+pmPct(first.usedPercent):pmPct(top), detail, tip:(detail?detail+'\n':'')+'Lido da sua última sessão local do Codex.' };
}
function pmRowDeepseek(d){
  if(!d || !d.ok) return { id:'deepseek', name:PM_NAME.deepseek, level:'idle', text:'saldo indisponível', short:'saldo indisponível', detail:'Tento de novo em 2 min.', tip:'Não consegui ler o saldo agora (rede ou chave) — tento de novo em 2 min.' };
  const money=(d.balances||[]).map(pmMoney).join(' · ')||'—';
  const empty=d.available===false;
  return { id:'deepseek', name:PM_NAME.deepseek, level:empty?'crit':'ok', text:empty?'sem saldo · '+money:'saldo '+money, short:empty?'sem saldo':money, detail:empty?'Saldo insuficiente na conta DeepSeek.':'Saldo da conta DeepSeek (API oficial).', tip:'Saldo da sua conta DeepSeek (API oficial).' };
}
function pmRows(u, now){
  if(!u) return [];
  const conf=Array.isArray(u.configured)?u.configured:[];
  const out=[];
  for(const id of PM_ORDER){
    if(!conf.includes(id)) continue;
    if(id==='claude') out.push(pmRowClaude(u.claude, now));
    if(id==='codex') out.push(pmRowCodex(u.codex, now));
    if(id==='deepseek') out.push(pmRowDeepseek(u.deepseek));
  }
  return out;
}
// a linha do minimizado: a IA padrão (se configurada), senão a 1ª
function pmMain(rows, defEng){ return rows.find(r=>r.id===defEng)||rows[0]||null; }
function pmDot(level){ return `<span class="pm-dot pm-${level}" role="img" aria-label="${PM_LVL_TXT[level]||level}"></span>`; }
const PM_CHEV='<svg class="pm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10l3.5-3.5 3.5 3.5"/></svg>';
function pmHtml(u, min, defEng, now, err){
  if(!u && err) return `<button class="pm-head pm-empty" data-pm="retry" title="${escA(err)}">${pmDot('idle')}<span class="pm-title">não consegui ler o uso — tentar de novo</span></button>`;
  if(!u) return `<button class="pm-head" data-pm="toggle" aria-expanded="${!min}"><span class="pm-title">Uso do plano</span><span class="pm-sum dim">verificando…</span>${PM_CHEV}</button>`;
  const rows=pmRows(u, now);
  if(!rows.length) return `<button class="pm-head pm-empty" data-pm="cfg" title="Nenhuma IA pronta — abrir Sua IA">${pmDot('idle')}<span class="pm-title">configure sua IA</span></button>`;
  const main=pmMain(rows, defEng);
  const head=`<button class="pm-head" data-pm="toggle" aria-expanded="${!min}" aria-controls="pmRows" title="${min?'Mostrar o uso de cada IA':'Minimizar'}"><span class="pm-title">Uso do plano</span>`
    +(min?`<span class="pm-sum">${pmDot(main.level)}${esc(main.name)} · ${esc(main.short)}</span>`:'<span class="pm-sum"></span>')+PM_CHEV+'</button>';
  const list=rows.map(r=>`<button class="pm-row pm-${r.level}" data-pm="cfg" data-pm-id="${escA(r.id)}" title="${escA(r.tip+'\nClique: abrir Sua IA')}">${pmDot(r.level)}<span class="pm-body"><span class="pm-line"><span class="pm-name">${esc(r.name)}</span> <span class="pm-txt">${esc(r.text)}</span></span>${r.detail?`<span class="pm-det">${esc(r.detail)}</span>`:''}</span></button>`).join('');
  return head+`<div class="pm-rows" id="pmRows"${min?' hidden':''}>${list}</div>`;
}
// @medidor-puro-fim
function pmIsMin(){ return lsGet(PM_MIN_KEY)==='1'; }
// mesmo id do seletor (aiEngineOf: "dsh…"/"deepseek…" → deepseek, "codex…" → codex…)
function pmEngId(e){
  if(typeof aiEngineOf==='function') return aiEngineOf(e);
  const n=String(e||'').trim().toLowerCase();
  return n.startsWith('codex')?'codex':(n.startsWith('deepseek')||/^dsh\b/.test(n))?'deepseek':'claude';
}
function pmDefEng(){
  let e='';
  try{ if(typeof aiDefaults==='function') e=aiDefaults().eng; }catch(_){ }
  return pmEngId(e||(pmData&&pmData.defaultEngine)||'claude');
}
function pmRender(){
  const el=document.getElementById('planMeter'); if(!el) return;
  const min=pmIsMin();
  const html=pmHtml(pmData, min, pmDefEng(), Date.now(), pmErr);
  if(el.__html!==html){ el.innerHTML=html; el.__html=html; }
  el.classList.toggle('min', min);
}
function pmToggle(){ lsSet(PM_MIN_KEY, pmIsMin()?'0':'1'); pmRender(); }
function pmLoad(){
  if(_pmP) return _pmP;
  pmAt=Date.now(); // marca no INÍCIO: uma leitura lenta não faz o ciclo seguinte pular
  const call=typeof invokeQuiet==='function'?invokeQuiet:invoke;
  _pmP=Promise.resolve().then(()=>call('plan_usage'))
    .then(r=>{ if(r && typeof r==='object'){ pmData=r; pmErr=''; } else if(!pmData) pmErr='resposta vazia'; })
    // falhou: mantém o último valor; sem nenhum ainda → estado de erro com "tentar de novo"
    .catch(e=>{ pmErr=String((e&&e.message)||e||'erro'); })
    .finally(()=>{ _pmP=null; pmRender(); });
  return _pmP;
}
// ciclo de 2 min: só com a janela visível (escondida não lê nada)
function pmTick(){
  if(typeof document!=='undefined' && document.hidden) return;
  if(Date.now()-pmAt < PM_EVERY-5000) return;
  return pmLoad();
}
// fim de turno de tarefa: debounce no FIM (várias terminando juntas = uma leitura, depois da última)
function planMeterTurnEnd(){
  clearTimeout(_pmTurnT);
  _pmTurnT=setTimeout(pmLoad, PM_TURN_WAIT);
}
// config da Sua IA mudou (o Rust já esqueceu prontas/saldo em ai_avail_refresh): relê agora
function planMeterReset(){ return pmLoad(); }
window.planMeterTurnEnd=planMeterTurnEnd;
window.planMeterReset=planMeterReset;
function pmWire(){
  const el=document.getElementById('planMeter'); if(!el || el.__pmWired) return;
  el.__pmWired=true;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest && ev.target.closest('[data-pm]'); if(!b) return;
    if(b.dataset.pm==='toggle') pmToggle();
    else if(b.dataset.pm==='retry'){ pmErr=''; pmRender(); pmLoad(); }
    else if(typeof suaIaOpenCfg==='function') suaIaOpenCfg();
  });
}
if(typeof document!=='undefined' && document.getElementById && document.getElementById('planMeter')){
  pmWire(); pmRender();
  setTimeout(pmLoad, 1500);
  setInterval(pmTick, PM_EVERY);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pmTick(); });
}
