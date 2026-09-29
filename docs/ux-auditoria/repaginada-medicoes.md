# Repaginada A: medições antes e depois do carregamento

Regra da Júlia: medir antes de mexer e depois de mexer. O "antes" é `main` em `bc2b6f2`. O "depois" é a branch `feat/rep-a-carregamento`.

## Como foi medido
- Usei o harness de prints (shim do `__TAURI__` com dados falsos, Chrome headless via CDP, 1440x900) com `?debug=1`.
- Os mesmos builds passaram por um medidor próprio (`repa-measure.mjs` no scratchpad do harness), que faz três coisas:
  - registra um `PerformanceObserver('longtask')` antes de a página carregar, o que vale para os dois builds;
  - atrasa em **1.200 ms** todo `invoke` do backend, exceto `snapshot`, `web_log` e `snapshot_stamp`, para simular um backend lento;
  - para cada aba, chama `openTab(kind)` e anota:
    - o tempo até o 1º quadro pintado;
    - o que aparece nesse quadro e aos 300 ms;
    - quando os dados chegam;
    - os longtasks do intervalo.
- Rodei também com atraso **0**, para confirmar que numa carga rápida nada pisca.
- No build novo, as mesmas linhas saem no log do app (`/tmp/constellation-web.log`) e, com `?debug=1`, também no console:
  - `[aba] <kind> 1º paint Nms`
  - `[aba] <kind> dados Nms · <o quê>`
  - `[longtask] Nms · aba: X`

## Backend lento (1.200 ms por invoke)

| Aba | 1º paint antes | Tela aos 300 ms, antes | 1º paint depois | Tela aos 300 ms, depois | Dados (antes → depois) | Longtasks |
|---|---|---|---|---|---|---|
| Skills | 19 ms | cosmos (canvas de estrelas) | 10–24 ms | skeleton de cartões + barra | 1.220 → 1.218–1.233 ms | 0 → 0 |
| Projetos | 7 ms | cosmos | 7–14 ms | skeleton de cartões + barra | 1.226 → 1.215–1.219 ms | 0 → 0 |
| Issues (config em cache) | 13 ms | quadro com as issues em cache | 10–19 ms | quadro em cache + barra "buscando issues" | ~300 ms nos dois (sai do cache) | 1 (50–76 ms) → 0–1 (75 ms), é o render do quadro |
| Memória | 6 ms | texto "carregando a memória…" | 4–8 ms | skeleton lista + nota | 1.212 → 1.214–1.223 ms | 0 → 0 |
| Mesa | 4 ms | texto "carregando as mesas…" | 4–6 ms | skeleton de lista | 1.218 → 1.213–1.225 ms | 0 → 0 |
| Agentes | 12 ms | **VAZIO**: nada pintado até o await | 17–28 ms | skeleton de cartões e de equipes | 1.227 → 1.233–1.286 ms | 0 → 0 |
| Planner | 19 ms | **VAZIO**: thread em branco | 10–38 ms | skeleton do chat | — | 0 → 0–1 |
| Time (Central) | 7 ms | cosmos | 6–17 ms | skeleton de kanban | 1.248 → 1.233–1.248 ms | 0 → 0 |

Leitura:
- **O 1º paint não mudou.** Ficou em 4 a 38 ms nos dois builds, porque a aba já abria sem congelar.
- **O que mudou é o que se vê nesse paint:**
  - antes, havia três formas diferentes: um canvas animado de estrelas, um texto solto ou nada;
  - agora, cada aba mostra um skeleton com a forma do conteúdo final, e ele só fica visível depois de 150 ms (opacidade 0 no 1º quadro, 0,83 a 0,96 aos 300 ms).
- **Agentes e Planner eram as abas que "travavam e trocavam".** Agentes só aparecia depois do `await invoke('config')`, e o Planner deixava a thread em branco. As duas agora pintam na hora.
- **Tempo até os dados: igual**, dentro do ruído (±60 ms). O carregamento novo não atrasa a chegada dos dados.
- **Nenhum longtask novo.** O longtask que aparece nas Issues (50 a 76 ms) já existia antes: é o render do quadro com 14 issues.

## Carga rápida (atraso 0)
- **Skills, Projetos, Memória, Mesa, Agentes e Planner:** o 1º quadro já mostra o conteúdo, sem nenhum skeleton ou barra piscando.
- **Time:** o skeleton é pintado no 1º quadro, mas com opacidade 0. Os dados chegam antes dos 150 ms e o substituem, então nunca chega a aparecer.

## Boot (Central), 6 aberturas de cada build
| | FCP | Longtasks no boot |
|---|---|---|
| Antes | 72–116 ms | 0 a 2 por boot (51–72 ms) |
| Depois | 60–112 ms | 0 em 6 boots |

- A Central agora pinta cartões-esqueleto antes do 1º snapshot. No log aparecem duas linhas:
  - `[aba] central 1º paint ~165ms (boot, esqueleto)`
  - `[aba] central dados ~200ms`
- O canvas das estrelas, com o `MutationObserver` global e o `requestAnimationFrame`, saiu do boot.

## Estados conferidos em print (harness)
- **Issues, 1ª carga com o painel lento:** kanban-esqueleto, barra de 2px no topo e, aos 4 s, a pílula "ainda carregando: buscando issues…".
- **Skills com o backend demorando mais de 4 s:** cartões-esqueleto e o texto "ainda carregando: buscando as skills…".
- **Skills com falha:** aparece a mensagem humana ("Não consegui listar as skills — Sem conexão agora…"), o erro cru numa linha menor e o botão "tentar de novo", que refaz a carga.
- **Projetos vazio:** ícone de pasta, "Nenhum projeto ainda", uma linha de ajuda e um único botão, "+ novo projeto".
- **"Colocando no ar":** o loader da marca, a estrela que se bifurca desenhada em traço, no lugar do canvas.
- **`prefers-reduced-motion: reduce`** (emulado via CDP): o skeleton aparece sem brilho (`animation-name: none`), a barra fica parada em `scaleX(.35)` e a marca aparece já desenhada.
- **Janela oculta** (`visibilitychange`): o `<html>` ganha `.ld-paused` e o brilho fica em `animation-play-state: paused`.

Os prints ficam no scratchpad do harness:
- `shots/repa-before` e `shots/repa-after`: cenas home, issues-board, skills, projetos, time e planner;
- `shots/repa-measure/*-400ms.png`: cada aba no meio da carga, antes e depois;
- `shots/repa-states`: erro, vazio, 4 s, 1ª carga das Issues e a marca.

## Limites
- **O harness roda no Chrome.** O app usa o WKWebView do macOS, que não tem `PerformanceObserver('longtask')`. Por isso, no app instalado, o `[longtask]` vem do atraso do timer de 500 ms que já existia. A linha sai marcada como `(estimado)` e só registra bloqueios a partir de ~50 ms.
- **A validação no app instalado não foi feita neste PR.** Falta abrir as Issues com o tracker lento, ler `/tmp/constellation-web.log` e conferir a CPU com a aba oculta.
