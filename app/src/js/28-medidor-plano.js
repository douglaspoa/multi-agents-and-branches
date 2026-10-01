// Starfork — 28-medidor-plano: widget fixo no menu lateral com o uso do plano de cada IA configurada.
// Dados: comando Rust ÚNICO plan_usage (async) — Claude (% REAL das janelas de 5 h e da semana pela barra de status
// do Claude Code, quando ativada em Sua IA + estado/limite/reinício do rate_limit_event + uso que o Starfork
// registrou em 5 h NESTE projeto), Codex (% real das janelas da última sessão local), DeepSeek (saldo da API
// oficial). Formato fixado por tests/fixtures/plan-usage-golden/payload.json. Nada vai pra nuvem.
// A % do Claude vem da barra de status (ou do Claude Code perto do limite) — nunca inventada.
// v2 (spec-medidor-v2-statusline): cada IA = nome + barras finas por janela com o número à direita (verde < 70,
// amarelo 70–90, vermelho > 90 ou bloqueado); IA padrão primeiro, depois as outras por maior uso; detalhes
// (reinício, tokens do Starfork, saldo) num "expandir" por IA. Minimizado = uma barra fina com a % da maior janela
// da IA padrão + rótulo curto — lembrado no localStorage. Nome da IA → painel "Sua IA".
// Atualização leve: no boot, no fim de um turno de tarefa (10-core detectNotifs) e no máximo a cada 2 min com a
// janela visível; config da Sua IA mudou → planMeterReset.
let pmData=null, pmAt=0, pmErr='', _pmP=null, _pmTurnT=0;
const pmOpen=new Set(); // IAs com os detalhes abertos (só nesta sessão)
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
// "atualizado há X"
function pmAgo(ms, now){
  const s=Math.max(0, ((now||Date.now())-Number(ms))/1000);
  if(s<60) return 'agora';
  if(s<3600) return 'há '+Math.floor(s/60)+' min';
  if(s<86400) return 'há '+Math.floor(s/3600)+' h';
  return 'há '+Math.floor(s/86400)+' d';
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
function pmBar(key, label, pct, blocked){ const p=Math.max(0, Math.min(100, Number(pct)||0)); return { key, label, pct:p, level:pmLevel(p, blocked) }; }
// a janela mais cheia (empate: a primeira — 5h antes da semana)
function pmTop(bars){ return (bars||[]).reduce((a,b)=>!a||b.pct>a.pct?b:a, null); }
const PM_HINT_ON='Ative a % do Claude em Sua IA.';
const PM_HINT_WAIT='A % aparece depois da próxima resposta do Claude Code.';
const PM_NOTE_CLAUDE='Sem a barra de status, a % exata do Claude só aparece perto do limite.';
// uma IA: { id, name, level, bars:[{key,label,pct,level}], text, sub, hint, details:[], short, top, tip }
function pmRowClaude(c, now){
  const name=PM_NAME.claude;
  if(!c) return { id:'claude', name, level:'idle', bars:[], text:'sem dados ainda', sub:'', hint:PM_HINT_ON, details:[PM_NOTE_CLAUDE], short:'sem dados', top:null, tip:PM_NOTE_CLAUDE };
  const win=PM_WIN[c.window]||c.window||'';
  const blocked=c.state==='blocked';
  const sf=c.starfork||{}; const tok=(Number(sf.inTok)||0)+(Number(sf.outTok)||0);
  const reset=c.resetsAt?pmWhen(c.resetsAt, now):'';
  const bars=[];
  const ws=[['five_hour', c.fiveHour], ['seven_day', c.sevenDay]];
  for(const [k,w] of ws) if(w && w.pct!=null) bars.push(pmBar(k, PM_WIN[k], w.pct, blocked && c.window===k));
  const fromSl=bars.length>0;
  // sem a barra de status: a % que o Claude Code mandou perto do limite (uma barra só, da janela do evento)
  if(!fromSl && c.pct!=null) bars.push(pmBar(c.window||'janela', win||'janela', c.pct, blocked));
  // perto do limite nunca fica verde: no mínimo amarelo na janela do evento
  if(c.state==='warn') for(const b of bars) if(b.key===c.window) b.level=pmMaxLevel(b.level, 'warn');
  let text='', level=bars.reduce((l,b)=>pmMaxLevel(l, b.level), 'idle');
  if(blocked){ text='limite atingido'+(reset?' · volta '+reset:''); level='crit'; }
  else if(c.state==='warn'){ if(!bars.length) text='perto do limite'+(win?' ('+win+')':'')+(reset?' · reinicia '+reset:''); level=pmMaxLevel(level, 'warn'); }
  else if(!bars.length && c.state==='ok'){ text='ok'+(reset?' · reinicia '+reset:''); level='ok'; }
  else if(!bars.length){ text=c.starforkError?'uso do Starfork indisponível':sf.turns>0?'Starfork usou '+pmTok(tok)+' tok em 5h':'sem dados ainda'; }
  const sub=fromSl && c.updatedAt?'atualizado '+pmAgo(c.updatedAt, now):'';
  const hint=fromSl?'':(c.statusline?PM_HINT_WAIT:PM_HINT_ON);
  const details=[];
  for(const [k,w] of ws) if(w && w.resetsAt) details.push(PM_WIN[k]+(w.reset?' já reiniciou':' reinicia '+pmWhen(w.resetsAt, now)));
  if(!fromSl && reset) details.push(blocked?'Volta às '+reset:'Janela '+(win||'')+' reinicia às '+reset);
  details.push(c.starforkError?'Uso do Starfork indisponível agora.'
    :'Starfork neste projeto, últimas 5 h: '+(sf.turns>0?pmTok(sf.inTok)+' tok de entrada, '+pmTok(sf.outTok)+' de saída, '+sf.turns+' turno(s)'+(sf.ms?', '+Math.round(sf.ms/60000)+' min':''):'nada registrado'));
  if(!fromSl) details.push(PM_NOTE_CLAUDE);
  const top=pmTop(bars);
  const short=blocked?'limite atingido':top?top.label+' '+pmPct(top.pct):c.state==='warn'?'perto do limite':c.state==='ok'?'ok':text;
  return { id:'claude', name, level, bars, text, sub, hint, details, short, top:top?top.pct:null, topBar:top, tip:details.join('\n') };
}
function pmRowCodex(x, now){
  const name=PM_NAME.codex;
  if(!x || !x.hasData) return { id:'codex', name, level:'idle', bars:[], text:'sem dados ainda', sub:'', hint:'', details:['Os limites aparecem depois do 1º turno do Codex.'], short:'sem dados', top:null, tip:'Ainda não há limites nas suas últimas sessões do Codex — aparecem depois do 1º turno.' };
  const ws=[x.primary, x.secondary].filter(Boolean);
  const bars=ws.map((w,i)=>pmBar(i?'secondary':'primary', pmWinMin(w.windowMinutes), w.usedPercent));
  const details=ws.filter(w=>w.resetsAt).map(w=>pmWinMin(w.windowMinutes)+' reinicia '+pmWhen(w.resetsAt, now)+(w.reset?' (já reiniciou)':''));
  if(x.plan) details.push('plano '+x.plan);
  details.push('Lido da sua última sessão local do Codex.');
  const top=pmTop(bars);
  return { id:'codex', name, level:bars.reduce((l,b)=>pmMaxLevel(l, b.level), 'idle'), bars, text:'', sub:'', hint:'', details, short:top?top.label+' '+pmPct(top.pct):'sem dados', top:top?top.pct:null, topBar:top, tip:details.join('\n') };
}
function pmRowDeepseek(d){
  const name=PM_NAME.deepseek;
  if(!d || !d.ok) return { id:'deepseek', name, level:'idle', bars:[], text:'saldo indisponível', sub:'', hint:'', details:['Não consegui ler o saldo agora (rede ou chave) — tento de novo em 2 min.'], short:'saldo indisponível', top:null, tip:'Não consegui ler o saldo agora (rede ou chave) — tento de novo em 2 min.' };
  const money=(d.balances||[]).map(pmMoney).join(' · ')||'—';
  const empty=d.available===false;
  const det=empty?'Saldo insuficiente na conta DeepSeek.':'Saldo da conta DeepSeek (API oficial).';
  return { id:'deepseek', name, level:empty?'crit':'ok', bars:[], text:empty?'sem saldo · '+money:'saldo '+money, sub:'', hint:'', details:[det], short:empty?'sem saldo':money, top:null, tip:det };
}
// IA padrão primeiro; depois as outras por maior uso (sem % = no fim; empate = ordem do painel)
function pmRows(u, now, defEng){
  if(!u) return [];
  const conf=Array.isArray(u.configured)?u.configured:[];
  const out=[];
  for(const id of PM_ORDER){
    if(!conf.includes(id)) continue;
    if(id==='claude') out.push(pmRowClaude(u.claude, now));
    if(id==='codex') out.push(pmRowCodex(u.codex, now));
    if(id==='deepseek') out.push(pmRowDeepseek(u.deepseek));
  }
  const rank=r=>r.top==null?-1:r.top;
  return out.sort((a,b)=>(b.id===defEng)-(a.id===defEng) || rank(b)-rank(a) || PM_ORDER.indexOf(a.id)-PM_ORDER.indexOf(b.id));
}
// a do minimizado: a IA padrão (se configurada), senão a 1ª
function pmMain(rows, defEng){ return rows.find(r=>r.id===defEng)||rows[0]||null; }
function pmDot(level){ return `<span class="pm-dot pm-${level}" role="img" aria-label="${PM_LVL_TXT[level]||level}"></span>`; }
const PM_CHEV='<svg class="pm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10l3.5-3.5 3.5 3.5"/></svg>';
function pmBarHtml(name, b, cls){
  const v=Math.round(b.pct);
  return `<span class="${cls||'pm-bar'} pm-${b.level}" role="progressbar" aria-label="${escA(name+' '+b.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-valuetext="${escA(v+' % — '+(PM_LVL_TXT[b.level]||b.level))}"><span class="pm-fill" style="width:${b.pct}%"></span></span>`;
}
function pmIaHtml(r, open){
  const did='pmDet-'+r.id;
  const bars=r.bars.map(b=>`<div class="pm-win"><span class="pm-wl">${esc(b.label)}</span>${pmBarHtml(r.name, b)}<span class="pm-wn pm-${b.level}">${esc(pmPct(b.pct))}</span></div>`).join('');
  return `<div class="pm-ia pm-${r.level}" data-pm-ia="${escA(r.id)}">`
    +`<div class="pm-ia-head"><button class="pm-name" data-pm="cfg" data-pm-id="${escA(r.id)}" title="${escA(r.tip+'\nClique: abrir Sua IA')}">${esc(r.name)}</button>`
    +(r.text?`<span class="pm-txt">${esc(r.text)}</span>`:'<span class="pm-txt"></span>')
    +`<button class="pm-more" data-pm="det" data-pm-id="${escA(r.id)}" aria-expanded="${open}" aria-controls="${did}" aria-label="${escA((open?'Esconder':'Mostrar')+' detalhes do '+r.name)}" title="detalhes">${PM_CHEV}</button></div>`
    +bars
    +(r.sub?`<div class="pm-sub">${esc(r.sub)}</div>`:'')
    +(r.hint===PM_HINT_ON?`<button class="pm-hint" data-pm="cfg" data-pm-id="${escA(r.id)}">${esc(r.hint)}</button>`:r.hint?`<div class="pm-hint">${esc(r.hint)}</div>`:'')
    +`<div class="pm-det" id="${did}"${open?'':' hidden'}>${r.details.map(d=>`<div>${esc(d)}</div>`).join('')}</div>`
    +'</div>';
}
function pmHtml(u, min, defEng, now, err, open){
  open=open||[];
  const isOpen=id=>typeof open.has==='function'?open.has(id):open.includes(id);
  if(!u && err) return `<button class="pm-head pm-empty" data-pm="retry" title="${escA(err)}">${pmDot('idle')}<span class="pm-title">não consegui ler o uso — tentar de novo</span></button>`;
  if(!u) return `<button class="pm-head" data-pm="toggle" aria-expanded="${!min}"><span class="pm-title">Uso do plano</span><span class="pm-sum dim">verificando…</span>${PM_CHEV}</button>`;
  const rows=pmRows(u, now, defEng);
  if(!rows.length) return `<button class="pm-head pm-empty" data-pm="cfg" title="Nenhuma IA pronta — abrir Sua IA">${pmDot('idle')}<span class="pm-title">configure sua IA</span></button>`;
  const main=pmMain(rows, defEng);
  const head=`<button class="pm-head" data-pm="toggle" aria-expanded="${!min}" aria-controls="pmRows" title="${min?'Mostrar o uso de cada IA':'Minimizar'}"><span class="pm-title">${min?esc(main.name):'Uso do plano'}</span>`
    +(min?`<span class="pm-sum pm-${main.level}">${esc(main.short)}</span>`:'<span class="pm-sum"></span>')+PM_CHEV+'</button>';
  const minBar=min && main.topBar?pmBarHtml(main.name, main.topBar, 'pm-bar pm-minbar'):'';
  const list=rows.map(r=>pmIaHtml(r, isOpen(r.id))).join('');
  return head+minBar+`<div class="pm-rows" id="pmRows"${min?' hidden':''}>${list}</div>`;
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
  const html=pmHtml(pmData, min, pmDefEng(), Date.now(), pmErr, pmOpen);
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
    else if(b.dataset.pm==='det'){
      const id=b.dataset.pmId; if(pmOpen.has(id)) pmOpen.delete(id); else pmOpen.add(id);
      pmRender();
      // o redesenho troca o botão: o foco volta pro mesmo "detalhes"
      const f=el.querySelector && el.querySelector(`[data-pm="det"][data-pm-id="${id}"]`); if(f && f.focus) f.focus();
    }
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
