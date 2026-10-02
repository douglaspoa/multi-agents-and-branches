// Starfork — 57-dispositivo
// ===== Painel DISPOSITIVO (spec-dispositivo-no-app) =====
// O Simulador iOS / emulador Android DA TAREFA ao vivo, num painel DOCADO à direita do workspace (como o "Simulador
// de iOS" do Claude Desktop): moldura do aparelho, clique = toque, arrastar = deslizar, teclado = texto, barra de
// botões (Home · marcar · print · vídeo · girar · energia · expandir), menus Dispositivo/Exibição/Debug e FPS.
// Os QUADROS não passam pelo Tauri: o Rust (device.rs) só sobe o espelho do motor (`cardume mobile mirror`, servidor
// local com token) e o front lê `GET /stream` direto: [tipo u8][tamanho u32][dados] — 0 meta, 1 imagem, 2/3 H.264.
// Desempenho (travamento 24/09): o espelho só roda com o painel VISÍVEL (aba da tarefa na frente, janela visível);
// o vigia é um timer de 1 s que só compara booleanos; o painel só é remontado quando a assinatura muda; quadro vai
// direto pro canvas (nada de innerHTML por quadro); imagem nova chegando com outra em decodificação → fica só a última.

const DV={ task:null, open:{}, plat:{}, info:{}, infoAt:{}, _sess:null, sig:'', mark:null, zoom:'fit', expanded:false, rec:{}, logs:null };
// F0 (canvas): a sessão do stream é DA demanda (sess.id). DV.sess só devolve a sessão se ela for da demanda que o
// painel mostra agora — um quadro do stream de A nunca é desenhado com o painel em B (dvSessFor, testada).
Object.defineProperty(DV, 'sess', { get(){ return dvSessFor(DV._sess, DV.task); }, set(v){ DV._sess=v||null; } });
const DV_KIND={ META:0, IMG:1, AU:2, KEY:3 };

// ---------- puras (testadas em app/tests/dispositivo.test.mjs) ----------
function dvSessFor(sess, taskId){ return (sess && taskId && sess.id===taskId) ? sess : null; }
// pedaços do /stream: devolve os completos e o resto (que espera o próximo pedaço da rede)
function dvParseFrames(buf){
  const out=[]; let o=0;
  while(buf.length-o>=5){
    const len=((buf[o+1]<<24)>>>0)+(buf[o+2]<<16)+(buf[o+3]<<8)+buf[o+4];
    if(buf.length-o-5<len) break;
    out.push({ kind:buf[o], data:buf.subarray(o+5, o+5+len) }); o+=5+len;
  }
  return { frames:out, rest:buf.subarray(o) };
}
// codec WebCodecs a partir do SPS (NAL 7) do quadro-chave: avc1.PPCCLL
function dvCodecFromAu(au){
  for(let i=0;i+4<au.length;i++){
    if(au[i]===0&&au[i+1]===0&&(au[i+2]===1||(au[i+2]===0&&au[i+3]===1))){
      const h=i+(au[i+2]===1?3:4);
      if((au[h]&31)===7&&h+3<au.length) return 'avc1.'+[au[h+1],au[h+2],au[h+3]].map(x=>x.toString(16).padStart(2,'0')).join('');
    }
  }
  return null;
}
// ponteiro → posição normalizada (0..1) DENTRO da tela mostrada
function dvNorm(clientX, clientY, rect){
  const c=v=>Math.min(1,Math.max(0,v));
  return { x:c((clientX-rect.left)/Math.max(1,rect.width)), y:c((clientY-rect.top)/Math.max(1,rect.height)) };
}
// área REAL da imagem dentro do canvas (object-fit: contain deixa faixas quando a proporção não bate)
function dvContentRect(r, iw, ih){
  if(!(iw>1&&ih>1)||!r.width||!r.height) return r;
  const k=Math.min(r.width/iw, r.height/ih), w=iw*k, h=ih*k;
  return { left:r.left+(r.width-w)/2, top:r.top+(r.height-h)/2, width:w, height:h };
}
// gesto completo (soltar o botão) → evento pro espelho. Arrasto AO VIVO (Android) manda down/move/up separados.
function dvGesture(a, b, ms, caps, moves){
  const d=Math.hypot(b.x-a.x, b.y-a.y);
  // arrasto ao vivo (Android): o "up" fecha o gesto — mas se quase nenhum movimento saiu (arrasto rápido demais pro
  // ritmo de ~30/s), manda o deslizar inteiro interpolado (senão o aparelho vê só "apertou e soltou longe")
  if(caps&&caps.liveDrag) return (d>=0.012 && (moves||0)<3) ? { t:'swipe', x:a.x, y:a.y, x2:b.x, y2:b.y, ms:Math.max(80, Math.min(2000, Math.round(ms))) } : { t:'up', x:b.x, y:b.y };
  if(d<0.012) return { t:'tap', x:a.x, y:a.y };
  return { t:'swipe', x:a.x, y:a.y, x2:b.x, y2:b.y, ms:Math.max(80, Math.min(2000, Math.round(ms))) };
}
// retângulo marcado (normalizado) → texto pro agente: plataforma, aparelho, coordenadas na unidade do aparelho e em %
function dvMarkMessage(o){
  const r=o.rect, s=o.screen||{}, ios=o.plat==='ios', k=ios?Math.max(1,s.ptScale||1):1;
  const W=Math.round((s.w||0)/k), H=Math.round((s.h||0)/k), u=ios?'pt':'px';
  const px=v=>Math.round(v), pct=v=>Math.round(v*100);
  const where = W&&H
    ? `x ${px(r.x*W)}–${px((r.x+r.w)*W)}, y ${px(r.y*H)}–${px((r.y+r.h)*H)} ${u} (tela ${W}×${H} ${u})`
    : `x ${pct(r.x)}%–${pct(r.x+r.w)}%, y ${pct(r.y)}%–${pct(r.y+r.h)}%`;
  return `Ajuste de design no app — ${ios?'iOS':'Android'}${o.device?' · '+o.device:''}${o.screenName?' · tela "'+o.screenName+'"':''}:\n`+
    `${String(o.instr||'').trim()}\n\n`+
    `Área marcada: ${where} — ${pct(r.x)}%–${pct(r.x+r.w)}% da largura, ${pct(r.y)}%–${pct(r.y+r.h)}% da altura. `+
    `O recorte e a tela inteira estão anexados. Depois de mudar, prove com um print novo (cardume mobile shot).`;
}
function dvDeviceLabel(info, plat){
  const d=info&&info[plat]; if(!d) return '';
  if(plat==='ios') return d.device?`${d.device}${d.runtime?' · '+d.runtime:''}`:((d.options||[])[0]||{}).label||'iPhone';
  return d.avd||((d.options||[])[0]||{}).label||'Android';
}
// HTML do painel (estrutura; o canvas é desenhado à parte). s: { plat, info, up, busy, caps, rec, zoom, expanded, mark, starting, err }
function dvPanelHtml(s){
  const info=s.info||{}, plats=info.platforms||[], plat=s.plat, d=(info[plat])||{};
  const opts=(d.options||[]);
  const cur=plat==='ios'?(d.deviceType||((opts[0]||{}).id)):(d.avd||'');
  // aparelho atual fora da lista (AVD padrão não criado, emulador da pessoa): opção vazia = "o padrão" — nunca liga
  // outro AVD por engano só porque ele é o 1º da lista
  const blank=!opts.some(o=>o.id===cur)?`<option value="" selected>${esc(plat==='android'?(d.serial&&!d.avd?'emulador já ligado':'padrão (starfork-pixel)'):'padrão')}</option>`:'';
  const sel=opts.length?`<select class="dvsel" id="dvSel" title="trocar o aparelho (recria o simulador desta tarefa)"${s.busy?' disabled':''}>${blank}${opts.map(o=>`<option value="${escA(o.id)}"${o.id===cur?' selected':''}>${esc(o.label)}</option>`).join('')}</select>`:`<span class="dvsel dim">${esc(dvDeviceLabel(info, plat)||'—')}</span>`;
  const tabs=plats.length>1?`<span class="dvplats" role="tablist">${plats.map(p=>`<button role="tab" class="dvplat${p===plat?' on':''}" data-dvplat="${p}" aria-selected="${p===plat}">${p==='ios'?'iOS':'Android'}</button>`).join('')}</span>`:'';
  const caps=s.caps||{}, up=!!s.up, ro=!!s.busy||(plat==='ios'&&caps.touch===false);
  const b=(id,ic,label,dis,on)=>`<button class="dvb${on?' on':''}" id="${id}" title="${escA(label)}" aria-label="${escA(label)}"${dis?' disabled':''}>${ic}</button>`;
  const screen = !up
    ? `<div class="dvoff"><div class="dvoffic">${DV_IC.power}</div><div>${s.starting?'<span class="spin"></span> ligando… (o 1º boot leva ~30 s)':`${plat==='ios'?'Simulador iOS':'Emulador Android'} desta tarefa desligado`}</div>${s.starting?'':'<button class="btn primary sm" id="dvPowerOn">ligar</button>'}${s.err?`<div class="dverr">${esc(s.err)}</div>`:''}</div>`
    : `<div class="dvframe ${plat}${s.zoom&&s.zoom!=='fit'?' z'+s.zoom:''}" id="dvFrame"><span class="dvside l1"></span><span class="dvside l2"></span><span class="dvside r1"></span><div class="dvscreen" id="dvScreen" tabindex="0" aria-label="tela do aparelho — clique toca, arraste desliza, digite pra escrever"><canvas id="dvCanvas" width="1" height="1"></canvas><div class="dvmarkbox" id="dvMarkBox" hidden></div><div class="dvwait" id="dvWait"><span class="spin"></span> conectando à tela…</div></div></div>`;
  const ro_note = up&&s.busy ? `<div class="dvro">${DV_IC.eye} ${esc(s.busy)}</div>`
    : up&&plat==='ios'&&caps.touch===false ? `<div class="dvro">${DV_IC.eye} só visualização — ${esc((d.touchFix)||'instale o AXe pra tocar')}</div>` : '';
  const markForm = s.mark&&s.mark.rect ? `<div class="dvmarkf"><div class="dvmarkh">${DV_IC.pencil} O que mudar nesta área?</div><textarea class="in" id="dvMarkTx" rows="3" placeholder="ex.: este botão está colado na borda — dê 16 px de respiro e use a cor de destaque"></textarea><div class="dvmarkr"><span class="dim">vai pro chat da tarefa com o recorte + a tela inteira</span><span style="flex:1"></span><button class="btn sm" id="dvMarkCancel">cancelar</button><button class="btn primary sm" id="dvMarkSend">enviar pro chat</button></div></div>` : '';
  return `<div class="dvresize" id="dvResize" title="Redimensionar" aria-label="Redimensionar"></div>`+
    `<div class="dvhead"><span class="dvtitle">${DV_IC.phone} Dispositivo</span>${tabs}<span style="flex:1"></span><span class="dvfps" id="dvFps" title="quadros por segundo que chegaram agora (tela parada = 0)">FPS: 0</span><button class="dvhb" id="dvExpand" title="${s.expanded?'voltar ao painel':'expandir'}" aria-label="expandir">${s.expanded?DV_IC.shrink:DV_IC.expand}</button><button class="dvhb" id="dvClose" title="fechar o painel" aria-label="fechar o painel">${IC.xs}</button></div>`+
    `<div class="dvbar">${sel}<span class="dvmenus"><button class="dvmenu" data-dvmenu="disp">Dispositivo ▾</button><button class="dvmenu" data-dvmenu="exib">Exibição ▾</button><button class="dvmenu" data-dvmenu="debug">Debug ▾</button></span></div>`+
    `<div class="dvpop" id="dvPop" hidden></div>`+
    `<div class="dvbody">${screen}</div>${ro_note}${markForm}`+
    (s.logs!=null?`<div class="dvlogs"><div class="dvlogsh"><b>Logs do app</b> <span class="dim">(últimos 2 min — avisos e erros)</span><span style="flex:1"></span><button class="dvhb" id="dvLogsX" aria-label="fechar os logs">${IC.xs}</button></div><pre class="mono">${esc(s.logs||'(nada)')}</pre></div>`:'')+
    `<div class="dvtools">`+
      b('dvHome', DV_IC.home, 'Home', !up||ro)+
      (plat==='android'?b('dvBack', DV_IC.back, 'Voltar', !up||ro):'')+
      b('dvMark', DV_IC.pencil, s.mark?'cancelar a marcação':'marcar uma área e pedir a mudança no chat', !up, !!s.mark)+
      b('dvShot', DV_IC.camera, 'tirar print (vira prova da tarefa)', !up||(plat==='android'&&!!s.busy))+
      b('dvRec', s.rec?DV_IC.stop:DV_IC.video, s.rec?'parar a gravação':'gravar vídeo (vira prova da tarefa)', !up||(plat==='android'&&!!s.busy), !!s.rec)+
      b('dvRotate', DV_IC.rotate, plat==='ios'?'girar: o Simulador iOS não gira por linha de comando — use o Simulator.app (⌘→)':'girar', !up||plat==='ios'||ro)+
      b('dvPower', DV_IC.power, s.busy?'o agente está usando — espere o turno terminar':up?'desligar':'ligar', !!s.starting||!!s.busy)+
      b('dvPop2', s.expanded?DV_IC.shrink:DV_IC.expand, s.expanded?'voltar ao painel':'expandir o painel', false)+
    `</div>`;
}
const DV_IC={
  phone:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.6"/><path d="M7 12.3h2" stroke-linecap="round"/></svg>',
  home:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.8 7.4 8 3l5.2 4.4M4.4 6.2v6.6h7.2V6.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.8 3.6 5.4 8l4.4 4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pencil:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><path d="M10.6 2.9l2.5 2.5-7.4 7.4-3 .5.5-3z" stroke-linejoin="round"/><path d="M9.3 4.2l2.5 2.5"/></svg>',
  camera:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><path d="M2.4 5.6c0-.6.5-1.1 1.1-1.1h1.7l1-1.5h3.6l1 1.5h1.7c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3.5c-.6 0-1.1-.5-1.1-1.1z" stroke-linejoin="round"/><circle cx="8" cy="8.6" r="2.3"/></svg>',
  video:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><rect x="2.2" y="4.2" width="8.4" height="7.6" rx="1.4"/><path d="M10.6 7l3.2-1.9v5.8L10.6 9" stroke-linejoin="round"/></svg>',
  stop:'<svg viewBox="0 0 16 16"><rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" fill="currentColor"/></svg>',
  rotate:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12.6 7.2A4.7 4.7 0 1 0 11.3 11.6" stroke-linecap="round"/><path d="M12.8 3.6v3.8H9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  power:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2.4v5.2" stroke-linecap="round"/><path d="M5 4.4a4.8 4.8 0 1 0 6 0" stroke-linecap="round"/></svg>',
  expand:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.6 2.8h3.6v3.6M6.4 13.2H2.8V9.6M13.2 2.8 9 7M2.8 13.2 7 9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shrink:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 7H9V3M3 9h4v4M9 7l4.2-4.2M7 9l-4.2 4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
};

// ---------- integração com o workspace ----------
// o painel pode morar na tela da demanda (#fwDev, docado) ou numa ABA "Simulador" do topo (DV.host, 58-canvas)
function dvEl(){ return DV.host || $id('fwDev'); }
function dvKey(id){ return 'dev:'+id+'@'+(typeof CV_REALM!=='undefined'?CV_REALM:'main'); }
function dvIsOpen(taskId){ return !!DV.open[taskId]; }
// chamado no fim de cada renderWorkspace: barato (só mexe no botão e na classe; o painel tem guarda própria)
function dvSync(t){
  if(!t) return;
  const btn=$id('fwDevBtn');
  if(DV.task!==t.id){ DV.task=t.id; DV.fails=0; DV.retryAt=0; if(DV.open[t.id]===undefined) DV.open[t.id]=lsGet('dv:open:'+t.id)==='1'; dvStopStream(); DV.sig=''; DV.mark=null; DV.logs=null; }
  const info=DV.info[t.id];
  // 1ª vez; depois só com o painel ABERTO num projeto mobile (de minuto em minuto) — projeto web não paga nada
  if(info===undefined || (info.mobile && dvIsOpen(t.id) && Date.now()-(DV.infoAt[t.id]||0)>60000 && !DV.loadingInfo)) dvLoadInfo(t.id);
  const mob=!!(info&&info.mobile&&(info.platforms||[]).length);
  if(btn){ btn.style.display=mob?'':'none'; btn.classList.toggle('on', mob&&dvIsOpen(t.id)); if(!btn.__dv){ btn.__dv=1; btn.onclick=()=>dvToggle(); } }
  const el=dvEl(); if(!el) return;
  const show=mob&&(DV.forced===t.id||dvIsOpen(t.id)); // aba Simulador do topo: sempre aberto
  if(el.hidden===show) el.hidden=!show;
  $id('fwRow')&&$id('fwRow').classList.toggle('dvexp', show&&DV.expanded);
  if(show) dvRender(); else dvStopStream();
}
async function dvLoadInfo(taskId, force){
  if(DV.loadingInfo===taskId && !force) return;
  DV.loadingInfo=taskId; DV.infoAt[taskId]=Date.now();
  try{
    const raw=await invoke('device_cli',{ taskId, sub:'info', flags:[] });
    const line=String(raw||'').split('\n').reverse().find(l=>l.trim().startsWith('{'));
    DV.info[taskId]=line?JSON.parse(line):{ mobile:false };
  }catch(e){ DV.info[taskId]=DV.info[taskId]||{ mobile:false, err:String(e&&e.message||e) }; }
  finally{ if(DV.loadingInfo===taskId) DV.loadingInfo=null; }
  const info=DV.info[taskId];
  if(info && info.mobile && !DV.plat[taskId]){
    // plataforma inicial: a que já está ligada › a lembrada › a 1ª do projeto
    const up=(info.platforms||[]).find(p=>info[p]&&info[p].up), mem=lsGet('dv:plat:'+taskId);
    DV.plat[taskId]=up||((info.platforms||[]).includes(mem)?mem:(info.platforms||[])[0]);
  }
  if(DV.task===taskId){ DV.sig=''; const t=(state.tasks||[]).find(x=>x.id===taskId); if(t) dvSync(t); }
}
function dvToggle(force){
  const id=DV.task; if(!id) return;
  DV.open[id]=force!=null?!!force:!DV.open[id]; lsSet('dv:open:'+id, DV.open[id]?'1':'0');
  if(!DV.open[id]){ dvStopStream(); DV.expanded=false; }
  DV.sig='';
  const t=(state.tasks||[]).find(x=>x.id===id); if(t) dvSync(t);
}
function dvCur(){ const id=DV.task, info=DV.info[id]||{}, plat=DV.plat[id]; const d=info[plat]||{}; return { id, info, plat, d }; }
function dvView(){ // o que o painel mostra agora (entra na assinatura — muda → remonta)
  const { id, info, plat, d }=dvCur(); const s=DV.sess;
  return { plat, info, up:!!d.up, busy:(s&&s.busy)||(plat==='android'?d.busyBy&&('o '+d.busyBy+' está usando o emulador — só visualização'):null)||null,
    caps:(s&&s.caps)||{ touch:plat==='android'||d.touch!==false, liveDrag:plat==='android' }, rec:!!DV.rec[id+'|'+plat], zoom:DV.zoom, expanded:DV.expanded,
    mark:DV.mark, starting:!!DV.starting, err:DV.err||'', logs:DV.logs };
}
function dvRender(){
  const el=dvEl(); if(!el||el.hidden) return;
  const v=dvView();
  const sig=JSON.stringify([DV.task, v.plat, v.up, v.busy, v.caps, v.rec, v.zoom, v.expanded, !!(v.mark&&v.mark.rect), !!v.mark, v.starting, v.err, v.logs!=null, (v.info[v.plat]||{}).deviceType, (v.info[v.plat]||{}).avd, ((v.info[v.plat]||{}).options||[]).length]);
  if(sig!==DV.sig){
    const keepTx=($id('dvMarkTx')||{}).value, oldCv=$id('dvCanvas');
    DV.sig=sig; el.innerHTML=dvPanelHtml(v); dvWire(v);
    if(keepTx&&$id('dvMarkTx')) $id('dvMarkTx').value=keepTx;
    const w=+lsGet('dvWidth')||360; el.style.setProperty('--dvw', Math.min(760, Math.max(280, w))+'px');
    // canvas novo: herda o último quadro (com a tela parada nenhum quadro novo chega pra repintar)
    const cvKey=DV.task+'|'+v.plat;
    if(oldCv && oldCv.width>1 && $id('dvCanvas') && DV.cvKey===cvKey) dvDraw(oldCv);
    DV.cvKey=cvKey;
  }
  dvWatch();
}
// vigia barato: decide se o espelho deve rodar (painel aberto + aba da tarefa na frente + janela visível)
function dvShouldRun(){
  const el=dvEl(); const v=DV.task&&dvCur();
  if(DV.pausedBy) return false; // outro painel pegou o stream (teto de 1): só volta com um clique aqui
  const onScreen=DV.host ? !!(DV.host.isConnected && DV.host.offsetParent!==null) : (typeof fwVisible==='function' && fwVisible());
  return !!(el && !el.hidden && v && v.d && v.d.up && onScreen && document.visibilityState==='visible' && !DV.starting);
}
// falhou (espelho não subiu, stream caiu com erro): espera 1 s, 2 s, 4 s… até 30 s antes de tentar de novo — sem
// isso o vigia de 1 s religava um processo por segundo (boot do emulador, simulador sumido)
function dvFail(){ DV.fails=(DV.fails||0)+1; DV.retryAt=Date.now()+Math.min(30000, 1000*Math.pow(2, DV.fails-1)); }
function dvOk(){ if(DV.fails){ DV.fails=0; DV.retryAt=0; } if(DV.err){ DV.err=''; } }
// vigia SEM laço (F0 do canvas — antes um setInterval de 1 s): reavalia quando algo muda (render do painel, troca de
// aba do app via cvOnViewChange, janela visível/escondida, fim do stream). Esperando a próxima tentativa (espera
// crescente), arma UM setTimeout pro momento certo.
function dvCheckRun(){
  const run=dvShouldRun();
  if(run && !DV.sess){
    if(DV._sess) dvStopStream(); // sobra de outra demanda: nunca dois streams
    const wait=(DV.retryAt||0)-Date.now();
    clearTimeout(DV.retryT); DV.retryT=0;
    if(wait<=0) dvStartStream(); else DV.retryT=setTimeout(dvCheckRun, wait+20);
  } else if(!run && DV._sess) dvStopStream();
}
function dvWatch(){ dvCheckRun(); }
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState!=='visible') dvStopStream(); else dvCheckRun(); });

// ---------- espelho (stream) ----------
async function dvStartStream(){
  const { id, plat }=dvCur(); if(!id||!plat) return;
  const sess={ id, plat, ctl:new AbortController(), fpsN:0, fpsAt:performance.now(), busy:null, caps:null, meta:null, decoding:false, pendingImg:null, dec:null, codec:null };
  if(DV._sess) dvStopStream();
  DV.sess=sess;
  // teto do app: 1 stream vivo (gerente de recursos) — se outro estiver vivo, ele congela
  if(typeof cvRmTake==='function') cvRmTake('stream', dvKey(id), ()=>{ if(DV._sess===sess){ dvStopStream(); DV.pausedBy=Date.now(); DV.sig=''; dvRender(); dvToastOnce('o simulador foi aberto em outro painel — clique na tela dele aqui pra continuar'); } }); // teto 1: não briga de volta sozinho
  let m;
  try{ m=await invoke('device_mirror_start',{ taskId:id, platform:plat }); }
  catch(e){ if(DV.sess===sess){ DV.sess=null; DV.err=errShortDv(e); dvFail(); dvToastOnce(DV.err); DV.sig=''; dvRender(); } return; }
  if(DV.sess!==sess) return;
  sess.base=m.url; sess.tok=m.token;
  dvPollState(sess);
  sess.stateTimer=setInterval(()=>dvPollState(sess), 3000);
  sess.fpsTimer=setInterval(()=>{ const now=performance.now(), f=$id('dvFps'); if(f){ const v=Math.round(sess.fpsN*1000/Math.max(1,now-sess.fpsAt)); const tx='FPS: '+v; if(f.textContent!==tx) f.textContent=tx; } sess.fpsN=0; sess.fpsAt=now; }, 1000);
  const webcodecs=typeof VideoDecoder!=='undefined';
  try{
    const r=await fetch(`${sess.base}/stream?t=${sess.tok}${plat==='android'&&!webcodecs?'&codec=image':''}`, { signal:sess.ctl.signal });
    const rd=r.body.getReader(); let buf=new Uint8Array(0);
    for(;;){
      const { value, done }=await rd.read(); if(done) break;
      if(DV.sess!==sess) break;
      const nb=new Uint8Array(buf.length+value.length); nb.set(buf); nb.set(value, buf.length);
      const { frames, rest }=dvParseFrames(nb); buf=rest.slice();
      for(const f of frames) dvOnFrame(sess, f);
    }
  }catch(e){ if(e&&e.name!=='AbortError') console.warn('espelho do dispositivo', e); }
  // caiu sozinho (servidor saiu/aparelho desligou/erro): o vigia religa com espera crescente se ainda deve rodar
  if(DV.sess===sess){ if(!sess.fpsTotal) dvFail(); dvStopStream(); setTimeout(()=>{ if(DV.task===id) dvLoadInfo(id, true); }, 300); }
}
function errShortDv(e){ return String(e&&e.message||e||'').replace(/^✕\s*/,'').split('\n')[0].slice(0,220); }
function dvStopStream(){
  const s=DV._sess; if(!s) return; // a sessão crua (pode ser de outra demanda — é justamente a que precisa parar)
  DV.sess=null;
  if(typeof cvRmDrop==='function') cvRmDrop('stream', dvKey(s.id));
  try{ s.ctl.abort(); }catch(_){ }
  clearInterval(s.stateTimer); clearInterval(s.fpsTimer);
  try{ if(s.dec && s.dec.state!=='closed') s.dec.close(); }catch(_){ }
  // o servidor para a captura sozinho ao perder o cliente; o processo sai depois de 60 s ocioso
}
async function dvPollState(sess){
  try{
    const r=await fetch(`${sess.base}/state?t=${sess.tok}`); const j=await r.json();
    if(DV.sess!==sess) return;
    const busy=j.busy||null, caps={ touch:!!j.touch, liveDrag:!!j.liveDrag, rotate:!!j.rotate };
    const recK=sess.id+'|'+sess.plat, rec=!!(j.rec&&j.rec.plat===sess.plat);
    if(busy!==sess.busy || JSON.stringify(caps)!==JSON.stringify(sess.caps) || rec!==!!DV.rec[recK]){ sess.busy=busy; sess.caps=caps; DV.rec[recK]=rec; dvRender(); }
  }catch(_){ }
}
function dvOnFrame(sess, f){
  if(f.kind===DV_KIND.META){
    let j={}; try{ j=JSON.parse(new TextDecoder().decode(f.data)); }catch(_){ }
    if(j.error){ DV.err=j.error; dvToastOnce(j.error); DV.sig=''; dvRender(); return; }
    sess.meta=j; return;
  }
  if(f.kind===DV_KIND.IMG){
    // decodificação em andamento → guarda só o MAIS NOVO (nada de fila crescendo)
    if(sess.decoding){ sess.pendingImg=f.data; return; }
    const go=(data)=>{ sess.decoding=true;
      createImageBitmap(new Blob([data])).then(bmp=>{ if(DV.sess===sess){ dvDraw(bmp); sess.fpsN++; dvOk(); } if(bmp.close) bmp.close(); })
        .catch(()=>{}).finally(()=>{ sess.decoding=false; const p=sess.pendingImg; sess.pendingImg=null; if(p&&DV.sess===sess) go(p); }); };
    go(f.data); return;
  }
  // H.264 (Android) → WebCodecs
  const key=f.kind===DV_KIND.KEY;
  if(key){ const codec=dvCodecFromAu(f.data); if(codec && codec!==sess.codec){ try{ if(sess.dec) sess.dec.close(); }catch(_){ }
      sess.codec=codec;
      sess.dec=new VideoDecoder({ output:(vf)=>{ if(DV.sess===sess){ dvDraw(vf); sess.fpsN++; dvOk(); } vf.close(); }, error:(e)=>{ console.warn('decodificador', e); sess.codec=null; try{ sess.ctl.abort(); }catch(_){ } } }); // erro → reconecta (o servidor recomeça o vídeo com quadro-chave)
      sess.dec.configure({ codec, optimizeForLatency:true }); } }
  if(!sess.dec || sess.dec.state!=='configured') return;
  if(!key && sess.needKey) return;
  try{ sess.dec.decode(new EncodedVideoChunk({ type:key?'key':'delta', timestamp:(sess.ts=(sess.ts||0)+33333), data:f.data })); sess.needKey=false; }
  catch(_){ sess.needKey=true; }
}
function dvDraw(src){
  if(DV.sess) DV.sess.fpsTotal=(DV.sess.fpsTotal||0)+1;
  const cv=$id('dvCanvas'); if(!cv||cv===src) return;
  const w=src.displayWidth||src.width, h=src.displayHeight||src.height; if(!w||!h) return;
  if(cv.width!==w||cv.height!==h){ cv.width=w; cv.height=h; const fr=$id('dvFrame'); if(fr){ fr.style.setProperty('--ar', w+'/'+h); fr.classList.toggle('land', w>h); } } // deitado: a moldura vira pela largura
  cv.getContext('2d').drawImage(src, 0, 0);
  const wt=$id('dvWait'); if(wt && !wt.hidden) wt.hidden=true;
}

// ---------- entrada ----------
async function dvPost(path, body){
  const s=DV.sess; if(!s||!s.base) throw new Error('a tela ainda não conectou');
  const r=await fetch(`${s.base}${path}?t=${s.tok}`, { method:'POST', body:JSON.stringify(body) }); // text/plain: sem preflight
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?(j.error+(j.fix?' — '+j.fix:'')):'falhou');
  return j;
}
// em ORDEM (down → moves → up): cada toque espera o anterior; erro repetido não vira enxurrada de avisos
let dvInputQ=Promise.resolve();
function dvInput(ev){ dvInputQ=dvInputQ.then(()=>dvPost('/input', ev)).catch(e=>dvToastOnce(errShortDv(e))); return dvInputQ; }
function dvToastOnce(msg){ if(!msg || (DV.lastToast===msg && Date.now()-(DV.lastToastAt||0)<15000)) return; DV.lastToast=msg; DV.lastToastAt=Date.now(); toast(msg, 'warn'); }
function dvWireScreen(v){
  const sc=$id('dvScreen'), cv=$id('dvCanvas'); if(!sc||!cv) return;
  let down=null, lastMove=0, moves=0;
  const pos=e=>dvNorm(e.clientX, e.clientY, dvContentRect(cv.getBoundingClientRect(), cv.width, cv.height));
  const ro=()=>!!(DV.sess&&DV.sess.busy) || (v.plat==='ios'&&v.caps.touch===false);
  sc.onpointerdown=(e)=>{
    if(e.button!==0) return; sc.focus({ preventScroll:true });
    const p=pos(e); down={ p, t:performance.now() }; sc.setPointerCapture(e.pointerId);
    if(DV.mark){ DV.mark.start=p; DV.mark.rect=null; dvPaintMark({ x:p.x, y:p.y, w:0, h:0 }); return; }
    if(ro()) return;
    moves=0;
    if(v.caps.liveDrag) dvInput({ t:'down', x:p.x, y:p.y });
  };
  sc.onpointermove=(e)=>{
    if(!down) return; const p=pos(e);
    if(DV.mark&&DV.mark.start){ const a=DV.mark.start; dvPaintMark({ x:Math.min(a.x,p.x), y:Math.min(a.y,p.y), w:Math.abs(p.x-a.x), h:Math.abs(p.y-a.y) }); return; }
    if(ro()||!v.caps.liveDrag) return;
    const now=performance.now(); if(now-lastMove<33) return; lastMove=now; // ~30 movimentos/s
    moves++; dvInput({ t:'move', x:p.x, y:p.y });
  };
  sc.onpointerup=(e)=>{
    if(!down) return; const p=pos(e), d0=down; down=null;
    if(DV.mark&&DV.mark.start){ const a=DV.mark.start; const r={ x:Math.min(a.x,p.x), y:Math.min(a.y,p.y), w:Math.abs(p.x-a.x), h:Math.abs(p.y-a.y) };
      DV.mark.start=null; if(r.w<0.02||r.h<0.01){ dvPaintMark(null); return; } DV.mark.rect=r; DV.sig=''; dvRender(); dvPaintMark(r); setTimeout(()=>{ const tx=$id('dvMarkTx'); if(tx) tx.focus(); }, 30); return; }
    if(ro()) return;
    dvInput(dvGesture(d0.p, p, performance.now()-d0.t, v.caps, moves));
  };
  // teclado: letras juntam num texto (envio a cada ~120 ms); teclas especiais vão sozinhas
  let txt='', tm=null;
  const flush=()=>{ const s=txt; txt=''; tm=null; if(s) dvInput({ t:'text', text:s }); };
  sc.onkeydown=(e)=>{
    if(DV.mark||ro()) return;
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    const map={ Backspace:'backspace', Enter:'enter', Tab:'tab', Escape:'escape' };
    e.stopPropagation(); // Esc aqui não fecha a aba da tarefa
    if(map[e.key]){ e.preventDefault(); flush(); dvInput({ t:'key', key:map[e.key] }); return; }
    if(e.key.length===1){ e.preventDefault(); txt+=e.key; clearTimeout(tm); tm=setTimeout(flush, 120); }
  };
}
function dvPaintMark(r){
  const box=$id('dvMarkBox'), cv=$id('dvCanvas'), sc=$id('dvScreen'); if(!box) return;
  if(!r){ box.hidden=true; return; }
  // em pixels da área real da imagem (mesmo cálculo do toque)
  const sr=sc.getBoundingClientRect(), c=dvContentRect(cv.getBoundingClientRect(), cv.width, cv.height);
  box.hidden=false; Object.assign(box.style, { left:(c.left-sr.left+r.x*c.width)+'px', top:(c.top-sr.top+r.y*c.height)+'px', width:(r.w*c.width)+'px', height:(r.h*c.height)+'px' });
}

// ---------- marcar → chat ----------
async function dvBlobB64(blob){ return attFileToB64(new File([blob], 'x.png', { type:'image/png' })); }
async function dvMarkSend(){
  const { id, plat, info }=dvCur(); const m=DV.mark, s=DV.sess;
  const instr=(($id('dvMarkTx')||{}).value||'').trim();
  if(!m||!m.rect) return; if(!instr){ toast('escreva o que mudar nesta área', 'warn'); return; }
  if(!s||!s.base){ toast('a tela ainda não conectou', 'warn'); return; }
  const btn=$id('dvMarkSend'); if(btn) btn.disabled=true;
  try{
    // tela inteira em resolução cheia (não a do espelho) + recorte da área
    const full=await (await fetch(`${s.base}/snapshot?t=${s.tok}`)).blob();
    const bmp=await createImageBitmap(full);
    const r=m.rect, cx=Math.round(r.x*bmp.width), cy=Math.round(r.y*bmp.height), cw=Math.max(1,Math.round(r.w*bmp.width)), ch=Math.max(1,Math.round(r.h*bmp.height));
    const cv=document.createElement('canvas'); cv.width=cw; cv.height=ch; cv.getContext('2d').drawImage(bmp, cx, cy, cw, ch, 0, 0, cw, ch);
    const crop=await new Promise(res=>cv.toBlob(res, 'image/png'));
    const bw=bmp.width, bh=bmp.height; if(bmp.close) bmp.close();
    const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    const atts=[];
    for(const [name, blob] of [[`dispositivo-${plat}-${ts}-recorte.png`, crop], [`dispositivo-${plat}-${ts}-tela.png`, full]])
      atts.push(await invoke('import_attachment_data',{ name, dataB64:await dvBlobB64(blob), taskId:id }));
    const screen=(s.meta&&s.meta.w)?{ w:s.meta.w, h:s.meta.h, ptScale:s.meta.ptScale }:{ w:bw, h:bh, ptScale:plat==='ios'?3:1 };
    const text=dvMarkMessage({ instr, plat, device:dvDeviceLabel(info, plat), rect:r, screen })+attPromptBlock(atts);
    const ok=await fwSendText(id, text);
    if(ok){ DV.mark=null; DV.sig=''; dvRender(); toast('enviado pro chat da tarefa', 'ok'); }
  }catch(e){ showErr(e, 'Não consegui enviar a marcação'); }
  finally{ const b=$id('dvMarkSend'); if(b) b.disabled=false; }
}

// ---------- ações ----------
async function dvAction(name, value){
  try{ const j=await dvPost('/action', { name, value:value||'' }); return j; }
  catch(e){ toast(errShortDv(e), 'warn'); return null; }
}
async function dvPower(on, device){
  const { id, plat }=dvCur(); if(!id) return;
  if(!on){
    const msg=plat==='ios'?'Desligar o Simulador iOS desta tarefa?\n\nEle é APAGADO (é só desta tarefa) — ligar de novo cria outro em ~30 s. O agente também consegue ligar quando precisar.':'Desligar o emulador Android?\n\nSe outra tarefa estiver usando, ele continua ligado pra ela.';
    if(!await askYes(msg, 'Desligar')) return;
  }
  dvStopStream(); try{ await invoke('device_mirror_stop',{ taskId:id, platform:plat }); }catch(_){ }
  DV.starting=on; DV.err=''; DV.fails=0; DV.retryAt=0; DV.sig=''; dvRender();
  try{
    // só manda o modelo quando ele MUDA (no iOS um modelo diferente recria o simulador da tarefa)
    const cur=((DV.info[id]||{})[plat]||{}), same=plat==='ios'?device===cur.deviceType:device===(cur.avd||'starfork-pixel');
    const flags=[['platform', plat]]; if(on && device && !same) flags.push(plat==='ios'?['device', device]:['avd', device]);
    await invoke('device_cli',{ taskId:id, sub:on?'up':'down', flags });
  }catch(e){ DV.err=errShortDv(e); }
  DV.starting=false; await dvLoadInfo(id, true);
}
function dvMenu(kind, anchor){
  const pop=$id('dvPop'); if(!pop) return;
  if(!pop.hidden && pop.dataset.k===kind){ pop.hidden=true; return; }
  const v=dvView(), up=v.up, ios=v.plat==='ios', ro=!!v.busy, noTouch=ios&&v.caps.touch===false;
  const it=(k,l,dis)=>`<button class="dvpi" data-dvi="${k}"${dis?' disabled':''}>${esc(l)}</button>`;
  const M={
    disp:[it('power', up?'Desligar':'Ligar', ro), it('rotate','Girar', !up||ios||ro||noTouch), it('home','Home', !up||ro||noTouch), ios?'':it('back','Voltar', !up||ro), it('lock','Bloquear / tela', !up||ro||noTouch), ios?it('shake','Chacoalhar (menu de dev do React Native)', !up):''],
    exib:[it('z:fit','Caber no painel'), it('z:100','100 %'), it('z:75','75 %'), it('z:50','50 %'), '<hr>', it('ap:light','Tema claro', !up||ro), it('ap:dark','Tema escuro', !up||ro)],
    debug:[it('url','Abrir URL / deep link…', !up||ro), it('logs','Logs do app', !up), ios?it('sb:on','Barra de status 9:41 (prints limpos)', !up):'', ios?it('sb:off','Barra de status normal', !up):''],
  };
  pop.innerHTML=(M[kind]||[]).join(''); pop.dataset.k=kind; pop.hidden=false;
  const r=anchor.getBoundingClientRect(), pr=dvEl().getBoundingClientRect();
  pop.style.top=(r.bottom-pr.top+4)+'px';
  // não passa da borda direita do painel (o painel corta o que sobra)
  pop.style.left=Math.max(6, Math.min(r.left-pr.left, pr.width-pop.offsetWidth-6))+'px';
  pop.querySelectorAll('[data-dvi]').forEach(b=>b.onclick=async()=>{ pop.hidden=true; const k=b.dataset.dvi;
    if(k==='power') return dvPower(!up);
    if(k==='rotate') return dvAction('rotate');
    if(k==='home'||k==='back'||k==='lock') return dvInput({ t:'button', name:k });
    if(k==='shake') return dvAction('shake');
    if(k.startsWith('z:')){ DV.zoom=k.slice(2); DV.sig=''; return dvRender(); }
    if(k.startsWith('ap:')) return dvAction('appearance', k.slice(3));
    if(k.startsWith('sb:')) return dvAction('statusbar', k.slice(3));
    if(k==='url'){ const u=await askText('Abrir no aparelho', 'exp://127.0.0.1:8081 ou meuapp://tela', ''); if(u) dvAction('openurl', u.trim()); return; }
    if(k==='logs'){ DV.logs='carregando…'; DV.sig=''; dvRender(); const j=await dvAction('logs'); DV.logs=j?(j.text||''):null; DV.sig=''; dvRender(); }
  });
}
function dvWire(v){
  const { id, plat }=dvCur();
  { const el=dvEl(); if(el && !el.__dvResume){ el.__dvResume=1; el.addEventListener('pointerdown', ()=>{ if(DV.pausedBy){ DV.pausedBy=0; dvCheckRun(); } }, true); } }
  bindClick('dvClose', ()=>dvToggle(false));
  const exp=()=>{ DV.expanded=!DV.expanded; DV.sig=''; const t=(state.tasks||[]).find(x=>x.id===id); if(t) dvSync(t); };
  bindClick('dvExpand', exp); bindClick('dvPop2', exp);
  bindClick('dvPowerOn', ()=>dvPower(true, ($id('dvSel')||{}).value));
  bindClick('dvPower', ()=>dvPower(!v.up, ($id('dvSel')||{}).value));
  bindClick('dvHome', ()=>dvInput({ t:'button', name:'home' }));
  bindClick('dvBack', ()=>dvInput({ t:'button', name:'back' }));
  bindClick('dvRotate', ()=>dvAction('rotate'));
  bindClick('dvShot', async(e)=>{ const b=e.currentTarget; b.disabled=true; const j=await dvAction('shot'); b.disabled=false;
    if(j&&j.file){ toast('print salvo nas provas: '+j.file, 'ok'); if(typeof artifactsCache!=='undefined') delete artifactsCache[id]; } });
  bindClick('dvRec', async(e)=>{ const b=e.currentTarget, k=id+'|'+plat, on=!!DV.rec[k]; b.disabled=true;
    const j=await dvAction('rec', on?'stop':'start'); b.disabled=false;
    if(j){ DV.rec[k]=!on; DV.sig=''; dvRender(); if(on&&j.file){ toast('vídeo salvo nas provas: '+j.file, 'ok'); if(typeof artifactsCache!=='undefined') delete artifactsCache[id]; } else if(!on) toast('gravando — clique de novo pra parar', 'info'); } });
  bindClick('dvMark', ()=>{ DV.mark=DV.mark?null:{ start:null, rect:null }; DV.sig=''; dvRender(); if(DV.mark) toast('arraste na tela pra marcar a área', 'info'); });
  bindClick('dvMarkCancel', ()=>{ DV.mark=null; DV.sig=''; dvRender(); });
  bindClick('dvMarkSend', dvMarkSend);
  bindClick('dvLogsX', ()=>{ DV.logs=null; DV.sig=''; dvRender(); });
  const sel=$id('dvSel'); if(sel) sel.onchange=async()=>{ const d=(DV.info[id]||{})[plat]||{};
    if(!d.up){ return; } // desligado: vale no próximo "ligar"
    if(await askYes(`Trocar pra ${sel.options[sel.selectedIndex].text}?\n\nO aparelho desta tarefa é desligado e ligado de novo com o modelo novo.`, 'Trocar aparelho')){
      dvStopStream(); try{ await invoke('device_mirror_stop',{ taskId:id, platform:plat }); }catch(_){ }
      if(plat==='android'){ DV.starting=true; DV.sig=''; dvRender(); try{ await invoke('device_cli',{ taskId:id, sub:'down', flags:[['platform','android']] }); }catch(_){ } }
      await dvPower(true, sel.value);
    } else { DV.sig=''; dvRender(); } };
  dvEl().querySelectorAll('[data-dvplat]').forEach(b=>b.onclick=()=>{ const p=b.dataset.dvplat; if(p===DV.plat[id]) return; dvStopStream(); DV.plat[id]=p; lsSet('dv:plat:'+id, p); DV.mark=null; DV.logs=null; DV.err=''; DV.sig=''; dvRender(); });
  dvEl().querySelectorAll('[data-dvmenu]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); dvMenu(b.dataset.dvmenu, b); });
  // alça de redimensionar (borda esquerda): arrasta, a largura fica lembrada
  const rz=$id('dvResize'); if(rz) rz.onpointerdown=(e)=>{ e.preventDefault(); rz.setPointerCapture(e.pointerId); const el=dvEl(); const x0=e.clientX, w0=el.getBoundingClientRect().width;
    rz.onpointermove=(ev)=>{ const w=Math.min(760, Math.max(280, w0+(x0-ev.clientX))); el.style.setProperty('--dvw', w+'px'); };
    rz.onpointerup=(ev)=>{ rz.onpointermove=null; rz.onpointerup=null; lsSet('dvWidth', String(Math.round(dvEl().getBoundingClientRect().width))); }; };
  dvWireScreen(v);
  if(DV.mark&&DV.mark.rect) dvPaintMark(DV.mark.rect);
}
document.addEventListener('click', (e)=>{ const pop=$id('dvPop'); if(pop && !pop.hidden && !e.target.closest('#dvPop') && !e.target.closest('[data-dvmenu]')) pop.hidden=true; });
