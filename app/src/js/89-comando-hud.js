// ---------- COMANDO · NÚCLEO DA VOZ (26/11) ----------
// Com a voz ligada, a conversa ganha um NÚCLEO: um anel que reage a quem está com a palavra. Ouvindo = respira e pulsa
// a cada palavra entendida; trabalhando = uma onda corre o anel e a linha diz o que o agente faz agora; falando = as
// barras seguem o ÁUDIO de verdade da resposta (analisador na saída da voz tratada). Só desenha com a voz ligada e a
// aba do Comando à vista (canvas escondido animando já travou o app — 24/09).
// @hud-puro-inicio
/** Quem está com a palavra. Puro. */
function cmdHudEstado(s){ s=s||{}; if(!s.on) return 'off'; if(s.speaking) return 'falando'; if(s.espera) return 'confirmar'; if(s.busy) return 'pensando'; if(s.live) return 'ouvindo'; return 'pronto'; }
const CMD_HUD_TX={ falando:'FALANDO', confirmar:'ESPERANDO O SEU SIM', pensando:'TRABALHANDO', ouvindo:'OUVINDO', pronto:'PRONTO' };
/** As n barras do anel (0..1) no instante t (s). freq = espectro real da fala (0..255), quando há. Puro. */
function cmdHudBarras(n, t, estado, energia, freq){ const B=new Array(n), en=Math.max(0, Math.min(1, energia||0));
  for(let i=0;i<n;i++){ let v=0.04;
    if(estado==='falando'){
      if(freq && freq.length){ const m=i<n/2?i:n-1-i, k=Math.min(freq.length-1, Math.floor(m/(n/2)*freq.length*0.55)); v=0.06+(freq[k]/255)*0.94; }
      else v=0.18+0.5*Math.abs(Math.sin(t*8.5+i*0.9)*Math.sin(t*3.1+i*0.37)); }
    else if(estado==='ouvindo') v=0.08+0.05*Math.sin(t*2+i*0.5)+en*(0.3+0.55*Math.abs(Math.sin(t*13+i*1.7)));
    else if(estado==='pensando') v=0.06+0.8*Math.pow(Math.max(0, Math.cos(i/n*Math.PI*2-t*4)), 6);
    else if(estado==='confirmar') v=0.2+0.14*Math.sin(t*3);
    B[i]=Math.max(0, Math.min(1, v)); }
  return B; }
/** A frase ao lado do núcleo. Puro. */
function cmdHudLinha(estado, o){ o=o||{}; const c=(x)=>String(x||'').replace(/\s+/g,' ').trim();
  if(estado==='falando') return c(o.fala); if(estado==='confirmar') return 'Diga “sim” pra eu fazer ou “não” pra cancelar.';
  if(estado==='pensando') return c(o.agora)||'pensando…'; if(estado==='ouvindo') return c(o.ouvindo)||'Pode falar.'; return ''; }
// @hud-puro-fim
const CMDH={ raf:0, energia:0, ouvindo:'', cor:'', corAt:0, freq:null };
function cmdHudHtml(){ return `<div class="cmdhud" id="cmdHud" hidden><canvas class="cmdhud-cv" id="cmdHudCv" width="112" height="112" aria-hidden="true"></canvas><div class="cmdhud-tx"><div class="cmdhud-e" id="cmdHudE"></div><div class="cmdhud-l" id="cmdHudL" aria-hidden="true"></div></div></div>`; }
/** O reconhecimento entendeu um pedaço (ainda falando): o texto aparece ao vivo e o anel pulsa. */
function cmdHudOuve(tx){ CMDH.ouvindo=String(tx||''); if(tx) CMDH.energia=1; cmdHudPaint(); }
function cmdHudAgora(){ return cmdHudEstado({ on:CMDV.on, speaking:CMDV.speaking, live:CMDV.live, busy:CMD.busy, espera:!!(typeof CMDAG!=='undefined' && CMDAG.espera && !CMDAG.espera.done) }); }
function cmdHudPaint(){ const el=$id('cmdHud'); if(!el) return; const e=cmdHudAgora();
  el.hidden=e==='off'; if(e==='off'){ cancelAnimationFrame(CMDH.raf); CMDH.raf=0; CMDH.ouvindo=''; return; }
  if(el.dataset.estado!==e){ el.dataset.estado=e; CMDH.corAt=0; if(e!=='ouvindo') CMDH.ouvindo=''; }
  const E=$id('cmdHudE'), L=$id('cmdHudL'), tx=CMD_HUD_TX[e]||'', ln=cmdHudLinha(e, { fala:CMDV.falaTx, agora:(typeof CMDAG!=='undefined' && CMDAG.msg && CMDAG.msg.agora)||'', ouvindo:CMDH.ouvindo });
  if(E && E.textContent!==tx) E.textContent=tx; if(L && L.textContent!==ln) L.textContent=ln;
  const parado=window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(parado){ cmdHudDraw(0); return; }
  if(!CMDH.raf && cmdAtiva() && !document.hidden) CMDH.raf=requestAnimationFrame(cmdHudLaco);
  else if(!CMDH.raf) cmdHudDraw(performance.now()); } // janela escondida: um quadro parado, pra não aparecer vazio quando ela voltar
function cmdHudLaco(ts){ CMDH.raf=0; const el=$id('cmdHud'); if(!el || el.hidden || !cmdAtiva() || document.hidden) return;
  // o estado mudou sem ninguém repintar (voz desligada por erro, fala que acabou): o núcleo se acerta sozinho — e some se a voz saiu
  if(cmdHudAgora()!==el.dataset.estado){ cmdHudPaint(); if(el.hidden) return; }
  cmdHudDraw(ts); if(!CMDH.raf) CMDH.raf=requestAnimationFrame(cmdHudLaco); }
function cmdHudDraw(ts){ const cv=$id('cmdHudCv'), el=$id('cmdHud'); if(!cv || !el) return; const g=cv.getContext('2d'); if(!g) return;
  const dpr=Math.min(2, window.devicePixelRatio||1), S=cv.clientWidth||112; if(cv.width!==Math.round(S*dpr)){ cv.width=cv.height=Math.round(S*dpr); }
  g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,S,S);
  const t=ts/1000, e=el.dataset.estado, c=S/2, D=Math.PI*2;
  if(!CMDH.cor || ts-CMDH.corAt>600 || !CMDH.corAt){ CMDH.cor=getComputedStyle(el).color; CMDH.corAt=ts||1; }
  g.strokeStyle=CMDH.cor; g.fillStyle=CMDH.cor; g.lineCap='round';
  let freq=null; if(e==='falando' && CMDV.analisa && CMDV.src){ try{ freq=CMDH.freq||(CMDH.freq=new Uint8Array(CMDV.analisa.frequencyBinCount)); CMDV.analisa.getByteFrequencyData(freq); }catch(_){ freq=null; } }
  CMDH.energia*=0.94;
  const N=56, B=cmdHudBarras(N, t, e, CMDH.energia, freq), vel=({ falando:0.5, pensando:1.7, ouvindo:0.35, confirmar:0.2, pronto:0.12 })[e]||0.2;
  // anel de fora, com as marcas girando devagar
  g.globalAlpha=0.3; g.lineWidth=1; g.beginPath(); g.arc(c,c,c-1.5,0,D); g.stroke();
  for(let k=0;k<36;k++){ const a=k/36*D+t*vel*0.3, r1=c-(k%3?5:8), r2=c-2.5; g.globalAlpha=k%3?0.25:0.6; g.beginPath(); g.moveTo(c+Math.cos(a)*r1, c+Math.sin(a)*r1); g.lineTo(c+Math.cos(a)*r2, c+Math.sin(a)*r2); g.stroke(); }
  // os arcos: dois num sentido, um no outro
  const a=t*vel; g.globalAlpha=0.9; g.lineWidth=2; g.beginPath(); g.arc(c,c,c-12,a,a+1.9); g.stroke(); g.beginPath(); g.arc(c,c,c-12,a+Math.PI,a+Math.PI+0.9); g.stroke();
  g.globalAlpha=0.5; g.lineWidth=1.2; g.beginPath(); g.arc(c,c,c-17,-a*1.4,-a*1.4+2.6); g.stroke();
  // as barras: a voz
  const r0=c*0.4, rmax=c-21-r0; let soma=0; g.lineWidth=2;
  for(let i=0;i<N;i++){ const ang=i/N*D-Math.PI/2, len=1.5+B[i]*rmax; soma+=B[i]; g.globalAlpha=0.35+0.65*B[i]; g.beginPath(); g.moveTo(c+Math.cos(ang)*r0, c+Math.sin(ang)*r0); g.lineTo(c+Math.cos(ang)*(r0+len), c+Math.sin(ang)*(r0+len)); g.stroke(); }
  // o núcleo acende com o volume
  const m=soma/N; g.globalAlpha=0.1+m*0.4; g.beginPath(); g.arc(c,c,r0-7+m*3,0,D); g.fill(); g.globalAlpha=0.85; g.lineWidth=1.2; g.beginPath(); g.arc(c,c,r0-4,0,D); g.stroke(); g.globalAlpha=1; }
try{ document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) cmdHudPaint(); }); }catch(_){ }
