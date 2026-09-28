// ===== utilitários compartilhados (carrega ANTES de tudo) =====
// atalhos de DOM: $id no lugar de document.getElementById; bindClick() liga um handler só se o elemento existir
function $id(id){ return document.getElementById(id); }
// erros ANTES do 52-erros carregar (boot dos arquivos 00–51) ficam guardados aqui e ele despacha
window.__earlyErrs=[];
window.addEventListener('error', e=>{ if(window.__earlyErrs) window.__earlyErrs.push(['window.error', e.error||e.message, { at:(e.filename||'')+':'+(e.lineno||0) }]); });
window.addEventListener('unhandledrejection', e=>{ if(window.__earlyErrs) window.__earlyErrs.push(['unhandledrejection', e]); });
// falha de tick em segundo plano: rede instável é esperada (não polui app_errors); bug de verdade vai pro console.error → tabela
function tickErr(name, e){
  const m=String((e&&e.message)||e||'');
  if(/load failed|failed to fetch|networkerror|network|timeout|timed out|expirou|offline|abort|sem conex[ãa]o/i.test(m)) return;
  console.error('tick '+name+':', e);
}
function bindClick(id, fn, ev){ const el=$id(id); if(el) el[ev||'onclick']=fn; return el; }
// localStorage tolerante (webview em modo privado / sem permissão não derruba o app)
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
// caminhos de ARQUIVO nos dois formatos (/Users/x/proj e C:\Users\x\proj) — Windows mostrava o caminho inteiro.
// Só pra caminho do sistema de arquivos: URL e nome de branch continuam com split('/').
function pathBase(p){ return String(p||'').split(/[\\/]+/).filter(Boolean).slice(-1)[0]||''; }
function pathDir(p){ const s=String(p||''); const i=Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i>0?s.slice(0,i):(i===0?s.slice(0,1):''); }
// sistema operacional do app ('mac' | 'win' | 'linux') — o updater só aplica o .app no Mac
function osKind(){
  const p=String((typeof navigator!=='undefined'&&((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||navigator.userAgent))||'');
  return /mac|iphone|ipad/i.test(p)?'mac':/win/i.test(p)?'win':'linux';
}
// base da barra de abas → --chrome-h (as views-aba são position:fixed a partir daí).
// Chamar sempre que o topo mudar de altura: render das abas, recolher/expandir sidebar.
function syncChromeH(){ const tb=$id('tabBar'); if(tb && tb.style.display!=='none') document.documentElement.style.setProperty('--chrome-h', Math.round(tb.getBoundingClientRect().bottom)+'px'); }
// Esc: digitando num campo ou com um modal aberto por cima, o Esc é DELES — não fecha a aba de trás
function escBusy(e){
  if(e && e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return true;
  return ['artOverlay','lbOverlay','sumOverlay','cmOverlay','ctOverlay','goOverlay','pubOverlay','orgTplOverlay','repOverlay','txOverlay','errOverlay']
    .some(id=>{ const m=document.getElementById(id); return m && m.style.display && m.style.display!=='none'; });
}
// Confirmação SIM/NÃO de verdade. NÃO use window.confirm: o tauri-plugin-dialog troca ele por
// uma função async que chama 'plugin:dialog|confirm' — comando que o plugin 2.7 nem expõe (o ACL
// rejeita) — e a Promise devolvida é "truthy": todo if(confirm(...)) passava como SIM sem perguntar.
// Aqui vai direto no comando 'message' com OK/Cancelar (o mesmo que o ask/confirm do plugin usam).
async function askYes(message, title){
  const inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
  if(!inv) return window.confirm(String(message)); // preview no browser: confirm nativo
  try{ return (await inv('plugin:dialog|message',{ message:String(message), title:title||'Starfork', kind:'warning', buttons:'OkCancel' }))==='Ok'; }
  catch(e){ console.error('askYes:', e); return false; } // na dúvida, NÃO executa
}

// ===== status: UMA fonte de verdade (nome em PT + cor + ícone) =====
// Toda tela que mostra status de tarefa/cartão usa stLabel/stColor/stIcon — nada de
// mapa próprio nem de t.status cru em inglês na tela.
// `short` = forma curta (etiqueta da barra lateral / espaço apertado) — derivada DESTE mapa, nunca inventada na tela.
// 'pr-open' é um status DERIVADO (tarefa com PR aberto no GitHub), usado pelo taskSt(t) do 22.
const STATUS_META={
  draft:        { pt:'rascunho',          short:'rascunho', c:'var(--muted)',     ic:'·' },
  backlog:      { pt:'na fila',           short:'fila',     c:'var(--muted)',     ic:'·' },
  queued:       { pt:'na fila',           short:'fila',     c:'var(--muted)',     ic:'·' },
  'plan-review':{ pt:'plano pra aprovar', short:'plano',    c:'var(--st-ask)',    ic:'?' },
  running:      { pt:'rodando',           short:'rodando',  c:'var(--st-run)',    ic:'●' },
  thinking:     { pt:'rodando',           short:'rodando',  c:'var(--st-run)',    ic:'●' },
  asking:       { pt:'aguardando você',   short:'aguardando', c:'var(--st-ask)',    ic:'?' },
  paused:       { pt:'pausada',           short:'pausada',  c:'var(--muted)',     ic:'❚❚' },
  review:       { pt:'pronta pra revisar',short:'pra revisar', c:'var(--st-review)', ic:'◆' },
  delivered:    { pt:'pronta pra revisar',short:'pra revisar', c:'var(--st-review)', ic:'◆' },
  'pr-open':    { pt:'PR aberto',         short:'PR',       c:'var(--info)',      ic:'⌥' },
  done:         { pt:'concluída',         short:'concluída',c:'var(--st-done)',   ic:'✓' },
  merged:       { pt:'mergeada',          short:'mergeada', c:'var(--st-done)',   ic:'✓' },
  closed:       { pt:'concluída',         short:'concluída',c:'var(--st-done)',   ic:'✓' },
  error:        { pt:'erro',              short:'erro',     c:'var(--st-err)',    ic:'!' },
  conflict:     { pt:'conflito',          short:'conflito', c:'var(--st-err)',    ic:'!' },
  blocked:      { pt:'bloqueada',         short:'bloqueada',c:'var(--warn)',      ic:'⊘' },
  aborted:      { pt:'abortada',          short:'abortada', c:'var(--muted)',     ic:'×' },
  cancelled:    { pt:'cancelada',         short:'cancelada',c:'var(--muted)',     ic:'×' },
  waiting:      { pt:'na espera',         short:'espera',   c:'var(--muted)',     ic:'·' },
};
function stMeta(st){ return STATUS_META[st]||{ pt:String(st||'—'), c:'var(--muted)', ic:'·' }; }
function stLabel(st){ return stMeta(st).pt; }
function stColor(st){ return stMeta(st).c; }
function stIcon(st){ return stMeta(st).ic; }
function stIsBad(st){ return st==='error'||st==='conflict'; }
// selo de status padrão (mesma cara em todas as telas)
function stBadge(st){ const m=stMeta(st); return '<span class="stbadge" style="--stc:'+m.c+'"><i>'+m.ic+'</i>'+m.pt+'</span>'; }

// ===== toast global: feedback curto de sucesso/aviso sem travar a tela (alert só pra erro fatal) =====
// action (opcional): { label, fn } vira um botão no próprio toast (ex.: "abrir Ambiente");
// extra (opcional): segundo botão discreto (ex.: "ver detalhes" do erro cru)
function toast(msg, kind, action, extra){
  let el=$id('appToast'); if(!el){ el=document.createElement('div'); el.id='appToast'; el.setAttribute('role','status'); document.body.appendChild(el); }
  el.className='apptoast '+(kind||'info'); el.textContent='';
  const tx=document.createElement('span'); tx.className='apptoast-t'; tx.textContent=String(msg); el.appendChild(tx);
  const hide=()=>{ el.style.display='none'; };
  const btns=[action, extra].filter(a=>a && a.label && typeof a.fn==='function');
  if(btns.length){ const row=document.createElement('div'); row.className='apptoast-acts';
    btns.forEach((a,i)=>{ const b=document.createElement('button'); b.type='button'; b.className='apptoast-btn'+(i?' ghost':''); b.textContent=a.label;
      b.onclick=(ev)=>{ ev.stopPropagation(); hide(); try{ const r=a.fn(); if(r&&r.catch) r.catch(err=>console.warn('toast action', err)); }catch(err){ console.warn('toast action', err); } };
      row.appendChild(b); });
    el.appendChild(row); }
  el.style.display='block'; clearTimeout(el._t);
  // com botão, dá tempo de ler e clicar; o mouse em cima segura o toast
  const ms=btns.length?12000:(kind==='err'?7000:4200);
  el._t=setTimeout(hide, ms);
  el.onmouseenter=()=>clearTimeout(el._t); el.onmouseleave=()=>{ clearTimeout(el._t); el._t=setTimeout(hide, 4000); };
}
window.toast=toast;

// ===== catálogo de erros pt-BR com AÇÃO (mesa de produto, votado pelas 5 personas) =====
// Erro cru do Rust/gh/git/claude CLI/rede/Supabase/Tauri → { msg em pt-BR, action?:{label,fn} }.
// UMA regra pra todo o app: showErr(e, 'Falha ao pausar') no lugar de alert('Falha…'+e).
function errText(e){
  if(e==null) return '';
  if(typeof e==='string') return e;
  if(e.message) return String(e.message);
  try{ const j=JSON.stringify(e); return j==='{}'?String(e):j; }catch(_){ return String(e); }
}
// 1ª linha útil do erro cru, sem "Error:"/"fatal:" na frente e curta (vai no toast)
function errFirstLine(raw){
  const ln=String(raw||'').split(/\r?\n/).map(s=>s.replace(/^\s*(uncaught\s+)?(error|erro|fatal|warning)\s*:\s*/i,'').trim()).find(Boolean)||'';
  return ln.length>140 ? ln.slice(0,137)+'…' : ln;
}
// ações do catálogo: abrem a tela que resolve (nada de "vá em Configurações" sem botão)
const ERR_ACTIONS={
  env:     ()=>{ if(window.openTab) window.openTab('env'); },
  github:  ()=>{ if(window.openTab) window.openTab('env'); },
  gitinit: ()=>{ if(typeof gitGate==='function') return gitGate(); },
  publish: ()=>{ if(typeof publishGithub==='function') return publishGithub(); },
  conta:   ()=>{ if(window.openTab) window.openTab('conta'); },
};
// ORDEM importa: o primeiro que casa vence (ex.: "'origin' does not appear… Could not read from remote"
// é SEM REMOTE, não rede; "Permission denied (publickey)… Could not read from remote" é permissão).
const ERR_CATALOG=[
  { id:'claude-missing', re:/spawn claude ENOENT|claude:?\s*(command )?not found|n[aã]o (encontrei|achei) o (bin[aá]rio do )?claude|claude (code )?n[aã]o (est[aá] )?instalado|claude[^\n]{0,40}ENOENT/i,
    msg:'O Claude Code não está instalado neste computador.', act:'env', label:'ver como instalar (Mais › Ambiente)' },
  { id:'claude-login', re:/please run \/login|run \/login|invalid api key|not logged in|n[aã]o est[aá] logado no claude|authentication_error|oauth token (has )?expired|x-api-key/i,
    msg:'O Claude Code precisa de login.', act:'env', label:'abrir Ambiente' },
  { id:'gh-missing', re:/spawn gh ENOENT|\bgh:?\s*(command )?not found|gh n[aã]o (est[aá] )?instalado|github cli n[aã]o/i,
    msg:'O GitHub CLI (gh) não está instalado.', act:'env', label:'ver como instalar (Mais › Ambiente)' },
  { id:'gh-auth', re:/gh auth login|authentication required|not logged into any github|bad credentials|requires authentication|gh sem login|to get started with github cli/i,
    msg:'Conecte sua conta do GitHub.', act:'github', label:'abrir Ambiente' },
  { id:'session', re:/jwt expired|invalid jwt|sess[aã]o expirou|refresh[_ ]token/i,
    msg:'Sua sessão na nuvem expirou — entre de novo na conta.', act:'conta', label:'abrir Conta' },
  { id:'not-git', re:/not a git repository|n[aã]o [eé] um reposit[oó]rio git/i,
    msg:'Esta pasta ainda não é um repositório git.', act:'gitinit', label:'criar repositório' },
  { id:'no-remote', re:/'origin' does not appear to be a git repository|no such remote|no configured push destination|does not appear to be a git repository|sem remote|no git remotes? found|none of the git remotes/i,
    msg:'Este projeto ainda não está no GitHub.', act:'publish', label:'publicar no GitHub' },
  { id:'disk', re:/ENOSPC|no space left on device|disk (is )?full|disco (est[aá] )?cheio/i,
    msg:'O disco está cheio — libere espaço e tente de novo.' },
  { id:'ai-limit', re:/rate.?limit|usage limit|\b429\b|too many requests|overloaded|quota exceeded|limite de uso|credit balance is too low|hit your limit/i,
    msg:'A IA atingiu o limite de uso agora — espere alguns minutos e tente de novo.' },
  { id:'conflict', re:/merge conflict|CONFLICT \(|automatic merge failed|conflito de merge|not possible to fast-forward|\(fetch first\)|non-fast-forward|is not mergeable|merge commit cannot be cleanly created/i,
    msg:'Deu conflito com mudanças que já estão na base — resolva o conflito (ou peça pra IA resolver) e tente de novo.' },
  { id:'permission', re:/permission denied|EACCES|EPERM|operation not permitted|\b403\b|forbidden|protected branch|write access .* not granted|must have (admin|push) (rights|access)|resource not accessible/i,
    msg:'Sem permissão pra essa ação (arquivo protegido ou conta sem acesso ao repositório).' },
  { id:'network', re:/failed to fetch|load failed|networkerror|network is unreachable|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|could not resolve host|couldn'?t resolve|temporary failure in name resolution|\boffline\b|sem conex[aã]o|unable to access|failed to connect|could not read from remote|connection (refused|reset)/i,
    msg:'Sem conexão agora — cheque a internet/VPN e tente de novo.' },
];
// ctx (opcional): o que se tentava fazer ("Falha ao abrir o PR") — vira o prefixo da mensagem
function humanErr(e, ctx){
  const raw=errText(e);
  const pre=ctx?String(ctx).replace(/[\s:.…]+$/,''):'';
  const hit=ERR_CATALOG.find(c=>c.re.test(raw));
  if(hit){
    const action=(hit.act && ERR_ACTIONS[hit.act]) ? { label:hit.label, fn:ERR_ACTIONS[hit.act] } : null;
    return { id:hit.id, msg:(pre?pre+' — ':'')+hit.msg, action, raw };
  }
  const first=errFirstLine(raw)||'erro sem detalhe';
  return { id:'generic', msg:(pre||'Algo deu errado')+': '+first, action:null, raw };
}
// detalhes do erro cru (recolhido): pra quem quer ver/copiar o que o sistema disse
function errDetails(h){
  document.getElementById('errOverlay')?.remove();
  const ov=document.createElement('div'); ov.id='errOverlay';
  ov.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px';
  const box=document.createElement('div');
  box.style.cssText='background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;max-width:620px;width:100%;padding:16px 18px;box-shadow:var(--shadow);color:var(--text)';
  const t=document.createElement('div'); t.style.cssText='font-size:13.5px;font-weight:600;margin-bottom:8px'; t.textContent=h.msg;
  const pre=document.createElement('pre'); pre.className='mono'; pre.style.cssText='white-space:pre-wrap;word-break:break-word;font-size:11px;max-height:280px;overflow:auto;background:var(--surface-2);border-radius:8px;padding:10px;margin:0;color:var(--text-2)'; pre.textContent=h.raw||'(sem detalhe)';
  const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
  const cp=document.createElement('button'); cp.className='btn sm'; cp.textContent='copiar'; cp.onclick=()=>{ try{ navigator.clipboard.writeText(h.raw||''); cp.textContent='copiado ✓'; }catch(_){ } };
  const ok=document.createElement('button'); ok.className='btn primary sm'; ok.textContent='fechar'; ok.onclick=()=>ov.remove();
  if(h.action){ const a=document.createElement('button'); a.className='btn sm'; a.textContent=h.action.label; a.onclick=()=>{ ov.remove(); h.action.fn(); }; row.appendChild(a); }
  row.appendChild(cp); row.appendChild(ok);
  box.appendChild(t); box.appendChild(pre); box.appendChild(row); ov.appendChild(box);
  ov.addEventListener('click', ev=>{ if(ev.target===ov) ov.remove(); });
  ov.addEventListener('keydown', ev=>{ if(ev.key==='Escape') ov.remove(); });
  document.body.appendChild(ov); ok.focus();
}
// mostra o erro traduzido num toast com o botão que resolve (+ "ver detalhes" com o texto cru)
function showErr(e, ctx){
  const h=humanErr(e, ctx);
  console.warn('[erro]', ctx||'', h.raw);
  const det={ label:'ver detalhes', fn:()=>errDetails(h) };
  toast(h.msg, 'err', h.action||det, h.action?det:null);
  return h;
}
window.humanErr=humanErr; window.showErr=showErr;
// nº de arquivos de um diff: o backend (Rust, struct Diff) manda `files` como NÚMERO;
// versões antigas/mock mandavam lista — aceita os dois (antes saía "undefined arquivo(s)")
function diffFiles(d){ if(!d) return 0; const f=d.files; return typeof f==='number'?f:(Array.isArray(f)?f.length:0); }

// ===== custo em US$ com o equivalente em R$ (mesa 27/09: "custo antes, em R$") =====
// A cotação é a de Configurações ("cotação do dólar usada nas estimativas", padrão 5,5).
// UMA regra pra toda tela que mostra custo: fmtCost(usd) → "US$ 2,93 (≈ R$ 16,12)".
function usdBrlRate(){ const v=parseFloat(String(lsGet('usdBrl')||'').replace(',','.')); return v>0?v:5.5; }
// número no formato BR: inteiro sem casas ("5"), senão 2 casas ("27,50"); abaixo de 1 centavo, 4 casas
function fmtNumBR(v, forceDec){
  v=+v||0; const r=Math.round(v*100)/100;
  if(v>0 && v<0.01) return v.toLocaleString('pt-BR',{ minimumFractionDigits:4, maximumFractionDigits:4 });
  const dec=(forceDec||!Number.isInteger(r))?2:0;
  return r.toLocaleString('pt-BR',{ minimumFractionDigits:dec, maximumFractionDigits:dec });
}
function fmtCost(usd, opts){
  usd=+usd||0; const o=opts||{};
  const us='US$ '+fmtNumBR(usd);
  if(o.usdOnly) return us;
  return us+' (≈ R$ '+fmtNumBR(usd*usdBrlRate(), usd>0)+')';
}
// faixa de estimativa: "~US$ 2–4 (≈ R$ 11–22)" — arredonda (é previsão, não centavo)
function fmtCostRange(lo, hi){
  const rate=usdBrlRate(), big=lo>=1;
  const f=(v)=> big ? String(Math.round(v)) : fmtNumBR(v, true);
  const rs=(lo*rate>=1) ? `${Math.floor(lo*rate)}–${Math.ceil(hi*rate)}` : `${fmtNumBR(lo*rate,true)}–${fmtNumBR(hi*rate,true)}`;
  return `~US$ ${f(lo)}–${f(hi)} (≈ R$ ${rs})`;
}
// teto padrão por tarefa (US$; 0 = sem teto) — Configurações
function costCapDefault(){ const raw=lsGet('costCap'); const v=parseFloat(raw==null||raw===''?'5':raw); return v>=0?v:5; }
