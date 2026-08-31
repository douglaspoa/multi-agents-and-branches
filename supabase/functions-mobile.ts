// Constellation Mobile — PWA companion servida como Edge Function.
// Página única, dark, mobile-first: login → "esperando você" (responder o
// agente) → backlog do time → detalhe com requisitos provados e provas.
const HTML = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0e0d"><title>Constellation</title>
<style>
:root{--bg:#0b0e0d;--s:#111514;--s2:#161b19;--b:#232a27;--b2:#313a36;--t:#e8ede9;--t2:#aab5af;--mut:#6b7671;--ac:#39d46a;--warn:#e0b34d;--bad:#e5645c}
*{box-sizing:border-box;margin:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--t);font:15px/1.55 -apple-system,Inter,sans-serif;padding-bottom:40px}
.mono{font-family:ui-monospace,Menlo,monospace}
header{position:sticky;top:0;background:rgba(11,14,13,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--b);padding:calc(env(safe-area-inset-top) + 12px) 16px 12px;display:flex;align-items:center;gap:10px;z-index:5}
header b{font-size:16px}
header svg{width:20px;height:20px;color:var(--ac)}
.grow{flex:1}
main{padding:14px 14px 30px;max-width:560px;margin:0 auto}
.sec{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin:20px 2px 8px}
.card{background:var(--s);border:1px solid var(--b);border-radius:12px;padding:13px 14px;margin-bottom:9px}
.card.q{border-color:var(--warn);animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(224,179,77,0)}50%{box-shadow:0 0 0 4px rgba(224,179,77,.18)}}
@media (prefers-reduced-motion:reduce){.card.q{animation:none;box-shadow:0 0 0 3px rgba(224,179,77,.15)}}
.row{display:flex;align-items:center;gap:8px}
.tt{font-weight:600;font-size:14.5px;flex:1;min-width:0}
.st{font-size:11px;white-space:nowrap}
.dim{color:var(--t2);font-size:12.5px}
.mut{color:var(--mut);font-size:11.5px}
.btn{display:block;width:100%;background:var(--s2);border:1px solid var(--b2);color:var(--t);font:inherit;font-size:14px;padding:12px;border-radius:10px;margin-top:8px;text-align:left}
.btn:active{background:var(--b)}
.btn.pri{background:var(--ac);border-color:var(--ac);color:#0b0e0d;font-weight:700;text-align:center}
.in{width:100%;background:var(--s2);border:1px solid var(--b2);color:var(--t);font:inherit;font-size:15px;padding:12px;border-radius:10px;margin-top:8px}
textarea.in{min-height:74px;resize:vertical}
.chip{display:inline-block;font-size:10.5px;padding:2px 9px;border-radius:99px;border:1px solid var(--b2);color:var(--t2);margin:2px 4px 0 0}
.err{color:var(--bad);font-size:13px;margin-top:10px}
.ok{color:var(--ac)}
.warnc{color:var(--warn)}
.center{min-height:70vh;display:flex;flex-direction:column;justify-content:center}
.gal{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;border:1px solid var(--b)}
.back{color:var(--t2);font-size:13px;padding:4px 0;background:none;border:0}
.req{display:flex;gap:8px;padding:6px 0;border-bottom:1px dashed var(--b);font-size:13px}
a{color:var(--ac)}
</style></head><body>
<header><svg viewBox="0 0 20 20" fill="none"><g stroke="currentColor" stroke-width="1.2" stroke-opacity=".7" stroke-linecap="round"><path d="M5 14L9.5 9M9.5 9L15 11.5M9.5 9L12 4"/></g><g fill="currentColor"><circle cx="5" cy="14" r="1.5"/><circle cx="15" cy="11.5" r="1.5"/><circle cx="12" cy="4" r="1.4"/><circle cx="9.5" cy="9" r="2.2"/></g></svg><b>Constellation</b><span class="grow"></span><span id="who" class="mut"></span></header>
<main id="app"><div class="center dim">carregando…</div></main>
<script>
const U=location.origin, K='KEY_PLACEHOLDER';
const S={ get(){ try{return JSON.parse(localStorage.getItem('cm:sess')||'null')}catch(e){return null} }, set(v){ localStorage.setItem('cm:sess', v?JSON.stringify(v):'') } };
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
async function auth(p,b){ const r=await fetch(U+'/auth/v1/'+p,{method:'POST',headers:{apikey:K,'Content-Type':'application/json'},body:JSON.stringify(b)}); const j=await r.json(); if(!r.ok) throw new Error(j.error_description||j.msg||'falhou'); return j; }
async function api(p,o={},retry){ const s=S.get(); const r=await fetch(U+p,{...o,headers:{apikey:K,Authorization:'Bearer '+(s?s.access_token:''),'Content-Type':'application/json',...(o.headers||{})}}); if(r.status===401&&!retry&&s&&s.refresh_token){ try{ const n=await auth('token?grant_type=refresh_token',{refresh_token:s.refresh_token}); S.set(n); return api(p,o,true);}catch(e){ S.set(null); render(); throw e; } } const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null}catch(e){} if(!r.ok) throw new Error((j&&j.message)||('erro '+r.status)); return j; }
let view={name:'home'}, D={qs:[],tasks:[],teams:[]};
async function load(){ const s=S.get(); if(!s) return;
  const [qs,tasks]=await Promise.all([
    api('/rest/v1/questions?select=*,tasks(title,team_id)&status=eq.open&order=created_at.desc'),
    api('/rest/v1/tasks?select=id,title,status,claim_mode,assignee,created_by,cost_usd,updated_at,requirements_proof&order=updated_at.desc&limit=60'),
  ]); D.qs=qs; D.tasks=tasks; }
const ST={backlog:['backlog','var(--mut)'],running:['rodando','var(--warn)'],thinking:['pensando','var(--warn)'],'plan-review':['plano em revisão','var(--warn)'],queued:['na fila','var(--mut)'],review:['pronta pra review','var(--ac)'],delivered:['entregue','var(--ac)'],done:['concluída','var(--ac)'],merged:['mergeada','var(--ac)'],error:['erro','var(--bad)']};
function stC(s){ return (ST[s]||[s,'var(--t2)']); }
function render(){ const el=document.getElementById('app'); const s=S.get();
  document.getElementById('who').textContent=s?(s.user&&s.user.email||''):'';
  if(!s){ el.innerHTML='<div class="center"><div style="font-size:22px;font-weight:800;margin-bottom:4px">Entrar</div><div class="dim">a mesma conta do app no Mac</div><input class="in" id="em" type="email" placeholder="e-mail" autocomplete="username"><input class="in" id="pw" type="password" placeholder="senha" autocomplete="current-password"><button class="btn pri" id="go">entrar</button><div class="err" id="er"></div></div>';
    document.getElementById('go').onclick=async()=>{ try{ const j=await auth('token?grant_type=password',{email:em.value.trim(),password:pw.value}); S.set(j); await load(); render(); }catch(e){ er.textContent=e.message; } };
    document.getElementById('pw').addEventListener('keydown',e=>{ if(e.key==='Enter') go.click(); });
    return; }
  if(view.name==='task'){ renderTask(view.t); return; }
  let h='';
  if(D.qs.length){ h+='<div class="sec" style="color:var(--warn)">✋ esperando você — '+D.qs.length+'</div>';
    h+=D.qs.map(function(q,i){ const opts=Array.isArray(q.options)?q.options:[];
      return '<div class="card q"><div class="mut">'+esc(q.agent||'agente')+' · '+esc((q.tasks&&q.tasks.title)||'')+'</div><div style="font-size:14px;margin:6px 0 4px;white-space:pre-wrap">'+esc(q.prompt).slice(0,900)+'</div>'
      + opts.map(function(o,j){ return '<button class="btn" data-q="'+i+'" data-o="'+j+'">'+esc(o)+'</button>'; }).join('')
      + '<textarea class="in" id="qt'+i+'" placeholder="ou escreva sua resposta…"></textarea><button class="btn pri" data-q="'+i+'" data-free="1">responder</button></div>'; }).join(''); }
  h+='<div class="sec">tarefas do time</div>';
  h+= D.tasks.length? D.tasks.map(function(t,i){ const c=stC(t.status);
    return '<div class="card" data-t="'+i+'"><div class="row"><span class="tt">'+esc(t.title)+'</span><span class="st" style="color:'+c[1]+'">● '+esc(c[0])+'</span></div><div class="mut" style="margin-top:3px">'+(t.cost_usd>0?('$'+(+t.cost_usd).toFixed(2)+' · '):'')+new Date(t.updated_at).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+'</div></div>'; }).join('')
    : '<div class="dim">nenhuma tarefa compartilhada ainda</div>';
  el.innerHTML=h;
  el.querySelectorAll('[data-q]').forEach(function(b){ b.onclick=async function(){ const q=D.qs[+b.dataset.q]; let ans;
    if(b.dataset.free){ ans=document.getElementById('qt'+b.dataset.q).value.trim(); if(!ans) return; } else { ans=(Array.isArray(q.options)?q.options:[])[+b.dataset.o]; }
    b.disabled=true; b.textContent='enviando…';
    try{ const me=S.get(); await api('/rest/v1/questions?id=eq.'+q.id,{method:'PATCH',body:JSON.stringify({status:'answered',answer:ans,answered_by:me.user.id,answered_at:new Date().toISOString()})}); await load(); render(); }
    catch(e){ alert('Falhou: '+e.message); b.disabled=false; }
  };});
  el.querySelectorAll('[data-t]').forEach(function(c){ c.onclick=function(e){ if(e.target.closest('[data-q]')) return; view={name:'task',t:D.tasks[+c.dataset.t]}; render(); };});
}
async function renderTask(t){ const el=document.getElementById('app'); const c=stC(t.status);
  let h='<button class="back" id="bk">‹ voltar</button><div style="font-size:18px;font-weight:700;margin:6px 0 2px">'+esc(t.title)+'</div><div class="st" style="color:'+c[1]+'">● '+esc(c[0])+(t.cost_usd>0?' · $'+(+t.cost_usd).toFixed(2):'')+'</div>';
  const rp=t.requirements_proof; const list=rp&&(Array.isArray(rp.list)?rp.list:(Array.isArray(rp)?rp:null));
  if(list&&list.length){ h+='<div class="sec">requisitos provados '+list.filter(function(x){return x.status==="done"}).length+'/'+list.length+'</div>'+list.map(function(x){ return '<div class="req"><span class="'+(x.status==='done'?'ok':'warnc')+'">'+(x.status==='done'?'✓':'○')+'</span><span>'+esc(x.req||'')+'</span></div>'; }).join(''); }
  h+='<div class="sec">provas publicadas</div><div id="pv" class="dim">carregando…</div>';
  el.innerHTML=h; document.getElementById('bk').onclick=function(){ view={name:'home'}; render(); };
  try{ const arts=await api('/rest/v1/artifacts_meta?select=name,kind,storage_path&task_id=eq.'+t.id+'&order=created_at.desc');
    if(!arts.length){ document.getElementById('pv').textContent='o dev ainda não publicou provas desta tarefa'; return; }
    const sign=async function(p){ const j=await api('/storage/v1/object/sign/artifacts/'+p,{method:'POST',body:JSON.stringify({expiresIn:3600})}); return U+'/storage/v1'+(j.signedURL||j.signedUrl); };
    const imgs=arts.filter(function(a){return a.kind==='image'}).slice(0,12), docs=arts.filter(function(a){return a.kind!=='image'});
    let hh='';
    if(imgs.length){ const us=await Promise.all(imgs.map(function(a){return sign(a.storage_path).catch(function(){return null})}));
      hh+='<div class="gal">'+imgs.map(function(a,i){ return us[i]?'<a href="'+us[i]+'" target="_blank"><img src="'+us[i]+'" alt="'+esc(a.name)+'"></a>':''; }).join('')+'</div>'; }
    if(docs.length){ hh+='<div style="margin-top:8px">'+docs.map(function(a){ return '<span class="chip mono" data-p="'+esc(a.storage_path)+'">'+esc(a.name)+'</span>'; }).join('')+'</div>'; }
    const pv=document.getElementById('pv'); pv.innerHTML=hh||'—'; pv.classList.remove('dim');
    pv.querySelectorAll('[data-p]').forEach(function(x){ x.onclick=async function(){ try{ location.href=await sign(x.dataset.p);}catch(e){} };});
  }catch(e){ document.getElementById('pv').textContent='falhou: '+e.message; }
}
(async function(){ try{ if(S.get()) await load(); }catch(e){} render();
  setInterval(async function(){ if(S.get()&&view.name==='home'){ try{ await load(); render(); }catch(e){} } }, 12000);
})();
</script></body></html>`;

Deno.serve((req) => {
  const url = new URL(req.url);
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const base = `https://${url.hostname.split(".")[0].replace(/-.*/, "")}.supabase.co`;
  void base;
  return new Response(HTML.replace("KEY_PLACEHOLDER", key).replaceAll("const U=location.origin", `const U='https://fivoakrhazlzcdoocgbg.supabase.co'`), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});
