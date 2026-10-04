// Starfork — 52-erros
// Rastreabilidade de erros: UMA classe/handler por onde TODO erro passa e vai
// pro Supabase (tabela app_errors). A captura é GLOBAL (envelope no invoke em
// 10-core + os listeners abaixo), então cobre do login ao mais banal — sem
// precisar embrulhar cada catch na mão. Nunca derruba o app: tudo em try/catch.
(function () {
  "use strict";

  // classe pra quem quiser lançar um erro já rotulado: throw new AppError('x', {source:'y'})
  class AppError extends Error {
    constructor(message, opts) {
      super(message);
      this.name = "AppError";
      this.source = (opts && opts.source) || "app";
      this.context = (opts && opts.context) || {};
    }
  }
  window.AppError = AppError;

  let BUILD = "";
  try { invoke("build_info").then((ms) => { const d = new Date(Number(ms) || 0); if (+d) BUILD = `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }).catch(()=>{}); } catch (_) {}

  const RATE = Object.create(null); // anti-flood: source|message -> ts (+ __hits: teto global da janela)
  // preview/harness (__TAURI__ falso em http://localhost) NÃO reporta: sujava a tabela de produção
  const REAL = isRealApp(window);
  const QKEY = "app:errq";           // fila offline (até enviar)

  function baseCtx() {
    let user = null, team = null, repo = "";
    try { user = (typeof cloudUserId === "function" && cloudUserId()) || null; } catch (_) {}
    try { team = (typeof cloudTeamId === "function" && cloudTeamId()) || null; } catch (_) {}
    try { repo = ((typeof state !== "undefined" && state && state.repo) || "").split("/").filter(Boolean).slice(-1)[0] || ""; } catch (_) {}
    return { user_id: user || null, team_id: team || null, repo };
  }

  function normalize(err) {
    if (err == null) return { message: "(erro sem mensagem)", detail: "", source: "" };
    if (typeof err === "string") return { message: err.slice(0, 800), detail: "", source: "" };
    const r = err.reason || err; // unhandledrejection embrulha em .reason
    const message = String((r && (r.message)) || err.message || r || err).slice(0, 800);
    const detail = String((r && r.stack) || err.stack || "").slice(0, 6000);
    const source = (r && r.source) || err.source || "";
    const context = (r && r.context) || err.context || null;
    return { message, detail, source, context };
  }

  async function sendRaw(rec) {
    try {
      if (!REAL) return true; // fora do app de verdade: descarta (e esvazia a fila)
      if (typeof SB === "undefined" || !SB.url || !SB.key) return false;
      const s = (SB.sess && SB.sess()) || null;
      const headers = { apikey: SB.key(), "Content-Type": "application/json", Prefer: "return=minimal" };
      if (s && s.access_token) headers["Authorization"] = "Bearer " + s.access_token;
      const r = await fetch(SB.url() + "/rest/v1/app_errors", { method: "POST", headers, body: JSON.stringify(rec) });
      return !!(r && r.ok);
    } catch (_) { return false; }
  }

  function enqueue(rec) { try { const q = JSON.parse(lsGet(QKEY) || "[]"); q.push(rec); lsSet(QKEY, JSON.stringify(q.slice(-80))); } catch (_) {} }
  // um flush por vez; ao terminar, RELÊ a fila (o que entrou durante os awaits não é sobrescrito)
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      let q; try { q = JSON.parse(lsGet(QKEY) || "[]"); } catch (_) { q = []; }
      if (!q.length) return;
      const sent = new Set();
      for (const rec of q) { if (await sendRaw(rec)) sent.add(rec.at + "|" + rec.source + "|" + rec.message); }
      let now; try { now = JSON.parse(lsGet(QKEY) || "[]"); } catch (_) { now = []; }
      try { lsSet(QKEY, JSON.stringify(now.filter((r) => !sent.has(r.at + "|" + r.source + "|" + r.message)).slice(-80))); } catch (_) {}
    } finally { flushing = false; }
  }

  async function logAppError(source, err, extra) {
    try {
      const n = normalize(err);
      const src = String(source || n.source || "app").slice(0, 60);
      if (!REAL) return;
      // estado legítimo que a tela já explica (chave não configurada nesta máquina, "parar" do usuário,
      // worktree limpa, gh sem acesso ao repo…) — lista em 00-util (ERR_EXPECTED), não é erro do produto
      if (errIsExpected(n.message)) return;
      // anti-flood: mesma origem+mensagem 1x a cada 10 min por sessão; teto global de 30 por janela
      if (!errRateOk(RATE, src + "|" + n.message, Date.now(), 600000, 30)) return;
      const b = baseCtx();
      const rec = {
        at: new Date().toISOString(),
        user_id: b.user_id,
        team_id: b.team_id,
        source: src,
        message: n.message,
        detail: n.detail || null,
        repo: b.repo || null,
        build: BUILD || null,
        context: Object.assign({ ua: (navigator.userAgent || "").slice(0, 140) }, n.context || {}, extra || {}),
      };
      const ok = await sendRaw(rec);
      if (!ok) enqueue(rec);
    } catch (_) { /* o logger NUNCA pode derrubar o app */ }
  }
  window.logAppError = logAppError;
  // erros do boot (antes deste arquivo carregar) guardados pelo 00-util
  try { const early = window.__earlyErrs || []; window.__earlyErrs = null; early.forEach((a) => logAppError(a[0], a[1], a[2])); } catch (_) {}

  // ---- captura GLOBAL (além do envelope no invoke, que fica em 10-core) ----
  window.addEventListener("error", (e) => { try { logAppError("window.error", e.error || e.message, { at: (e.filename || "") + ":" + (e.lineno || 0) }); } catch (_) {} });
  window.addEventListener("unhandledrejection", (e) => { try { logAppError("unhandledrejection", e); } catch (_) {} });
  // Erro TRATADO também é erro: render() roda em safe() e os catch fazem console.error ou
  // alert('Falha…') — nada disso virava error/unhandledrejection, então painel quebrado, clique
  // morto e "Falha ao criar…" nunca chegavam em app_errors. Agora chegam (mesmo anti-flood).
  const _ce = console.error;
  console.error = function (...a) {
    _ce.apply(console, a);
    try {
      if (a[0] === "promise sem catch:") return; // já vai pelo listener de unhandledrejection
      const err = a.find((x) => x instanceof Error) || a.find((x) => x && x.message) || a.map((x) => String(x)).join(" ");
      const lbl = typeof a[0] === "string" ? a[0].replace(/[:\s]+$/, "").slice(0, 50) : "";
      logAppError(lbl ? "console:" + lbl : "console.error", err, err !== a[0] && a.length > 1 ? { args: a.map((x) => String((x && x.message) || x)).join(" ").slice(0, 500) } : undefined);
    } catch (_) {}
  };
  const _al = window.alert;
  window.alert = function (m) {
    try { if (/^\s*(⚠|✕|falh|n[ãa]o (deu|consegui|foi|d[áa])|erro)/i.test(String(m))) logAppError("alert", String(m)); } catch (_) {}
    return _al.apply(this, arguments);
  };

  // esvazia a fila ao voltar a ter rede / periodicamente
  window.addEventListener("online", () => { flush(); });
  setTimeout(flush, 6000);
  setInterval(flush, 60000);
})();

// ===== FOLHA ANCORADA (F4 · G3, estados globais D23): confirmação, campo de texto e escolha numa folhinha presa ao
// botão que a abriu — no lugar dos diálogos nativos (OK/Cancelar) e do modal #txOverlay. askYes/askText continuam
// sendo a API (00-util / 11-ambiente-updater delegam pra cá). Esc ou clique fora cancela; Enter confirma.
// opts: { anchor, title, text, field:{ type, placeholder, value }, choices:[{ value, label, hint, disabled, danger }],
//         ok, cancel, danger, allowEmpty } → Promise: true/false (confirmação) · texto/null (campo) · valor/null (escolha)
// @folha-puro-inicio
function sheetPlace(r, w, h, vw, vh){
  const below=r.bottom+8+h<=vh || r.top-8-h<0;
  let top=below?r.bottom+8:r.top-8-h;
  top=Math.max(8, Math.min(vh-h-8, top)); // nunca sai da tela (nem em cima nem embaixo)
  const left=Math.max(8, Math.min(vw-w-8, r.left+r.width/2-w/2));
  return { top:Math.round(top), left:Math.round(left), up:!below, ax:Math.round(Math.max(14, Math.min(w-14, r.left+r.width/2-left))) };
}
// valor de "cancelar" de CADA folha: confirmação → false; campo ou escolha → null
function sheetCancelValue(o){ return (o&&(o.field||o.choices))?null:false; }
// @folha-puro-fim
// UMA folha por vez: a segunda espera a primeira terminar (antes a nova "cancelava" a pendente como false — uma
// confirmação sumia sem resposta)
let _sheetQ=Promise.resolve();
function sheetAsk(o){ const run=()=>sheetOpen(o||{}); const p=_sheetQ.then(run, run); _sheetQ=p.catch(()=>{}); return p; }
function sheetOpen(o){
  return new Promise(res=>{
    const cancelV=sheetCancelValue(o);
    const prevFocus=document.activeElement;
    const anchor=(o.anchor&&o.anchor.getBoundingClientRect&&o.anchor.isConnected!==false)?o.anchor:((prevFocus&&prevFocus!==document.body&&prevFocus.getBoundingClientRect)?prevFocus:null);
    const el=document.createElement('div'); el.className='sfsheet'+(o.danger?' danger':''); el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
    el.setAttribute('aria-label', String(o.title||'Confirmar'));
    const E=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    const ch=o.choices||null; let pick=ch?((ch.find(c=>!c.disabled)||{}).value):null;
    el.innerHTML=`<div class="sh-h"><b>${E(o.title||'Confirmar')}</b></div><div class="sh-b">${o.text?`<p>${E(o.text)}</p>`:''}`
      +(o.field?`<input class="in" data-sh-in type="${o.field.type==='password'?'password':'text'}" placeholder="${E(o.field.placeholder||'')}" value="${E(o.field.value||'')}" autocomplete="off" spellcheck="false" aria-label="${E(o.field.placeholder||o.title||'')}">`:'')
      +(ch?`<div class="sh-opts" role="radiogroup">${ch.map((c,i)=>`<button type="button" class="sh-opt${c.value===pick?' on':''}${c.danger?' danger':''}" role="radio" aria-checked="${c.value===pick}" data-sh-i="${i}"${c.disabled?' aria-disabled="true"':''}><span class="rd"></span><b>${E(c.label)}</b>${c.hint?`<em>${E(c.hint)}</em>`:''}</button>`).join('')}</div>`:'')
      +`</div><div class="sh-f"><button type="button" class="btn ${o.danger?'danger':'primary'} sm" data-sh-ok>${E(o.ok||'confirmar')}</button><button type="button" class="btn sm" data-sh-no>${E(o.cancel||'cancelar')}</button><span>Esc fecha</span></div>`;
    document.body.appendChild(el);
    const vw=window.innerWidth||1280, vh=window.innerHeight||800;
    const r=anchor?anchor.getBoundingClientRect():{ top:vh/2-40, bottom:vh/2-40, left:vw/2, width:0 };
    const p=sheetPlace(r, el.offsetWidth||380, el.offsetHeight||160, vw, vh);
    el.style.top=p.top+'px'; el.style.left=p.left+'px'; el.style.setProperty('--ax', p.ax+'px'); if(p.up) el.classList.add('up');
    if(!anchor) el.classList.add('noarrow');
    const input=el.querySelector('[data-sh-in]');
    let over=false, armed=false;
    const done=v=>{ if(over) return; over=true; el.remove(); if(armed){ document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); }
      try{ if(prevFocus&&prevFocus.focus&&prevFocus.isConnected) prevFocus.focus(); }catch(_){ } res(v); };
    const cancel=()=>done(cancelV);
    const choose=i=>{ const c=ch[i]; if(!c||c.disabled) return false; pick=c.value; el.querySelectorAll('[data-sh-i]').forEach(x=>{ const on=+x.dataset.shI===i; x.classList.toggle('on',on); x.setAttribute('aria-checked',String(on)); }); return true; };
    const ok=()=>{ if(o.field){ const v=input.value.trim(); if(!v && !o.allowEmpty){ input.focus(); return; } done(o.allowEmpty?v:v||null); } else if(ch) done(pick==null?null:pick); else done(true); };
    const outside=e=>{ if(!el.contains(e.target)) cancel(); };
    const key=e=>{
      if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if(e.key==='Tab'){ const f=[...el.querySelectorAll('button:not([disabled]),input')].filter(x=>x.getAttribute('aria-disabled')!=='true'); if(!f.length) return; const i=f.indexOf(document.activeElement);
        if(e.shiftKey && i<=0){ e.preventDefault(); f[f.length-1].focus(); } else if(!e.shiftKey && (i===-1||i===f.length-1)){ e.preventDefault(); f[0].focus(); } return; } // foco preso na folha
      if(e.key==='Enter' && el.contains(e.target)){
        if(e.target.matches && e.target.matches('[data-sh-no]')) return;
        const o2=e.target.closest && e.target.closest('[data-sh-i]');
        e.preventDefault(); if(o2){ if(choose(+o2.dataset.shI)) ok(); return; } ok(); } };
    el.querySelector('[data-sh-ok]').onclick=ok; el.querySelector('[data-sh-no]').onclick=cancel;
    el.querySelectorAll('[data-sh-i]').forEach(b=>b.onclick=()=>choose(+b.dataset.shI));
    setTimeout(()=>{ if(over) return; armed=true; document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); (input||el.querySelector(o.danger?'[data-sh-no]':'[data-sh-ok]')).focus(); }, 0);
  });
}
window.sheetAsk=sheetAsk;
