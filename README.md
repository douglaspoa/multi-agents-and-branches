# 🐙 Cardume — Fase 0 (núcleo)

Orquestrador de múltiplos agentes de IA em branches paralelas do mesmo repo.
Esta é a **Fase 0**: o núcleo de orquestração, ainda sem shell desktop. Prova o loop
completo — **worktree → agente → eventos → SQLite → leitura ao vivo** — rodando de
verdade, com git worktrees reais e um barramento de coordenação entre agentes.

Núcleo em **TypeScript zero-dependência**: roda direto no Node 22 (type-stripping) e usa
o **SQLite nativo** (`node:sqlite`). Nada de `npm install` para rodar.

## Rodar

```bash
# demo: 2 agentes em paralelo (mock), com colisão de arquivo resolvida
npm run demo

# ou o CLI direto
node --disable-warning=ExperimentalWarning src/cli.ts <comando>
```

Comandos:

| Comando | O que faz |
|---|---|
| `cardume demo` | Loop completo self-contained: cria um repo de exemplo e roda Íris + Onda em paralelo (motor mock). |
| `cardume init [--repo <p>]` | Prepara `.cardume/` num repo git existente. |
| `cardume new --title "..." [--owns a,b] [--off x] [--engine mock\|claude]` | Cria branch+worktree, escreve o `TASK.yaml`, roda o agente. |
| `cardume list [--repo <p>]` | Estado das tarefas (lê o SQLite). |
| `cardume watch [--repo <p>]` | Acompanha ao vivo — **é o "app lendo o DB"**. |
| `cardume logs <taskId> [--repo <p>]` | Eventos de uma tarefa. |
| `cardume rm <taskId> [--repo <p>]` | Remove worktree + branch + registros. |

Rodar num repo de verdade com o **Claude Code** (não a API):

```bash
node src/cli.ts init --repo /caminho/do/seu/repo
node src/cli.ts new --repo /caminho/do/seu/repo \
  --title "Corrige exportação em PDF" \
  --agent "Íris" \
  --owns "src/report/export,src/components/ReportHeader.tsx" \
  --off "src/checkout" \
  --engine claude --model opus-5
```

> `--engine claude` roda `claude -p --output-format stream-json` dentro da worktree,
> usando **sua assinatura do Claude Code**. O parser do stream (`src/engine/claude.ts`)
> é best-effort e pode precisar de ajuste conforme a versão do Claude Code.

## Arquitetura

```
src/
  types.ts            TaskSpec, rows do DB, slugify
  workspace.ts        resolve/cria .cardume/ (worktrees + state.sqlite)
  git.ts              GitService — worktree add/remove/list, commit, diffstat
  store.ts            Store — SQLite (node:sqlite): task/event/claim/diffstat
  bus.ts              CoordinationBus — claim/colisão (first-claim-wins) + system-context
  orchestrator.ts     amarra git + store + bus + engine
  engine/
    types.ts          interface AgentEngine (o motor é plugável)
    mock.ts           MockEngine — sem IA, escreve arquivos reais (diff verdadeiro)
    claude.ts         ClaudeEngine — claude -p headless, parse do stream-json
  cli.ts              comandos + render em ANSI (pele "terminal")
  util/               run (execFile), yaml (serializa TASK.yaml), ansi (cores)
```

O contrato central é a interface `AgentEngine` — o núcleo nunca fala com "Claude" direto,
fala com essa interface. Trocar/somar motor = escrever um adapter.

## O que já está provado (evidências reais no `npm run demo`)

- Cada tarefa ganha uma **git worktree** isolada na sua branch (`git worktree list`).
- Os agentes escrevem **arquivos e commits reais** nas suas branches.
- O **barramento** detecta colisão de arquivo e resolve por first-claim-wins
  (Onda cede `Header.tsx` à Íris; Íris cede `format.ts` à Onda).
- Tudo é persistido no **SQLite**, que o `watch`/`list` leem — o mesmo DB que o shell
  desktop (Electron/Tauri) vai consumir na Fase 1.

## Próximos passos (Fase 1+)

- **Hooks + MCP**: no produto final, o agente reporta via hooks (`PostToolUse`/`Stop`
  gravando no SQLite) e via um **servidor MCP** hospedado pelo app expondo
  `claim`/`release`/`ask_human`. Aqui na Fase 0 o orquestrador faz esse papel.
- **Shell desktop** (Electron reusa este núcleo direto; Tauri o consome como sidecar) —
  o grafo + Kanban do protótipo, na pele Terminal.
- **Streaming ao vivo** do `new` (hoje ele roda até concluir; falta o modo detached +
  `watch` acompanhando em outra aba).
