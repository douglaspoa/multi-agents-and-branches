// Coordenação — API do front para o fosso (detecção de overlap + baseline de "caos").
// Fina de propósito: só faz a ponte com os comandos Rust (coordination_metrics /
// overlap_check), que por sua vez chamam o CLI (fonte única da lógica em TS).
// A fiação visual no fluxo "Nova demanda" e num painel dedicado entra depois,
// consumindo estas funções — assim a UI existente não é tocada às cegas.
(function () {
  "use strict";

  /** Baseline de coordenação: { totalTasks, byStatus, conflictTasks, collisionEvents, reworkCount }. */
  async function metrics() {
    try {
      const raw = await invoke("coordination_metrics");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[coordenacao] metrics falhou:", e);
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
    return `⚠ ${n} sobreposição${n > 1 ? "ões" : ""} de escopo (${areas}${overlaps.length > 3 ? "…" : ""}) — considere dividir ou sequenciar.`;
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
  // Preenche o span (recriado a cada render do board) com métricas em cache,
  // reconsultando o motor no máximo a cada 20s pra não spawnar node por render.
  let mCache = null, mAt = 0;
  async function fillCoordChip() {
    const chip = document.getElementById("coordChip");
    if (!chip) return;
    if (!mCache || Date.now() - mAt > 20000) {
      const m = await metrics();
      if (m) { mCache = m; mAt = Date.now(); }
    }
    const m = mCache;
    if (!m) return;
    const warn = (n, label) => n > 0 ? `<span style="color:var(--warn)">⚑ ${n} ${label}</span>` : `${n} ${label}`;
    chip.innerHTML = [
      warn(m.conflictTasks, "conflitos"),
      warn(m.collisionEvents, "colisões"),
      warn(m.reworkCount, "reworks"),
    ].join(" · ");
  }
  setInterval(fillCoordChip, 2000);
})();
