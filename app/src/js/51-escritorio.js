// Escritório de agentes — visão CROSS-PROJETO num lugar só: quem precisa de você
// (fila única de atenção) + quem está trabalhando agora (mesas). Self-contained:
// cria o próprio botão, overlay e estilos, e lê os helpers globais (boardSource,
// pendingOf, ACTIVE_ST, lastEventOf, taskCost, agentColor/agentBadge…).
(function () {
  "use strict";
  let escTimer = null;

  function ensureDom() {
    if (document.getElementById("escOverlay")) return;
    const style = document.createElement("style");
    style.textContent = `
      #escLaunch{position:fixed;right:18px;bottom:18px;z-index:900;display:flex;align-items:center;gap:7px;
        padding:9px 14px;border-radius:99px;border:1px solid var(--border-strong);background:var(--surface);
        color:var(--text);font:600 12.5px 'Instrument Sans',sans-serif;cursor:pointer;box-shadow:var(--shadow-sm)}
      #escLaunch:hover{border-color:var(--accent)}
      #escLaunch .escbadge{min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--warn);
        color:#08110c;font:700 11px 'JetBrains Mono',monospace;display:none;align-items:center;justify-content:center}
      #escLaunch .escbadge.on{display:flex}
      #escOverlay{position:fixed;inset:0;z-index:950;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);
        display:none;align-items:stretch;justify-content:center}
      #escOverlay.on{display:flex}
      .esc-panel{width:min(1100px,94vw);margin:28px auto;background:var(--surface-2);border:1px solid var(--border);
        border-radius:16px;overflow:auto;padding:22px 26px 30px}
      .esc-head{display:flex;align-items:center;gap:12px;margin-bottom:6px}
      .esc-head h1{font:700 20px 'Instrument Sans',sans-serif;margin:0}
      .esc-close{margin-left:auto;width:30px;height:30px;border-radius:8px;border:1px solid var(--border);
        background:var(--surface);color:var(--muted);cursor:pointer;font-size:15px}
      .esc-sec{margin-top:22px}
      .esc-sec h2{font:700 12px 'JetBrains Mono',monospace;letter-spacing:.08em;text-transform:uppercase;
        color:var(--text-2);display:flex;align-items:center;gap:8px;margin:0 0 12px}
      .esc-sec h2::after{content:"";flex:1;height:1px;background:var(--border);opacity:.6}
      .esc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
      .esc-desk{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:12px 14px;
        cursor:pointer;transition:border-color .12s;display:flex;flex-direction:column;gap:8px}
      .esc-desk:hover{border-color:var(--border-strong)}
      .esc-desk.ask{border-color:color-mix(in srgb,var(--warn) 55%,var(--border));background:color-mix(in srgb,var(--warn) 6%,var(--surface))}
      .esc-drow{display:flex;align-items:center;gap:9px;min-width:0}
      .esc-av{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:12px;font-weight:800;color:#08110c;flex:none}
      .esc-nm{font-weight:700;font-size:13px}
      .esc-proj{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}
      .esc-title{font-size:12.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .esc-live{font-size:11.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .esc-q{font-size:12.5px;color:var(--text);line-height:1.5}
      .esc-foot{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted)}
      .esc-dot{width:8px;height:8px;border-radius:50%;flex:none}
      .esc-empty{color:var(--muted);font-size:12.5px;padding:6px 2px}
      .esc-btn{align-self:flex-start;padding:5px 12px;border-radius:8px;border:1px solid var(--accent);
        background:transparent;color:var(--accent);font-weight:600;font-size:11.5px;cursor:pointer}
    `;
    document.head.appendChild(style);

    const launch = document.createElement("button");
    launch.id = "escLaunch";
    launch.innerHTML = `🏢 Escritório <span class="escbadge" id="escBadge">0</span>`;
    launch.title = "Escritório de agentes — todos os agentes, todos os projetos";
    launch.onclick = openEsc;
    document.body.appendChild(launch);

    const ov = document.createElement("div");
    ov.id = "escOverlay";
    ov.innerHTML = `<div class="esc-panel" id="escPanel"></div>`;
    ov.addEventListener("click", (e) => { if (e.target.id === "escOverlay") closeEsc(); });
    document.body.appendChild(ov);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.classList.contains("on")) closeEsc(); });
  }

  function tasks() { try { return (typeof boardSource === "function" ? boardSource() : (state.tasks || [])); } catch (_) { return state.tasks || []; } }
  function asking(t) { try { return (typeof pendingOf === "function" ? pendingOf(t.id) : []); } catch (_) { return []; } }
  function isActive(t) { try { return ACTIVE_ST.has(t.status) || t.status === "thinking"; } catch (_) { return false; } }

  function deskCard(t, withQ) {
    const q = asking(t);
    const dot = q.length ? "var(--warn)" : isActive(t) ? "var(--good)" : "var(--muted)";
    const av = `<span class="esc-av" style="background:${agentColor(t.agent)}">${agentBadge(t.agent)}</span>`;
    const proj = esc(t.proj || (typeof projShort === "function" ? projShort(t.repo || state.repo) : "") || "");
    const ev = (typeof lastEventOf === "function" ? lastEventOf(t.id) : null);
    const cost = (typeof taskCost === "function" ? taskCost(t.id) : { usd: 0 });
    const live = q.length ? `<b style="color:var(--warn)">${esc(q[0].agent || t.agent)} perguntou</b>`
      : ev ? esc(String(ev.text || "").slice(0, 80)) : "iniciando…";
    const qhtml = withQ && q.length ? `<div class="esc-q">“${esc(String(q[0].prompt || "").slice(0, 160))}”</div>` : "";
    return `<div class="esc-desk${q.length ? " ask" : ""}" data-esc="${escA(t.id)}" data-repo="${escA(t.repo || "")}">
      <div class="esc-drow">${av}<div style="min-width:0;flex:1"><div class="esc-nm">${esc(t.agent || "—")} <span class="esc-proj">· ${proj}</span></div><div class="esc-title">${esc(t.title || "")}</div></div><span class="esc-dot" style="background:${dot}"></span></div>
      ${qhtml}
      <div class="esc-live">${live}</div>
      <div class="esc-foot">${cost.usd > 0 ? `<span>${fmtUsd(cost.usd)}</span>` : ""}${withQ && q.length ? `<button class="esc-btn" data-escopen="${escA(t.id)}" data-repo="${escA(t.repo || "")}">responder →</button>` : ""}</div>
    </div>`;
  }

  function renderEsc() {
    const panel = document.getElementById("escPanel");
    if (!panel) return;
    const all = tasks().filter((t) => t && !(t.flag === "closed" || ["merged", "done"].includes(t.status)));
    const wait = all.filter((t) => asking(t).length);
    const working = all.filter((t) => isActive(t) && !asking(t).length);
    // agrupa "trabalhando" por projeto
    const byProj = new Map();
    for (const t of working) { const k = t.proj || (typeof projShort === "function" ? projShort(t.repo || state.repo) : "—"); if (!byProj.has(k)) byProj.set(k, []); byProj.get(k).push(t); }

    const badge = document.getElementById("escBadge");
    if (badge) { badge.textContent = String(wait.length); badge.classList.toggle("on", wait.length > 0); }

    panel.innerHTML =
      `<div class="esc-head"><h1>🏢 Escritório de agentes</h1><span class="dim" style="font-size:12.5px">todos os agentes, todos os projetos</span><button class="esc-close" id="escCloseBtn">✕</button></div>` +
      `<div class="esc-sec"><h2>✋ Precisam de você <span style="color:var(--warn)">${wait.length}</span></h2>` +
      (wait.length ? `<div class="esc-grid">${wait.map((t) => deskCard(t, true)).join("")}</div>` : `<div class="esc-empty">nada aguardando resposta — tudo fluindo ✓</div>`) +
      `</div>` +
      `<div class="esc-sec"><h2>💺 Trabalhando agora <span style="color:var(--good)">${working.length}</span></h2>` +
      (working.length ? [...byProj.entries()].map(([k, list]) =>
        `<div style="margin-bottom:14px"><div class="esc-proj" style="margin:0 0 8px 2px">${esc(k)} · ${list.length}</div><div class="esc-grid">${list.map((t) => deskCard(t, false)).join("")}</div></div>`
      ).join("") : `<div class="esc-empty">nenhum agente rodando agora.</div>`) +
      `</div>`;

    const cb = document.getElementById("escCloseBtn"); if (cb) cb.onclick = closeEsc;
    panel.querySelectorAll("[data-esc], [data-escopen]").forEach((el) => {
      el.onclick = (e) => { e.stopPropagation(); const id = el.dataset.escopen || el.dataset.esc; const repo = el.dataset.repo; escGoto(id, repo); };
    });
  }

  function escGoto(id, repo) {
    closeEsc();
    try {
      if (repo && repo !== state.repo && typeof switchToProjectTask === "function") { switchToProjectTask(repo, id); return; }
      if (typeof selected !== "undefined") selected = id;
      if (typeof render === "function") render();
      if (typeof openWorkspace === "function") openWorkspace(id);
    } catch (err) { console.error("[escritorio] abrir tarefa falhou:", err); }
  }

  function openEsc() {
    ensureDom();
    document.getElementById("escOverlay").classList.add("on");
    renderEsc();
    clearInterval(escTimer);
    escTimer = setInterval(renderEsc, 2000); // atualiza ao vivo enquanto aberto
  }
  function closeEsc() {
    const ov = document.getElementById("escOverlay"); if (ov) ov.classList.remove("on");
    clearInterval(escTimer); escTimer = null;
  }

  window.openEscritorio = openEsc;

  // badge de atenção acompanha mesmo com o overlay fechado (atualiza a cada 3s)
  function tickBadge() {
    if (!document.getElementById("escBadge")) return;
    if (document.getElementById("escOverlay")?.classList.contains("on")) return; // renderEsc já cuida
    try {
      const n = tasks().filter((t) => t && !(t.flag === "closed" || ["merged", "done"].includes(t.status)) && asking(t).length).length;
      const b = document.getElementById("escBadge"); if (b) { b.textContent = String(n); b.classList.toggle("on", n > 0); }
    } catch (_) { /* ignora */ }
  }
  function boot() { ensureDom(); setInterval(tickBadge, 3000); }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
