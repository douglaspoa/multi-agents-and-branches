# Fosso do Cardume — Coordenação + Verificação

> Intenção → arquitetura → resultado. Base para o time entender **por que** este
> trabalho existe e **o que** já está no código.

## 1. Intenção (por que)

Pesquisa de voz do cliente (VoC) na categoria "rodar múltiplos agentes de código
em paralelo" apontou 5 dores. Cruzando com o que o Cardume já faz, o **fosso**
— o que nos diferencia e o que ninguém resolve — está em **coordenação** e
**verificação**, não em "mais engines" nem em mais telas.

Evidência das dores (verbatims públicos, com fonte):
- **Manter o estado de N agentes na cabeça** — *"keep the state of every agent in
  your head... is brutal"* ([gijs.substack.com](https://gijs.substack.com/p/running-multiple-ai-agents-in-parallel));
  *"I spend most of my time babysitting agents"* ([addyo.substack.com](https://addyo.substack.com/p/the-80-problem-in-agentic-coding)).
- **Paralelismo quebra sem arquitetura / conflito de merge** *(gap real — ninguém resolve)* —
  *"merge-conflict avoidance is an architecture property, not a git technique"*
  ([metacircuits.substack.com](https://metacircuits.substack.com/p/managing-parallel-coding-agents-without/comments)).
- **"Quase certo, mas não" / dívida técnica** — *"reviewing AI-generated logic
  actually requires more effort than reviewing human-written code"* ([addyo](https://addyo.substack.com/p/the-80-problem-in-agentic-coding)).

Concorrência (fraquezas para battle-card):
- **Devin:** ~15% de sucesso em tarefas reais ([theregister.com](https://www.theregister.com/2025/01/23/ai_developer_devin_poor_reviews)).
- **Cursor:** backlash de pricing, CEO pediu desculpa ([finance.yahoo.com](https://finance.yahoo.com/news/cursor-apologizes-unclear-pricing-changes-225709399.html)).
- **Claude Code + worktree (DIY):** abas statless não trocam contexto — que é
  justamente onde o hub de conversas do Cardume **ganha**.

## 2. Árvore de oportunidade (OST)

**Outcome:** ser o padrão pra "rodar muitos agentes em paralelo **sem virar caos**".
Métrica-alvo (a instrumentar): nº de tarefas paralelas sustentadas sobe; taxa de
merge sem conflito manual sobe; intervenções humanas não-planejadas caem.

| Oportunidade (dor) | Solução priorizada | POC |
|---|---|---|
| O1 — overlap só aparece no merge | Detecção **proativa** de sobreposição na criação | ✅ deste PR |
| O2 — não dá pra confiar sem revisar tudo | Gate mecânico de provas + check de redundância | próximo |
| O3 — perde-se o fio de quem faz o quê | "Escritório de agentes" (visão cross-projeto) | próximo |

**POC escolhido:** detecção proativa de overlap (O1) — o diferencial que ninguém
tem. Experimento: instrumentar baseline → concierge (marcar overlap manualmente em
demandas reais) → se antecipar ≥70% dos conflitos, construir o motor completo.

## 3. Arquitetura (o que foi construído)

Tudo aditivo e com **fonte única no núcleo TS**; a GUI só faz proxy.

### Núcleo (TypeScript)
- [`src/glob.ts`](../src/glob.ts) — glob mínimo zero-dep (`**`, `*`, `?`):
  `globMatch()` e `globsOverlap()` (heurística feita pra **avisar**, não bloquear).
- [`src/bus.ts`](../src/bus.ts):
  - `detectScopeOverlap(store, spec)` — função **pura de leitura**: compara os
    `scope.owns` (globs) de uma demanda nova contra owns e claims de tarefas
    **ativas**. Roda na **criação**, não no merge.
  - `claim()` agora é **glob-aware**: um write em `src/auth/**` protege
    `src/auth/login.ts` (antes só casava caminho exato).
  - **Políticas de bus** (`BusPolicy`): `first-claim-wins` (padrão, comportamento
    preservado), `human-tiebreak` (rebaixa p/ read **e** abre pergunta ao humano
    via `pending`), `sequential-lock` (sinaliza `blocked` — honrar a espera na
    execução é o próximo passo do orquestrador).
- [`src/store.ts`](../src/store.ts) — `coordinationMetrics()`: baseline do "caos"
  (conflitos, colisões do bus, reworks) lendo tabelas existentes.
- [`src/orchestrator.ts`](../src/orchestrator.ts) — aplica `spec.autonomy.busPolicy`
  na criação e no run.
- [`src/cli.ts`](../src/cli.ts) — aviso não-bloqueante de overlap no `new`
  (`--no-overlap-check` silencia); comandos `metrics` e `overlap` (com `--json`);
  flag `--bus-policy`; **help corrigido** (comandos antes invisíveis: `merge`,
  `rework`, `talk`, `deliver`, `review-pr`, `start`).

### GUI (Tauri)
- [`app/src-tauri/src/lib.rs`](../app/src-tauri/src/lib.rs) — comandos
  `coordination_metrics` e `overlap_check`: proxy do CLI `--json` (lógica não
  duplicada em Rust).
- [`app/src/js/50-coordenacao.js`](../app/src/js/50-coordenacao.js) — API do front
  `window.Coordenacao.{ metrics, overlapCheck, overlapSummary }`.

## 4. Resultado (validação)

- Teste unitário do glob: **11/11**.
- E2E overlap: detecta tarefa ativa, ignora `conflict`/`merged`.
- 3 políticas de bus conferidas (first-claim-wins / human-tiebreak cria `pending` /
  sequential-lock emite `blocked`).
- `cardume metrics --json` e `overlap --json` OK.
- `cargo check` do backend Tauri: **compila** (comandos registrados).

### Como testar
```bash
# núcleo (num repo com workspace Cardume)
cardume metrics                       # baseline: conflitos, colisões, reworks
cardume overlap --owns "src/auth/**"  # checa contra tarefas ativas
cardume new --title "x" --owns "src/auth/login.ts"   # avisa se pisar em tarefa ativa
cardume new --title "y" --owns "src/**" --bus-policy human-tiebreak
```

## 5. O que ficou de fora (e por quê)
- **Unificar nome Cardume ⇄ Constellation (D1):** é decisão de produto (qual nome
  vence) e mexe em identificadores do app/bundle/mobile — não fazer no cego.
- **Tela de conflito assistida (E4):** grande; precisa de agente em worktree-scratch
  + UX nova. Base pronta (`orch_integrate` já reporta o conflito).
- **`sequential-lock` honrado na execução:** o bus já sinaliza `blocked`; falta o
  loop de espera no orquestrador.
- **Painel de coordenação (metrics) na tela:** a API (`window.Coordenacao.metrics`)
  e o comando Rust estão prontos; falta o widget no board de execuções.

## 6. Fiação visual já feita (Nova demanda)
- **Aviso ao iniciar:** `submitNewTask` (build) chama `overlapCheck(owns)` e, se
  houver sobreposição com tarefa ativa, mostra um `confirm` antes de rodar
  ([app/src/js/32-planner.js](../app/src/js/32-planner.js)) — melhor negar aqui do
  que resolver conflito no merge.
- **Dica ao vivo:** enquanto digita o escopo em `#ntOwns`, um aviso aparece embaixo
  do campo ([app/src/js/50-coordenacao.js](../app/src/js/50-coordenacao.js)) — auto-
  fiado sem tocar os módulos de tela existentes.
