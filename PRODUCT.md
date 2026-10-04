# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop app built with Tauri v2: the UI is HTML/CSS/vanilla JS in a WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. Designed for desktop windows, including narrow split panes.)

## Users

Primary: developers and tech leads working in a team (daily use at the owner's company). They run several AI-agent demands in parallel, each on its own branch/worktree, and review diffs, proofs and PRs before merging. They switch constantly between tasks, the running app, docs and the agent chat.

Secondary (confirmed, lower priority): vibe coders and non-developers who want a finished, proven deliverable without reading code. They use the same screens; what changes is driven by the type of deliverable, never by a separate "simple mode".

## Product Purpose

Starfork orchestrates AI coding agents (Claude Code, Codex, DeepSeek) on "demandas" (tasks). Each demand gets a BMAD plan with verifiable requirements. Agents work in isolated branches, attach proof per requirement (screenshots, videos, test output), and a gate blocks delivery without proof. Success means the person ships correct work faster without leaving the app.

## Positioning

"Tudo num lugar só" is the differentiator the design must make most evident. In one workspace, the person has:
- demands side by side;
- the running app (Prévia / "Subir ambiente");
- a real browser (any site);
- the iOS/Android simulator;
- documents;
- the agent conversation.

There is nothing else to open. Underneath it sits the verification layer (plan → proof per requirement → gate), which neighboring tools such as Orca (a dev cockpit with terminals and editors) don't have.

## Operating Context

The app is used all day next to Slack and the browser on a 13–16" Mac, often with the window split. A typical day:
- create a demand ("Nova demanda");
- watch agents work (Central board, sidebar per project);
- open a task: Entrega, Código, Conversa, Revisão, Prévia and PR modes, with the chat on the right;
- split the top-level tab bar into up to 3 panes (demands, Navegador, Simulador, Documento);
- review and merge.

Team cloud board, usage meter, and autopilot runs.

## Capabilities and Constraints

- **Tabs, not modals:** new flows open as tabs (top-level tab bar). Floating modals are disliked.
- **Task screen:** keep the existing task mode menu (Entrega | Código | Conversa | Revisão | Prévia | PR). In narrow panes it collapses into a dropdown. The canvas lives at the top tab bar, not inside the task.
- **Performance is a hard constraint:**
  - the app previously hit 100–200% CPU;
  - only visible panes run;
  - at most 2 live webviews and 1 device stream;
  - idle CPU stays low;
  - no polling loops.
- **Panel vetoes:**
  - no free shell/terminal;
  - logs only behind "ver detalhes";
  - no empty pane without guidance in Portuguese;
  - no recursive split.
- **UI language:** Brazilian Portuguese.

## Brand Commitments

- Name **Starfork** and the current green logo/icon must not change.
- Everything else in the visual identity (theme, palette, typography, components) may be rethought.

## Evidence on Hand

- Real screens of the current UI in `_bmad-output/party-canvas/` (`9.png`) and `_bmad-output/prints-canvas/`.
- Persona panel decisions in `_bmad-output/party-canvas/decisao.md`; older ones in `docs/ux-auditoria/party-mode-decisao.md`.
- The Pou autopilot run proofs are in `_bmad-output/provas-pou/`.
- No customer testimonials, metrics or pricing claims exist. Do not fabricate any.

## Product Principles

1. **Everything in one place, without clutter.** Each added surface must be quieter than the work it hosts.
2. **The work is the hero.** Demands, the running app and proofs get the space; chrome recedes.
3. **Proof over promise.** Status, requirements and proofs are always one glance away.
4. **Fast and calm.** Nothing animates or runs when it isn't visible, and the app never makes the Mac hot.
5. **Plain Portuguese.** Actions and errors say what to do next.

## Accessibility & Inclusion

Keyboard operation for menus, tabs and split panes, with existing patterns in `app/src/js/54-acessibilidade.js` and `app/src/css/88-acessibilidade.css`. Visible focus. aria roles on menus and tabs. Text must stay legible in narrow panes.
