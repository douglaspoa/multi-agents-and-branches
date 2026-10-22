# 02 · Concorrentes

[← voltar ao índice](README.md)

Pesquisa de 14/10/2026 nos sites oficiais. **[V]** = confirmado no site atual; **[NV]** = não verificado (fonte de terceiros).
O estilo visual foi tirado do HTML bruto (fontes, `theme-color`, classes), então pode ter pequenas imprecisões.

## Visão geral

| Concorrente | Site | Modelo | Preço de entrada | Selo de confiança | Status |
|---|---|---|---|---|---|
| Conductor (Melty Labs, YC S24) | [conductor.build](https://www.conductor.build) | Desktop Mac → cloud (Firecracker) | Free · Pro US$ 50/mês | SOC 2 Type II, "100k+ builders" | Ativo |
| Superset | [superset.sh](https://superset.sh) | Desktop (Electron → Rust) | Free · Pro US$ 20/usuário | SOC 2 Type II, 15,1k ⭐ | Ativo |
| Orca (YC) | [onorca.dev](https://onorca.dev) | "Agent IDE", desktop + mobile | Grátis (MIT) | "Backed by YC" | Ativo |
| Vibe Kanban (Bloop) | [vibekanban.com](https://vibekanban.com) | Kanban + agentes | Era Free · Pro US$ 30 | 30k usuários ativos, 100k PRs | **Encerrado** ([shutdown](https://vibekanban.com/shutdown)) |
| Crystal → Nimbalyst (Stravu) | [nimbalyst.com](https://nimbalyst.com) | Workspace visual | Grátis para indivíduos | SOC 2 Type 2, logos | Crystal **descontinuado** |
| Claude Squad | [GitHub](https://github.com/smtg-ai/claude-squad) | TUI (tmux) | Grátis (AGPL) | 8,6k ⭐ | Ativo |
| Sculptor (Imbue) | [imbue.com/sculptor](https://imbue.com/sculptor) | Desktop com containers | Research preview | — | Preview |
| Warp | [warp.dev](https://www.warp.dev) | "Software factories" na nuvem | Por uso | 800k+ devs, logos | Ativo (pivotou) |
| Devin (Cognition) | [devin.ai](https://devin.ai) | Agente na nuvem + Devin Desktop (ex-Windsurf) | ~US$ 20 + ACUs | SOC 2, ISO 27001, Series E | Ativo |
| Factory | [factory.ai](https://factory.ai) | "Software factory" enterprise | Não publicado [NV] | Enterprise | Ativo |
| Cursor | [cursor.com](https://cursor.com) | IDE + cloud agents | Cloud agents a partir de US$ 30 | Enorme base | Ativo |
| Terragon | [terragonlabs.com](https://terragonlabs.com) | Agentes na nuvem | — | — | **Encerrado** |

Outros clones vistos nas redes (ver [04-redes-e-anuncios.md](04-redes-e-anuncios.md)): Tempest, Termic, herdr, T3 Code, Emdash,
Polyscope, JetBrains Air, Zed (agentes paralelos nativos), Maestro, Auto-Claude, Automaker, GasTown, Warpforge.

**Padrão de preço do mercado:** plano grátis permanente + Pro de US$ 20–50 por usuário + Enterprise "fale conosco".
O Starfork (só trial de 7 dias) é a exceção. Em reais, R$ 99,90 para até 6 pessoas é barato, mas sem plano grátis o topo do funil fica menor.

---

## Detalhe por concorrente

### 1. Conductor — [conductor.build](https://www.conductor.build) [V]

- **Hero:** *"Run a team of coding agents in the cloud."* Mudou o foco do app para Mac para o **Conductor Cloud** (microVMs Firecracker).
- **Visual:** tema claro e escuro (segue o sistema), tons **quentes e terrosos** (`#eae8e6` / `#2c2826`), detalhes em mono. A UI aparece como um mockup "vivo", com usuários de nome de compositor (*"Ludwig has entered the chat"*).
- **Estrutura:** multiplayer → sandbox na nuvem → "BYO subscription" → *"Conduct from anywhere"* (desktop, iOS, API) → **changelog datado na home** → depoimentos → *"Trusted by 100k+ builders"* → SOC 2 Type II e trust center → parceria com a Vercel.
- **Preço:** Free · Pro US$ 50/mês · Teams US$ 60/usuário · Enterprise (SAML/SCIM, DPA, SLA).
- **Por que parece sério:** tom calmo, changelog mostrando ritmo, SOC 2, página Enterprise.
- **UX para copiar:** link de workspace compartilhável (⌘⇧C), **presença** de quem está ativo, "seguir" workspaces, prompt em conjunto.
- **Ponto fraco (nas redes):** agentes **sem sandbox**: *"Agents run directly on your system without sandboxing"* ([FAQ](https://www.conductor.build/docs/faq#what-permissions-do-agents-have)). Antes era só Mac com Apple Silicon.

### 2. Superset — [superset.sh](https://superset.sh) [V]

- **Hero:** *"Bring Any Agent Orchestrate Them All"* + *"Free to start · No credit card required"*.
- **Visual:** escuro, **Inter + IBM Plex Mono**, mockups reais com abas no hero (Orchestrate, Automate, Remote, Changes).
- **Estrutura:** são 14 seções. Tem logos (Microsoft, OpenAI, Google, Vercel…), **11 depoimentos tirados do X**, 15,1k stars, selo SOC 2 Type II, página Security, FAQ e CTA final.
- **Preço:** Free · Pro US$ 20/usuário/mês (US$ 15 no anual) · Enterprise (SSO, audit logs, SLA).
- **UX para copiar:** status agrupado ("In Progress / Ready for Review"), **avisa quando o agente precisa de você**, automações agendadas que abrem PR, hosts remotos via SSH, deep-link para IDEs, CLI/SDK/MCP, app de iPhone e iPad para revisar diffs.
- **Marketing:** mantém **páginas de comparação para SEO** ("Superset vs Crystal") e o fundador responde pessoalmente no Reddit.
- **Ponto fraco:** licença ELv2 (source-available, não open source) [fonte secundária]. Está migrando de Electron para Rust.

### 3. Orca — [onorca.dev](https://onorca.dev) [V]

- **Hero:** *"Ship 100x with the agent IDE"*, posicionado como "Agent Development Environment". Exibe "Backed by Y Combinator".
- **Visual:** escuro, cards em estilo pôster e "Click to inspect".
- **Estrutura:** tabela comparativa contra IDEs e wrappers, FAQ com 10 perguntas, depoimentos do X. Declara ~91,8k stars [NV, número suspeito].
- **Preço:** grátis (MIT), com página Enterprise.
- **UX para copiar:** **um prompt para vários agentes, para comparar e mergear o melhor**; **"Design mode"** (clicar num elemento manda HTML, CSS e screenshot ao agente); comentários inline no diff que voltam ao agente; troca de conta e medição de uso do Claude e do Codex; apps iOS e Android.
- **No Brasil:** citado no r/brdev por causa do **app de celular**.

### 4. Vibe Kanban — [vibekanban.com](https://vibekanban.com) [V] — encerrado

- **Hero:** *"Your Engineering Bottleneck Has Shifted"* / *"Accelerate the human planning and review your coding agents are waiting on"*.
- **Estrutura:** Plan → Prompt → Review com screenshots e setas desenhadas à mão, depoimentos (Addy Osmani, Theo, ElevenLabs), "100,000 PRs", "30,000 active users".
- **Preço:** era Free · Pro US$ 30/usuário · Enterprise.
- **Fim:** a Bloop anunciou o encerramento em 10/04/2026 ([shutdown](https://vibekanban.com/shutdown)) e os serviços remotos foram desligados em 30 dias. Hoje é mantido pela comunidade, inclusive por um dev brasileiro (ver [04](04-redes-e-anuncios.md)).
- **UX para copiar:** **status da issue avança sozinho** (agente começou, PR aberto, PR mergeado); criar worktree a partir de qualquer PR.
- **Lição:** a maioria dos usuários era free, então cobrar desde cedo (como o Starfork) tem fundamento.

### 5. Crystal → Nimbalyst — [nimbalyst.com](https://nimbalyst.com) [V]

- **Situação:** o Crystal foi descontinuado (v0.3.5, fev/2026) e o repositório diz *"Crystal is now Nimbalyst"* ([GitHub](https://github.com/stravu/crystal)).
- **Hero:** *"The visual workspace for Codex and Claude Code"*.
- **Visual:** **claro**, Inter, acento roxo, cantos arredondados e sombras suaves.
- **Confiança:** logos (Amazon, Zillow, Twilio, Vanta), SOC 2 Type 2, código MIT.
- **Preço:** grátis para indivíduos; Teams grátis durante o beta.
- **UX para copiar:** Kanban de sessões, sidebar de arquivos editados com commit feito por IA, aprovar cada edição no diff inline, editores visuais (Mermaid, Excalidraw, mockups), app iOS.

### 6. Claude Squad — [github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) [V]

- TUI sobre tmux e worktrees, AGPL-3.0, 8,6k stars. **Não tem landing nem preço.**
- É a referência indie pura, só com README.
- Issues relevantes: **#260** (hook de setup de ambiente: deps, `.env`, portas), **#275** (pty não funciona no Windows), **#266** (prompt perdido antes de a CLI ficar pronta).

### 7. Sculptor — [imbue.com/sculptor](https://imbue.com/sculptor) [V]

- **Hero:** *"Sculptor: the missing UI for parallel coding agents"*.
- **Landing:** é um post de blog com GIFs de demo em 1920×1080, assinado pelo CEO e marcado como "research preview". Não mostra logos nem preço.
- **UX para copiar:** containers em vez de worktrees, **"Pairing Mode"** (sincroniza o trabalho do agente com o repo local), conflitos de merge devolvidos ao agente, histórico de sessão reabrível.
- **Ponto fraco:** Electron pesado mesmo parado ([HN](https://news.ycombinator.com/item?id=45462236): *"switching from Electron to Tauri?"*). **Nós já usamos Tauri.**

### 8. Warp — [warp.dev](https://www.warp.dev) [V]

- **Posicionamento:** pivotou para *"Open infrastructure for cloud software factories"*.
- **Visual:** fonte Matter, estética de terminal (`>_`, legendas "fig.", copy em minúsculas) e um grid "factory" ao vivo com status **queued / working / waiting / shipped**.
- **Confiança:** "800k+ devs", logos (Anthropic, OpenAI, Nvidia), case da Docker com **custo por PR caindo de US$ 80 para US$ 30**, "book a demo".
- **Preço:** por uso (por execução de agente). Mudou o modelo em dez/2025 ([blog](https://www.warp.dev/blog/warp-new-pricing-flexibility-byok)).
- **UX para copiar:** **custo por PR detalhado** (compute, plataforma, inferência), agentes que gravam screenshot ou vídeo antes do PR, gates de aprovação.

### 9. Devin — [devin.ai](https://devin.ai) [V]

- **Hero:** *"Meet Devin, your team's autonomous software engineer"*. O meta fala em *"Parallel cloud agents for serious engineering teams"*.
- **Visual:** claro. **O hero é uma sessão real**: "Add enterprise SSO" → *"Here's the PR… I tested setup, sign-in… in the browser"*.
- **Confiança:** Citi e Ramp, SOC 2, ISO 27001, Series E, mais de US$ 1 bi de receita anualizada.
- **Produto novo:** **Devin Desktop** (o antigo Windsurf), uma "agent command center" que coordena Claude, Codex e Devins, ou seja, concorrente direto nosso.
- **UX para copiar:** a sessão termina com um resumo do que foi testado + o PR; Wiki do repositório.
- **Anúncios:** é quem mais investe (ver [04](04-redes-e-anuncios.md)).

### 10. Factory — [factory.ai](https://factory.ai) [V]

- **Hero:** *"Build Your Software Factory"* com efeito de texto que se embaralha.
- **Visual:** claro por padrão (`#f5f5f5`), com alternância de tema.
- **Copy:** totalmente enterprise (*"Sovereign, Model-Independent"*, *"Measurable Business Value"*).
- **UX para copiar:** Mission Control, **Analytics por desenvolvedor e por time**, nota de **"Agent Readiness"** por repositório, Automations.

### 11. Cursor — [cursor.com](https://cursor.com)

- **Hero:** *"Cursor is your coding agent for building ambitious software"*, com fonte serifada na home.
- **Preço:** cloud agents só a partir do Premium (US$ 30); Teams US$ 30+/usuário.
- **Pontos fracos:** gasto surpresa e suporte por bot (ver [03](03-reclamacoes.md)). Os background agents exigiam o privacy mode desligado ([docs](https://docs.cursor.com/background-agent)).

### 12. Terragon — [terragonlabs.com](https://terragonlabs.com)

- A página mostra só **"Terragon Shutdown"**. Encerrado.

---

## 8 lições para o Starfork

| # | Lição | De quem | Aplicação |
|---|---|---|---|
| 1 | **Hero = UI real em funcionamento**, não ilustração | Devin, Conductor | Demo animada: pedido → 3 agentes → prova por requisito → aprovar |
| 2 | **Faixa de confiança logo abaixo do hero** | Superset, Nimbalyst, Devin | Números reais + 3 depoimentos com nome, cargo e foto |
| 3 | **Páginas de Segurança e Enterprise** | Conductor, Superset, Devin | Sem certificação ainda: publicar a política e o roadmap com datas |
| 4 | **Changelog datado na home** | Conductor, Orca | Gerado dos PRs mergeados |
| 5 | **Vender a prova como métrica de negócio** | Warp, Factory | Painel de custo por entrega e % aprovado na primeira revisão |
| 6 | **Design system escuro sóbrio e status com legenda fixa** | Superset, Warp | 4 estados no app |
| 7 | **Colaboração ao vivo e status automático** | Conductor, Vibe Kanban | Presença no time e card que avança sozinho |
| 8 | **Plano grátis + comparativos + FAQ** | Todos | Destacar o que só nós temos: épicos/ondas, prova por requisito, R$, Windows |
