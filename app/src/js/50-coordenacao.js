// Coordenação — API do front para o fosso (detecção de overlap + baseline de "caos").
// Fina de propósito: só faz a ponte com os comandos Rust — coordination_metrics (3 COUNTs
// read-only no próprio Rust, mesmo JSON do `cardume metrics --json`) e overlap_check (chama o CLI).
// A fiação visual no fluxo "Nova demanda" e num painel dedicado entra depois,
// consumindo estas funções — assim a UI existente não é tocada às cegas.
(function () {
  "use strict";

  /** Baseline de coordenação: { totalTasks, byStatus, conflictTasks, collisionEvents, reworkCount }. */
  async function metrics() {
    try {
      // leitura de painel: "database is locked"/"busy" com agentes gravando é momentâneo (o Rust já
      // espera até 8 s) — a próxima leitura resolve; só o inesperado vai pro console/app_errors
      const raw = await invokeQuiet("coordination_metrics");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      if (!/database is locked|database is busy|SQLITE_BUSY/i.test(String((e && e.message) || e))) console.error("[coordenacao] metrics falhou:", e);
      return null;
    }
  }

  /**
   * Checa sobreposição de escopo de uma demanda nova contra tarefas ativas.
   * @param {string[]|string} owns padrões (array ou "a,b,c")
   * @returns {Promise<Array<{taskId,agent,yours,theirs,kind}>>}
   */
  async function overlapCheck(owns) {
    const list = Array.isArray(owns) ? owns : String(owns || "").split(",");
    const clean = list.map((s) => s.trim()).filter(Boolean);
    if (clean.length === 0) return [];
    try {
      const raw = await invoke("overlap_check", { owns: clean.join(",") });
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error("[coordenacao] overlapCheck falhou:", e);
      return [];
    }
  }

  /** Texto curto de aviso pronto pra UI (ou "" se não há overlap). */
  function overlapSummary(overlaps) {
    if (!overlaps || overlaps.length === 0) return "";
    const areas = [...new Set(overlaps.map((o) => o.theirs))].slice(0, 3).join(", ");
    const n = overlaps.length;
    return `${n} sobreposição${n > 1 ? "ões" : ""} de escopo (${areas}${overlaps.length > 3 ? "…" : ""}) — considere dividir ou sequenciar.`;
  }

  window.Coordenacao = { metrics, overlapCheck, overlapSummary };

  // --- aviso ao vivo no campo de escopo (#ntOwns) do "Nova demanda" ---
  // Feedback imediato enquanto o usuário digita, antes mesmo de iniciar.
  // Fica aqui (não nos módulos de tela) pra não acoplar ao fluxo existente.
  function wireOwnsHint() {
    const inp = document.getElementById("ntOwns");
    if (!inp || inp.dataset.coordWired) return;
    inp.dataset.coordWired = "1";
    let hint = document.getElementById("coordOverlapHint");
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "coordOverlapHint";
      hint.className = "mono";
      hint.style.cssText = "font-size:11px;margin-top:4px;color:var(--warn);display:none;line-height:1.4";
      (inp.parentElement || inp).appendChild(hint);
    }
    let timer = null;
    const check = async () => {
      const val = inp.value.trim();
      if (!val) { hint.style.display = "none"; return; }
      const ov = await overlapCheck(val);
      const txt = overlapSummary(ov);
      if (txt) { hint.textContent = txt; hint.style.display = "block"; }
      else { hint.style.display = "none"; }
    };
    inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 450); });
    inp.addEventListener("blur", check);
  }
  // O form pode ser montado depois do load; tenta algumas vezes sem custo.
  let tries = 0;
  const t = setInterval(() => { wireOwnsHint(); if (++tries > 20 || document.getElementById("ntOwns")?.dataset.coordWired) clearInterval(t); }, 500);
  if (document.readyState !== "loading") wireOwnsHint();
  else document.addEventListener("DOMContentLoaded", wireOwnsHint);

  // --- chip de coordenação na "Central de execuções" (#coordChip) ---
  // Preenche o span (recriado a cada render do board) com métricas em cache (20s). A consulta hoje é
  // 3 COUNTs read-only no Rust (antes: spawn de `node cli.mjs metrics`); falha também conta como
  // consulta feita (antes o cache nunca valia e reconsultava a cada 2s) e o intervalo dobra até 5 min.
  let mCache = null, mAt = 0, mFails = 0, mBusy = false;
  async function fillCoordChip() {
    const chip = document.getElementById("coordChip");
    if (!chip || mBusy) return;
    const wait = mFails ? Math.min(300000, 20000 * 2 ** (mFails - 1)) : 20000;
    if (Date.now() - mAt > wait) {
      mBusy = true;
      try { const m = await metrics(); mAt = Date.now(); if (m) { mCache = m; mFails = 0; } else mFails++; }
      finally { mBusy = false; }
    }
    const m = mCache;
    if (!m) return;
    // linguagem de gente (antes: "conflitos · colisões · reworks" com zeros o tempo todo); tudo zerado = some
    const c = m.conflictTasks || 0, k = m.collisionEvents || 0, r = m.reworkCount || 0;
    if (!c && !k && !r) { if (chip.innerHTML) chip.innerHTML = ""; chip.title = ""; chip.style.display = "none"; return; }
    const pl = (n, um, varios) => n + " " + (n === 1 ? um : varios);
    const parts = [];
    if (c) parts.push(`<span style="color:var(--warn)">${IC.flag} ${pl(c, "tarefa com conflito", "tarefas com conflito")}</span>`);
    if (k) parts.push(pl(k, "disputa de arquivo entre agentes", "disputas de arquivo entre agentes"));
    if (r) parts.push(pl(r, "ajuste pedido", "ajustes pedidos"));
    const html = parts.join(" · ");
    if (chip.innerHTML !== html) chip.innerHTML = html;
    chip.style.display = "";
    chip.style.cursor = "help";
    chip.title = "Como os agentes estão se coordenando neste projeto:\n" +
      "• tarefa com conflito — a branch dela não junta sozinha com a base (precisa resolver antes do merge)\n" +
      "• disputa de arquivo — dois agentes quiseram editar o mesmo arquivo ao mesmo tempo; um esperou o outro\n" +
      "• ajuste pedido — uma entrega voltou pra ser refeita depois da revisão";
  }
  setInterval(fillCoordChip, 2000);
})();
