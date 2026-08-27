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
  src/index.html            frontend (pele Terminal, lê snapshot ao vivo)
  src-tauri/
    Cargo.toml              deps: tauri, rusqlite (bundled), serde
    tauri.conf.json         janela, frontendDist=../src, withGlobalTauri
    capabilities/default.json
    icons/icon.png
    build.rs
    src/lib.rs              comandos set_repo / current_repo / snapshot (lê SQLite)
    src/main.rs
```

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
