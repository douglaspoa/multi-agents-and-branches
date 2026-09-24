// Constellation — 05-cosmos: céu de fundo dos loadings (estrelas que piscam + meteoros), canvas leve.
// Uso: el.innerHTML = cosmosHtml('carregando…')  → o MutationObserver anima sozinho.
// Pra HTML estático que já está no DOM (ex.: modal escondido), chame cosmosStart(raiz) ao exibir.
function cosmosHtml(msg, size){ return `<div class="cosmos${size?' '+size:''}"><canvas class="cosmos-c"></canvas><div class="cosmos-t">${msg?esc(msg):''}</div></div>`; }
const _cosmosReduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function cosmosStart(root){
  (root||document).querySelectorAll('canvas.cosmos-c:not([data-live])').forEach(c=>{ c.dataset.live='1'; cosmosRun(c); });
}
function cosmosRun(c){
  const ctx=c.getContext('2d'); if(!ctx) return;
  let W=0,H=0, stars=[], meteors=[], last=0, nextMeteor=600;
  const seed=()=>{ const n=Math.max(40, Math.round(W*H/900)); stars=Array.from({length:n},()=>({ x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.3+.3, p:Math.random()*Math.PI*2, s:.4+Math.random()*1.2, v:.02+Math.random()*.06 })); };
  const resize=()=>{ const r=c.getBoundingClientRect(); if(!r.width||!r.height) return; if(Math.abs(r.width-W)<1 && Math.abs(r.height-H)<1 && stars.length) return; /* nada mudou: evita loop do ResizeObserver */ const dpr=Math.min(2, window.devicePixelRatio||1); W=r.width; H=r.height; c.width=Math.round(W*dpr); c.height=Math.round(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0); seed(); };
  // oculto = PARADO de verdade: antes o loop seguia a 60fps lendo offsetParent (layout forçado a cada quadro, por
  // canvas) — com os canvases escondidos do app isso comia ~20% de CPU/GPU parado e deixava tudo lento.
  // O IntersectionObserver religa quando o canvas volta a aparecer.
  let running=false, visible=false;
  const kick=()=>{ if(!running && visible && c.isConnected){ running=true; last=0; requestAnimationFrame(frame); } };
  const frame=(t)=>{
    if(!c.isConnected || !visible){ running=false; return; } // saiu do DOM ou ficou oculto: para (o observer religa)
    if(!W) resize();
    const dt=Math.min(50, (t-last)||16); last=t;
    ctx.clearRect(0,0,W,H);
    for(const s of stars){
      s.p+=dt*.002*s.s; s.x-=s.v*dt*.06; if(s.x<-2){ s.x=W+2; s.y=Math.random()*H; }
      ctx.globalAlpha=.3+.7*(.5+.5*Math.sin(s.p)); ctx.fillStyle='#eaf2ee';
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,6.2832); ctx.fill();
    }
    ctx.globalAlpha=1;
    if(!_cosmosReduced){
      nextMeteor-=dt;
      if(nextMeteor<=0){ meteors.push({ x:W*.15+Math.random()*W*.85, y:-8, vx:-(.32+Math.random()*.3), vy:.5+Math.random()*.3, len:70+Math.random()*90, life:1 }); nextMeteor=1300+Math.random()*2400; }
      for(const m of meteors){
        m.x+=m.vx*dt; m.y+=m.vy*dt; m.life-=dt/1500;
        const tx=m.x-m.vx*m.len, ty=m.y-m.vy*m.len;
        const g=ctx.createLinearGradient(m.x,m.y,tx,ty);
        g.addColorStop(0,'rgba(63,214,138,'+(.95*Math.max(0,m.life)).toFixed(3)+')'); g.addColorStop(1,'rgba(63,214,138,0)');
        ctx.strokeStyle=g; ctx.lineWidth=1.4; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(tx,ty); ctx.stroke();
      }
      meteors=meteors.filter(m=>m.life>0 && m.y<H+30 && m.x>-120);
    }
    requestAnimationFrame(frame);
  };
  resize();
  if(window.IntersectionObserver){ const io=new IntersectionObserver(es=>{ visible=es.some(e=>e.isIntersecting); if(!c.isConnected){ io.disconnect(); return; } kick(); }); io.observe(c); }
  else { visible=true; kick(); }
  if(window.ResizeObserver) new ResizeObserver(()=>requestAnimationFrame(resize)).observe(c);
}
// no máximo 1 varredura por quadro (antes: querySelectorAll no documento inteiro a CADA mutação — dezenas por segundo com agentes rodando)
let _cosmosQ=0;
new MutationObserver(()=>{ if(_cosmosQ) return; _cosmosQ=requestAnimationFrame(()=>{ _cosmosQ=0; cosmosStart(); }); }).observe(document.documentElement, { childList:true, subtree:true });
