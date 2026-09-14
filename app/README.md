# 🐙 Cardume — App desktop (Tauri v2, Mac-first)

Shell desktop do Cardume. **Fase 1, milestone 1: visor ao vivo.** É o `cardume watch`
virando UI de verdade — lê o `state.sqlite` do repo (a fonte de verdade que o núcleo
escreve) e renderiza, na **pele Terminal**, a lista de agentes, a atividade ao vivo, o
detalhe da tarefa (reivindicações, diff, log) e o barramento de coordenação.

- **Tauri v2** → no macOS usa o **WKWebView do sistema** (mesmo motor do Safari), binário
  pequeno, feel nativo. Multiplataforma de graça quando quisermos ligar Windows/Linux.
- **Backend Rust** (`src-tauri/src/lib.rs`) lê o SQLite via `rusqlite` (read-only) e expõe
  os comandos `set_repo`, `current_repo`, `snapshot`.
- **Frontend** (`src/index.html`) é 100% offline (sem Google Fonts), poll de `snapshot()`
  a cada 700ms.

## Pré-requisitos (uma vez)

```bash
# Rust (se ainda não tiver)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# deps de node do app (traz a CLI do Tauri)
cd app && npm install
```

## Rodar

Primeiro gere dados com o núcleo (noutra aba), depois abra o app apontando pro mesmo repo:

```bash
# 1) gera o state.sqlite com o demo (na pasta do núcleo)
npm run demo

# 2) abre o app já conectado ao repo do demo
cd app
CARDUME_REPO="$(cd ../.cardume-demo/repo && pwd)" npm run dev
```

Sem a env var, o app abre e você cola o caminho do repo no campo do topo e clica
**conectar**. Rode `cardume new ...` ou `cardume demo` e veja a UI atualizar sozinha.

## Estrutura

```
app/
  package.json              scripts tauri (dev/build)
  src/                      frontend — sem bundler; o Tauri embute a pasta inteira (frontendDist=../src)
    index.html              SÓ markup (sidebar, quadro, overlays/abas) + links de css/ e js/
    css/                    fatias em ORDEM (a cascata depende da ordem — não reordenar)
      10-base.css           variáveis, tipografia, botões, modal/overlay, bolhas de chat
      20-abas-e-telas.css   motor de abas + design system das telas novas (.appscreen, .as-*, .nd*)
      30-refino-macos.css   override de refinamento macOS (raios, sombras, .btn, .in)
      40-sidebar-quadro.css sidebar, Central de execuções (fluxo/kanban/filtros)
      50-workspace-planner.css  tela da tarefa (3 colunas), planner, PR, artefatos
      60-grafo-times-nova-demanda.css  grafo, espaço Times, formulário da Nova demanda
    js/                     scripts clássicos, escopo global compartilhado, carregados em ORDEM
      00-util.js            $id(), bindClick(), lsGet/lsSet, syncChromeH — helpers usados por todos
      05-cosmos.js          céu estrelado dos loadings (cosmosHtml/cosmosStart)
      10-core.js            invoke, ícones, refresh() do snapshot, notificações
      11-ambiente-updater.js  preflight (node/git/claude/gh) e updater
      12-chat-prefs-daily.js  chat do projeto, preferências do projeto, daily/relatório
      13-skills-projetos.js   skills por projeto + hub de projetos
      14-nova-demanda-inicio.js  tela "Que tipo de demanda é essa?"
      15-config-abas-onboarding.js  configurações, motor de abas, onboarding, atalhos
      20-workspace-tarefa.js  tela da tarefa (arquivos · código · chat), revisão, página do PR
      21-pull-request.js      abrir/preparar PR (gh)
      22-quadro-fluxo.js      filtros e cards da Central de execuções, resumo da tarefa
      23-kanban-artefatos-editor.js  kanban, artefatos, provas por requisito, editor de código
      24-perguntas-agente.js  modal de resposta ao agente
      25-grafo.js             grafo git por trilhos
      26-sidebar-projetos.js  sidebar por projeto
      27-entregas.js          card de demanda (Execução/Concluídas), aba Entrega (provas, docs, lightbox), relatório da entrega/período
      29-ia-picker.js         "Com qual IA?" — motor + modelo com ícones e recomendação
      30-anexos.js            anexos importados (chips, bloco [ANEXOS], composer: anexar/colar/arrastar)
      31-nova-demanda-form.js formulário por etapas, política do repo, épico, spec com IA
      32-planner.js           "Montar conversando" (chat + TASK.yaml ao vivo)
      33-switcher-projetos, 34-orquestrador (briefing → plano em grafo → tarefas por fase + coordenação por prova).js troca de projeto
      40-nuvem-conta.js       Supabase: login, org, times
      41-assinatura-chaves.js Stripe + chaves de modelo da conta
      42-nuvem-sync-mobile.js cartões compartilhados, túnel, pontes do celular, APNs
      43-espaco-times.js      espaço Times (visão geral, quadro, PRs, pessoas)
      44-onboarding.js        entrada e assinatura: criar conta, entrar, código de e-mail, senha, planos, pagamento, pronto
  src-tauri/
    Cargo.toml              deps: tauri, rusqlite (bundled), serde
    tauri.conf.json         janela, frontendDist=../src, withGlobalTauri
    capabilities/default.json
    icons/icon.png
    build.rs
    src/lib.rs              comandos (snapshot, new_task, talk_task, import_attachment, …)
    src/main.rs
```

Regras do front: os arquivos de `js/` são scripts clássicos (não módulos) — `function`
e `let/const` de topo são globais compartilhados, e a ordem de carga importa: um
arquivo só pode EXECUTAR na carga (fora de função) o que já foi definido nos anteriores.
Helpers genéricos vão em `00-util.js`. Pra ver o app no browser sem compilar, veja o
shim do `__TAURI__` descrito na memória do projeto.

## O que já funciona / o que falta

**Funciona:** o app lê o mesmo `state.sqlite` do núcleo e mostra agentes, atividade ao
vivo, claims, diff, log e as colisões do barramento — atualizando em tempo real.

**Próximos passos:**
- **Grafo GitKraken de verdade** (parsear `git log --all` por lanes) — hoje o centro é um
  feed de atividade; o grafo com curvas por branch é o próximo item visual.
- **Ações** (criar tarefa, merge, pausar) chamando o núcleo como **sidecar Node** ou
  reimplementando no Rust.
- Trocar o poll por **push** (o Rust observa o arquivo e emite evento pro webview).
- **Empacotar** (`npm run build`) com ícones `.icns` completos e assinatura.
