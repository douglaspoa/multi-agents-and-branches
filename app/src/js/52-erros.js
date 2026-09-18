// Constellation — 52-erros
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

  const RATE = Object.create(null); // anti-flood: source|message -> ts
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
      if (typeof SB === "undefined" || !SB.url || !SB.key) return false;
      const s = (SB.sess && SB.sess()) || null;
      const headers = { apikey: SB.key(), "Content-Type": "application/json", Prefer: "return=minimal" };
      if (s && s.access_token) headers["Authorization"] = "Bearer " + s.access_token;
      const r = await fetch(SB.url() + "/rest/v1/app_errors", { method: "POST", headers, body: JSON.stringify(rec) });
      return !!(r && r.ok);
    } catch (_) { return false; }
  }

  function enqueue(rec) { try { const q = JSON.parse(lsGet(QKEY) || "[]"); q.push(rec); lsSet(QKEY, JSON.stringify(q.slice(-80))); } catch (_) {} }
  async function flush() {
    let q; try { q = JSON.parse(lsGet(QKEY) || "[]"); } catch (_) { q = []; }
    if (!q.length) return;
    const keep = [];
    for (const rec of q) { const ok = await sendRaw(rec); if (!ok) { keep.push(rec); } }
    try { lsSet(QKEY, JSON.stringify(keep)); } catch (_) {}
  }

  async function logAppError(source, err, extra) {
    try {
      const n = normalize(err);
      const src = String(source || n.source || "app").slice(0, 60);
      if (!n.message || n.message === "(erro sem mensagem)") { if (!extra || !extra.force) { /* segue: registra mesmo assim */ } }
      // anti-flood: mesma origem+mensagem no mesmo minuto → ignora
      const k = src + "|" + n.message;
      const now = Date.now();
      if (RATE[k] && now - RATE[k] < 60000) return;
      RATE[k] = now;
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

  // ---- captura GLOBAL (além do envelope no invoke, que fica em 10-core) ----
  window.addEventListener("error", (e) => { try { logAppError("window.error", e.error || e.message, { at: (e.filename || "") + ":" + (e.lineno || 0) }); } catch (_) {} });
  window.addEventListener("unhandledrejection", (e) => { try { logAppError("unhandledrejection", e); } catch (_) {} });

  // esvazia a fila ao voltar a ter rede / periodicamente
  window.addEventListener("online", () => { flush(); });
  setTimeout(flush, 6000);
  setInterval(flush, 60000);
})();
