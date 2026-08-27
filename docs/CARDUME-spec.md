# Cardume — Spec & Plano Técnico

> Um "GitKraken para múltiplos agentes de IA": você abre várias tarefas no mesmo
> repositório, cada agente trabalha na sua própria branch **em paralelo e isolado**,
> todos sabem uns dos outros através de um **barramento de coordenação**, e tudo é
> visual — grafo de branches + quadro de tarefas.

`Cardume` é um nome-código (um cardume de agentes nadando juntos). Troque à vontade.

---

## 1. Visão

| | |
|---|---|
| **O que é** | App desktop que orquestra N agentes de código rodando no mesmo repo, cada um em sua branch. |
| **Para quem** | Você (dev solo tocando várias frentes) e, depois, times pequenos. |
| **O trabalho principal** | Abrir tarefas → ver os agentes trabalhando lado a lado → revisar → fazer merge, sem que eles se atropelem. |
| **O diferencial** | (1) Isolamento real via *git worktrees*. (2) **Coordenação**: agentes cientes uns dos outros. (3) Visual estilo GitKraken. |
| **Plataformas** | macOS primeiro; Windows e Linux com o mesmo código. |
| **Motor de agente** | Começa com Claude (headless); arquitetura **plugável** para trocar/somar motores. |

---

## 2. As três ideias que sustentam o produto

### 2.1 Isolamento — um *git worktree* por tarefa

O ponto-chave para vários agentes editarem o mesmo repo **sem conflito de arquivo** é
não colocá-los na mesma pasta. `git worktree` cria cópias de trabalho independentes,
cada uma numa branch, compartilhando o mesmo `.git`.

```
meu-repo/                       ← seu checkout principal (você usa normalmente)
└── .cardume/
    ├── worktrees/
    │   ├── login-2fa/          → branch agent/login-2fa      (Agente Íris)
    │   ├── checkout-refactor/  → branch agent/checkout-refactor (Agente Ágata)
    │   ├── api-ratelimit/      → branch agent/api-ratelimit  (Agente Onda)
    │   └── fix-nav-mobile/     → branch agent/fix-nav-mobile (Agente Vinca)
    ├── bus.json                ← barramento de coordenação (o "mural")
    └── state.sqlite            ← tarefas, agentes, logs, histórico
```

Cada agente `cd` na sua worktree e edita à vontade. Merge é uma operação de git normal
quando a tarefa termina.

### 2.2 Coordenação — o barramento (`bus.json`)

É o que faz os agentes **"saberem que existem outros agentes"**. Um arquivo/serviço
compartilhado que todos leem e escrevem:

- Cada agente **reivindica** ("claim") os caminhos que pretende tocar antes de mexer.
- Antes de editar um arquivo, checa o barramento: *alguém já reivindicou isto?*
- Se houver sobreposição, aplica-se uma **política de resolução** (ver §6).
- O estado do barramento entra no **system prompt** de cada agente, então ele
  literalmente "lê o mural" a cada passo.

Exemplo de entrada:

```jsonc
{
  "claims": [
    { "agent": "iris",  "path": "src/auth/**",            "mode": "write", "since": "T+0" },
    { "agent": "iris",  "path": "src/components/Header.tsx","mode": "write", "since": "T+40" },
    { "agent": "onda",  "path": "src/api/middleware/**",   "mode": "write" },
    { "agent": "onda",  "path": "src/components/Header.tsx","mode": "read",  "yieldedTo": "iris" }
  ],
  "events": [
    { "t": "T+41", "type": "collision", "path": "src/components/Header.tsx",
      "winner": "iris", "reason": "first-claim", "loser": "onda" }
  ]
}
```

> No protótipo isso aparece na barra inferior ("⚠ colisão resolvida: Header.tsx → Onda cedeu a Íris")
> e no painel direito de cada agente.

### 2.3 Visual — grafo + quadro

- **Grafo de branches** (estilo GitKraken): cada agente é um avatar *na ponta* da sua
  branch, pulsando conforme o status (editando / pensando / revisar / conflito).
- **Quadro (Kanban)**: A fazer → Executando → Revisão → Bloqueado/Merged. Melhor para
  *tocar* várias tarefas; arrastar um card cria branch + worktree + dispara o agente.

---

## 3. Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  UI (WebView)  —  React + grafo (SVG/Canvas) + Kanban        │
│  Grafo · Quadro · Painel do agente · Barra de coordenação    │
└───────────────▲───────────────────────────┬─────────────────┘
                │ eventos (IPC/stream)        │ comandos
┌───────────────┴───────────────────────────▼─────────────────┐
│  NÚCLEO (Rust, se Tauri)  —  o "maestro"                     │
│                                                              │
│  ┌────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Git Service│  │ Coordination Bus│  │  Agent Runtime   │  │
│  │ worktrees, │◄─┤ claims, colisão,│─►│  1 processo por  │  │
│  │ grafo,     │  │ políticas,      │  │  worktree        │  │
│  │ merge/rebase│ │ eventos         │  │  (motor plugável)│  │
│  └────────────┘  └─────────────────┘  └────────┬─────────┘  │
│         state.sqlite  ·  bus.json               │            │
└─────────────────────────────────────────────────┼───────────┘
                                                   │ adapter
                    ┌──────────────────────────────┼──────────────┐
                    ▼              ▼                ▼              ▼
              Claude Code      Codex CLI       Gemini CLI      Ollama
              (headless)       (futuro)        (futuro)        (futuro)
```

**Fronteiras principais**

- **UI ↔ Núcleo**: a UI é burra; só renderiza estado e envia comandos. Todo o "trabalho
  real" (git, processos, coordenação) vive no núcleo. Isso mantém a UI trocável e o
  núcleo testável.
- **Núcleo ↔ Motor**: uma interface `AgentEngine` (ver §5) esconde *qual* CLI/SDK está
  rodando. Trocar Claude por outro é implementar um adapter — **nada engessado**.

---

## 4. Stack recomendada

| Camada | Escolha | Por quê |
|---|---|---|
| Shell desktop | **Tauri** (Rust + WebView) | Leve (~10 MB vs ~150 MB Electron), rápido para spawnar processos e falar com git via libgit2, um binário por SO. Cross-platform de verdade. |
| UI | **React + TypeScript + Vite** | Ecossistema maduro; grafo em SVG (interativo) ou Canvas (muitos nós). |
| Git | **git2-rs (libgit2)** para ler grafo/estado; **`git` CLI** para `worktree`, `rebase`, `merge` | libgit2 não cobre worktree tão bem quanto o CLI; misturar é normal. |
| Persistência | **SQLite** (via `sqlx`/`rusqlite`) + `bus.json` para o barramento | SQLite guarda tarefas/logs/histórico; JSON do barramento é fácil de o agente ler/escrever. |
| Motor inicial | **Claude Code headless** (`claude -p` / Agent SDK) | Você já vive nesse fluxo; suporta system prompt, tools, streaming de eventos. |

**Alternativa:** se preferir ficar 100% em JS/Node (curva menor, mais libs de git),
troque Tauri→**Electron** e Rust→**Node/TypeScript** no núcleo. Perde-se leveza,
ganha-se familiaridade. A arquitetura (as fronteiras acima) não muda.

---

## 5. Motor de agente plugável

O núcleo nunca fala com "Claude" diretamente — fala com uma interface:

```ts
interface AgentEngine {
  id: string;                         // "claude", "codex", "ollama"…
  displayName: string;                // "Claude · Opus 5"
  models(): Promise<Model[]>;

  // Inicia uma tarefa numa worktree e devolve um stream de eventos.
  run(input: {
    cwd: string;                      // caminho da worktree
    task: TaskSpec;                   // título, descrição, critérios
    systemContext: string;           // inclui o estado do barramento!
    tools: ToolPolicy;                // o que o agente pode fazer
  }): AsyncIterable<AgentEvent>;      // edit | bash | read | think | note | error | done

  stop(): Promise<void>;
}
```

- **Claude adapter**: roda `claude -p` (ou o Agent SDK) na worktree, injeta o estado do
  barramento no system prompt, faz parse do stream de eventos (tool calls, mensagens)
  para o formato `AgentEvent`.
- **Futuros adapters** (Codex, Gemini CLI, Ollama local): mesmo contrato. A UI mostra os
  motores disponíveis no seletor "Motor ▾" e marca os indisponíveis como "em breve".

Assim você começa com Claude sem se prender a ele.

---

## 5.1 Integração com Claude Code (e por que NÃO é "a API")

Desfazendo a confusão de nomes:

| Caminho | O que é | Usar? |
|---|---|---|
| **API da Anthropic** (`/messages`) | Você reimplementa o agente do zero (loop de tools, edição, git). | ❌ Não — é rebuildar o Claude Code. |
| **Claude Code headless** (`claude -p …`) | O próprio Claude Code, com todo o harness, usando **seu login/assinatura Max**. | ✅ É o motor do Cardume. |
| **Claude Agent SDK** (TS/Python) | O mesmo Claude Code como biblioteca, mesma auth. | ✅ Alternativa se preferir embutir. |

O motor é o **binário `claude` rodando headless dentro de cada worktree**. Autenticação
= sua assinatura do Claude Code. Sem API key.

### Os dois canais de comunicação

```
  APP (Cardume)                         CLAUDE CODE (headless, na worktree)
  ─────────────                         ──────────────────────────────────
                    (1) spawn + contexto
   cria worktree ─────────────────────►  claude -p "execute .cardume/TASK.yaml"
   escreve TASK.yaml                      --append-system-prompt "<estado do bus>"
                                          --mcp-config .cardume/mcp.json
                                          --output-format stream-json
                    ◄─────────────────────
                    (2a) stdout stream-json  → cada tool call / texto / diff
   atualiza UI      ◄─────────────────────
   (grafo, log,     (2b) hooks → escrevem no state.sqlite / bus.json
    diff, status)      (PostToolUse, Stop, Notification)
                    ◄─────────────────────
                    (2c) MCP: o agente CHAMA tools do app
                        claim(path) · release(path) · check_bus()
                        ask_human(pergunta) · report(status)
```

- **(2a) `--output-format stream-json`** — se o app dá o start, lê cada evento ao vivo.
  Alimenta o log de atividade e a detecção de diff.
- **(2b) Hooks → DB** — é a ideia do "Claude Code atualiza um DB que o app lê". Configure
  hooks no `.claude/settings.json` da worktree (`PostToolUse`, `Stop`, `Notification`)
  que gravam eventos no `state.sqlite`. **Funciona mesmo se você abrir o terminal você
  mesmo** — o app só observa o arquivo.
- **(2c) MCP hospedado pelo app** — o canal mais rico e bidirecional. O app sobe um
  servidor MCP `cardume-bus`; o Claude Code chama as tools dele. É onde vivem o
  barramento (`claim`/`release`/`check_bus`) e a tool **`ask_human(pergunta)`**.

### Como uma tarefa é iniciada

**Modo A — app gerencia (recomendado):** clicar "Nova tarefa" na UI *é* o start. O app
cria branch+worktree, escreve o `TASK.yaml` e roda por baixo:

```bash
cd .cardume/worktrees/<slug>
claude -p "Leia .cardume/TASK.yaml e execute a tarefa." \
  --append-system-prompt "$(cardume bus-context <slug>)" \
  --mcp-config .cardume/mcp.json \
  --output-format stream-json
# auth: sua assinatura do Claude Code (Max), sem API key
```

Você não digita em terminal nenhum — babá de 4 terminais não escala. Cada agente ganha
um botão "abrir terminal" pra você entrar no meio quando quiser.

**Modo B — você dirige, o app observa:** você abre um terminal na worktree e trabalha
interativo; o app enxerga tudo via hooks (2b) + MCP (2c) e atualiza a UI. O mesmo
substrato serve as duas ergonomias.

---

## 5.2 Spec de tarefa (estilo "context mesh")

Cada tarefa é um arquivo declarativo que o app gera a partir do formulário "Nova tarefa"
e escreve na worktree para o agente ler. É o "briefing" versionável da tarefa:

```yaml
# .cardume/TASK.yaml
id: adicionar-exportacao-pdf
title: Adicionar exportação em PDF do relatório
objective: >
  Permitir baixar o relatório atual como PDF, mantendo gráficos e paginação.
deliverables:
  - Botão "Exportar PDF" no cabeçalho do relatório
  - Geração server-side preservando os gráficos
requirements:                 # definition of done
  - Sem quebrar a exportação em XLSX existente
  - PDF abre corretamente em Chrome e Preview
scope:
  owns: [src/report/export/**, src/components/ReportHeader.tsx]  # vira claims
  off_limits: [src/checkout/**, src/auth/**]                     # áreas de outros
autonomy:
  clarifications: ask         # ask | assume | strict
  commit: per-step            # per-step | at-end
  run_tests: true
engine: claude
model: opus-5
```

**O campo que responde seu "a IA tira dúvidas ou não":** `autonomy.clarifications`.

| Valor | Comportamento | Efeito técnico |
|---|---|---|
| `ask` | Pergunta quando houver ambiguidade. | App **expõe** a tool `ask_human()` via MCP; a pergunta aparece na UI e sua resposta volta pro agente. |
| `assume` | Assume o razoável e **registra** a decisão no log. | Sem `ask_human`; segue sozinho deixando trilha. |
| `strict` | Segue o spec à risca, não desvia. | Sem `ask_human`; desvio do spec é bloqueado. |

`scope.owns` é injetado no barramento como `claim` automático no start; `scope.off_limits`
entra no system prompt como "não encoste". O `TASK.yaml` também vira um `TASK.md` legível
que o agente lê como briefing.

---

## 6. Barramento de coordenação — políticas

O coração do produto. Quando dois agentes querem o mesmo arquivo:

| Política | Comportamento |
|---|---|
| **First-claim wins** (padrão) | Quem reivindicou primeiro fica com a posse `write`; o outro recebe `read` + aviso e reusa a mudança após o merge. *(É o caso do Header.tsx no protótipo.)* |
| **Split by ownership** | Áreas exclusivas por agente definidas na criação da tarefa (ex.: `src/checkout/**` é sempre da Ágata). Sobreposição é bloqueada na origem. |
| **Human tiebreak** | Colisão de `write` pausa ambos e pede sua decisão na UI. |
| **Sequential lock** | O segundo agente espera o primeiro terminar/mergear o arquivo antes de tocá-lo. |

Além disso o barramento detecta o caso clássico de **conflito de git** (a branch divergiu
da `main`): o agente pausa e marca a tarefa como *Bloqueado* pedindo resolução humana —
como a Vinca no protótipo.

**Como o agente "lê o mural":** a cada iteração, o núcleo monta um trecho de system prompt tipo:

```
## Coordenação (outros agentes ativos)
- Ágata edita src/checkout/** — não encoste.
- Onda edita src/api/middleware/** — não encoste.
- Você reivindicou src/components/Header.tsx (posse: você). Onda cedeu.
Antes de editar qualquer arquivo fora da sua área, chame `claim(path)`.
```

---

## 7. Ciclo de vida de uma tarefa

```
 Criar tarefa ──► Núcleo cria branch + worktree ──► Motor inicia o agente
      │                                                     │
      │                                          agente reivindica caminhos
      │                                                     │
      ▼                                          edita / roda testes / commita
  aparece no Quadro                                         │
  (coluna "Executando")                     ┌───────────────┴───────────────┐
                                            ▼                               ▼
                                    tudo certo → "Revisão"          divergiu → "Bloqueado"
                                            │                               │
                                     você revisa o diff              você resolve conflito
                                            │                               │
                                            ▼                               ▼
                                      merge na main ──► worktree removida ──► tarefa arquivada
```

---

## 8. Modelo de dados (SQLite, resumido)

```sql
task(id, title, description, status, branch, worktree_path, engine, model, created_at)
agent(id, name, initials, color, task_id, status)          -- status: running|thinking|review|conflict
claim(id, agent_id, path, mode, yielded_to, created_at)    -- mode: read|write
event(id, task_id, ts, type, payload_json)                 -- log de atividade / colisões
diff_stat(task_id, files, additions, deletions, updated_at)
```

---

## 9. Roadmap por fases

**Fase 0 — Núcleo de worktrees (sem UI bonita)**
`git worktree add/remove`, criar branch, ler grafo, rodar `claude -p` numa worktree e
streamar eventos para o terminal. *Prova de que dá pra rodar 2 agentes em paralelo.*

**Fase 1 — MVP visual**
Grafo de branches + roster de agentes + painel de detalhe (o que o protótipo mostra),
lendo estado real do núcleo. Ações: revisar diff, merge, pausar.

**Fase 2 — Barramento de coordenação**
`claim()` como tool do agente, injeção no system prompt, detecção e resolução de colisão,
barra inferior ao vivo.

**Fase 3 — Quadro (Kanban) + criação de tarefa**
Arrastar card → cria branch + worktree + dispara agente. Templates de tarefa.

**Fase 4 — Multi-motor + polimento**
Seletor de motor plugável (Codex/Gemini/Ollama), builds assinados para macOS/Windows/Linux,
resolução de conflito assistida na UI.

---

## 10. Riscos & decisões em aberto

- **Custo/tokens**: N agentes = N vezes o consumo. Prever um painel de custo por tarefa.
- **Segredos**: worktrees compartilham `.env`? Definir política (copiar, symlink, ou cofre).
- **Testes/CI local**: rodar a suíte em cada worktree pode pesar; considerar fila.
- **Concorrência no `.git`**: operações de git simultâneas — serializar merges no núcleo.
- **Sandbox**: quão livre o agente roda `bash`? Definir `ToolPolicy` por tarefa desde já.

---

## Apêndice — protótipo de UI

O protótipo interativo (grafo + quadro + painel de coordenação, com tema claro/escuro)
foi entregue como Artifact junto deste documento. Ele materializa as §2.3, §6 e §7.
