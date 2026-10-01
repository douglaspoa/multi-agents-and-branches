// Starfork — 28-medidor-plano: widget fixo no menu lateral com o uso do plano de cada IA configurada.
// Dados: comando Rust ÚNICO plan_usage (async) — Claude (estado/limite/reinício do rate_limit_event + uso que o
// Starfork registrou em 5 h), Codex (% real das janelas da última sessão local), DeepSeek (saldo da API oficial).
// Nada vai pra nuvem. A % do Claude só existe quando o próprio Claude Code manda (perto do limite) — nunca inventada.
// Atualização leve: no boot, no fim de um turno de tarefa e no máximo a cada 2 min com a janela visível.
// Minimizado (uma linha: a IA padrão) ou expandido (uma linha por IA) — lembrado no localStorage.
// Clique numa IA → painel "Sua IA" (aba Configurações). IA não configurada não aparece.
let pmData=null, pmAt=0, _pmP=null, _pmTurnAt=0;
const PM_MIN_KEY='planMeterMin';
const PM_EVERY=120000;
// @medidor-puro-inicio
const PM_ORDER=['claude','codex','deepseek'];
const PM_NAME={ claude:'Claude', codex:'Codex', deepseek:'DeepSeek' };
const PM_WIN={ five_hour:'5h', seven_day:'semana', seven_day_opus:'semana Opus', seven_day_sonnet:'semana Sonnet', overage:'uso extra' };
const PM_CUR={ USD:'US$', CNY:'¥', BRL:'R$', EUR:'€' };
// verde < 70 %, amarelo 70–90 %, vermelho > 90 % (ou bloqueado)
function pmLevel(pct, blocked){
  if(blocked) return 'crit';
  if(pct==null || !isFinite(pct)) return 'idle';
  return pct>90?'crit':pct>=70?'warn':'ok';
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
// uma linha por IA: { id, name, level, text, short, tip }
function pmRowClaude(c, now){
  const win=PM_WIN[c.window]||c.window||'';
  const sf=c.starfork||{}; const tok=(Number(sf.inTok)||0)+(Number(sf.outTok)||0);
  const used=sf.turns>0?'Starfork usou '+pmTok(tok)+' tok em 5h':'';
  const reset=c.resetsAt?pmWhen(c.resetsAt, now):'';
  let text, short, level;
  if(c.state==='blocked'){ text='limite atingido'+(reset?' · volta '+reset:''); short='limite atingido'; level='crit'; }
  else if(c.pct!=null){ text=pmPct(c.pct)+(win?' ('+win+')':''); short=pmPct(c.pct); level=pmLevel(c.pct); }
  else if(c.state==='warn'){ text='perto do limite'+(win?' ('+win+')':'')+(reset?' · reinicia '+reset:''); short='perto do limite'; level='warn'; }
  else if(c.state==='ok'){ text=['ok', reset?'reinicia '+reset:'', used].filter(Boolean).join(' · '); short='ok'; level='ok'; }
  else { text=used||'sem dados ainda'; short=used?'ok':'sem dados'; level='idle'; }
  const tip=[
    c.state==='blocked'?'Limite do plano atingido'+(win?' (janela '+win+')':'')+(reset?' — volta às '+reset:''):'',
    c.pct!=null?pmPct(c.pct)+' da janela '+(win||'')+(reset?' · reinicia às '+reset:''):'',
    c.pct==null && c.state!=='blocked' && reset?'Janela '+(win||'')+' reinicia às '+reset:'',
    'A % exata do Claude só aparece perto do limite (o Claude Code só manda o número aí).',
    'Uso registrado pelo Starfork nas últimas 5 h: '+(sf.turns>0?pmTok(sf.inTok)+' tok de entrada, '+pmTok(sf.outTok)+' de saída, '+sf.turns+' turno(s)'+(sf.ms?', '+Math.round(sf.ms/60000)+' min':''):'nada ainda')+'.',
  ].filter(Boolean).join('\n');
  return { id:'claude', name:PM_NAME.claude, level, text, short, tip };
}
function pmRowCodex(x, now){
  if(!x || !x.hasData) return { id:'codex', name:PM_NAME.codex, level:'idle', text:'sem dados ainda', short:'sem dados', tip:'Ainda não há limites na sua última sessão do Codex — aparecem depois do 1º turno.' };
  const p=x.primary, s=x.secondary;
  const parts=[], tip=[];
  if(p){ parts.push('5h '+pmPct(p.usedPercent)); if(p.resetsAt) tip.push('5h: '+pmPct(p.usedPercent)+' · reinicia '+pmWhen(p.resetsAt, now)); }
  if(s){ parts.push('semana '+pmPct(s.usedPercent)); if(s.resetsAt) tip.push('semana: '+pmPct(s.usedPercent)+' · reinicia '+pmWhen(s.resetsAt, now)); }
  if(x.plan) parts.push(x.plan);
  if(p&&p.reset || s&&s.reset) tip.push('a janela já reiniciou desde a última sessão');
  tip.push('Lido da sua última sessão local do Codex.');
  const top=Math.max(p?p.usedPercent:0, s?s.usedPercent:0);
  return { id:'codex', name:PM_NAME.codex, level:pmLevel(top), text:parts.join(' · '), short:p?'5h '+pmPct(p.usedPercent):pmPct(top), tip:tip.join('\n') };
}
function pmRowDeepseek(d){
  if(!d || !d.ok) return { id:'deepseek', name:PM_NAME.deepseek, level:'idle', text:'saldo indisponível', short:'saldo indisponível', tip:'Não consegui ler o saldo agora (rede ou chave) — tento de novo em 2 min.' };
  const money=(d.balances||[]).map(pmMoney).join(' · ')||'—';
  const empty=d.available===false;
  return { id:'deepseek', name:PM_NAME.deepseek, level:empty?'crit':'ok', text:empty?'sem saldo · '+money:'saldo '+money, short:empty?'sem saldo':money, tip:'Saldo da sua conta DeepSeek (API oficial).' };
}
function pmRows(u, now){
  if(!u) return [];
  const conf=Array.isArray(u.configured)?u.configured:[];
  const out=[];
  for(const id of PM_ORDER){
    if(!conf.includes(id)) continue;
    if(id==='claude' && u.claude) out.push(pmRowClaude(u.claude, now));
    if(id==='codex') out.push(pmRowCodex(u.codex, now));
    if(id==='deepseek') out.push(pmRowDeepseek(u.deepseek));
  }
  return out;
}
// a linha do minimizado: a IA padrão (se configurada), senão a 1ª
function pmMain(rows, defEng){ return rows.find(r=>r.id===defEng)||rows[0]||null; }
const PM_CHEV='<svg class="pm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10l3.5-3.5 3.5 3.5"/></svg>';
function pmHtml(u, min, defEng, now){
  if(!u) return `<button class="pm-head" data-pm="toggle" aria-expanded="${!min}"><span class="pm-title">Uso do plano</span><span class="pm-sum dim">verificando…</span>${PM_CHEV}</button>`;
  const rows=pmRows(u, now);
  if(!rows.length) return `<button class="pm-head pm-empty" data-pm="cfg" title="Nenhuma IA pronta — abrir Sua IA"><span class="pm-dot pm-idle"></span><span class="pm-title">configure sua IA</span></button>`;
  const main=pmMain(rows, defEng);
  const head=`<button class="pm-head" data-pm="toggle" aria-expanded="${!min}" title="${min?'Mostrar o uso de cada IA':'Minimizar'}"><span class="pm-title">Uso do plano</span>`
    +(min?`<span class="pm-sum"><span class="pm-dot pm-${main.level}"></span>${esc(main.name)} · ${esc(main.short)}</span>`:'<span class="pm-sum"></span>')+PM_CHEV+'</button>';
  if(min) return head;
  const list=rows.map(r=>`<button class="pm-row pm-${r.level}" data-pm="cfg" data-pm-id="${escA(r.id)}" title="${escA(r.tip+'\nClique: abrir Sua IA')}"><span class="pm-dot pm-${r.level}"></span><span class="pm-name">${esc(r.name)}</span><span class="pm-txt">${esc(r.text)}</span></button>`).join('');
  return head+`<div class="pm-rows">${list}</div>`;
}
// @medidor-puro-fim
function pmIsMin(){ return lsGet(PM_MIN_KEY)==='1'; }
function pmDefEng(){
  try{ if(typeof aiDefaults==='function') return aiEngineOf(aiDefaults().eng); }catch(_){ }
  return (pmData&&pmData.defaultEngine)||'claude';
}
function pmRender(){
  const el=document.getElementById('planMeter'); if(!el) return;
  const min=pmIsMin();
  const html=pmHtml(pmData, min, pmDefEng(), Date.now());
  if(el.__html!==html){ el.innerHTML=html; el.__html=html; }
  el.classList.toggle('min', min);
}
function pmToggle(){ lsSet(PM_MIN_KEY, pmIsMin()?'0':'1'); pmRender(); }
function pmLoad(){
  if(_pmP) return _pmP;
  const call=typeof invokeQuiet==='function'?invokeQuiet:invoke;
  _pmP=Promise.resolve().then(()=>call('plan_usage'))
    .then(r=>{ if(r && typeof r==='object'){ pmData=r; } })
    .catch(()=>{ /* leitura falhou: mantém o último valor; tenta de novo no próximo ciclo */ })
    .finally(()=>{ pmAt=Date.now(); _pmP=null; pmRender(); });
  return _pmP;
}
// ciclo de 2 min: só com a janela visível (escondida não lê nada)
function pmTick(){
  if(typeof document!=='undefined' && document.hidden) return;
  if(Date.now()-pmAt < PM_EVERY-5000) return;
  pmLoad();
}
// fim de turno de tarefa (10-core detectNotifs): relê logo, sem rajada se várias terminarem juntas
function planMeterTurnEnd(){
  if(Date.now()-_pmTurnAt < 20000) return;
  _pmTurnAt=Date.now();
  setTimeout(pmLoad, 1500);
}
window.planMeterTurnEnd=planMeterTurnEnd;
function pmWire(){
  const el=document.getElementById('planMeter'); if(!el || el.__pmWired) return;
  el.__pmWired=true;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest && ev.target.closest('[data-pm]'); if(!b) return;
    if(b.dataset.pm==='toggle') pmToggle();
    else if(typeof suaIaOpenCfg==='function') suaIaOpenCfg();
  });
}
if(typeof document!=='undefined' && document.getElementById && document.getElementById('planMeter')){
  pmWire(); pmRender();
  setTimeout(pmLoad, 1500);
  setInterval(pmTick, PM_EVERY);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pmTick(); });
}
