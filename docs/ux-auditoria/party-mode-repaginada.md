# Party mode: repaginada de UX/UI (29/09/2026)

Mesa com 6 vozes independentes, cada persona como um agente separado, em 2 rodadas: posição, depois debate e voto. Arquivos completos: `party3/r1-*.md`, `party3/r2-*.md` e `party3/CANDIDATAS.md`.

- **Bia**, vibe coder
- **Rafa**, tech lead
- **Carla**, operações e marketing (projetos que não são software)
- **Marcos**, produto
- **Júlia**, a cética: confiabilidade e desempenho
- **Lia**, designer de produto e UI

Pedido do Douglas:
- A Nova demanda em 2 páginas é atrito.
- O "Mais opções" está feio.
- O layout de antes era mais bonito.
- Não existe carregamento (a tela trava e troca), e o das Issues é "um framezinho de estrelas bem feio".
- Repaginar pensando em UX, UI, atrito e no nome Starfork.

## Votos (top 5 de cada, peso 5 a 1)

| Proposta | Bia | Carla | Júlia | Lia | Marcos | Rafa | Total |
|---|---|---|---|---|---|---|---|
| F1 Uma tela só (Nova demanda = Montar conversando) | 5 | 5 | 4 | 5 | 5 | 2 | **26** (6 votos) |
| F3 Sistema de carregamento único | 4 | 3 | 5 | 4 | 4 | 3 | **23** (6 votos) |
| F2 "Mais opções" vira controles no composer | 3 | 2 | 1 | 3 | 3 | 5 | **17** (6 votos) |
| F6 Identidade Starfork | 2 | – | – | 2 | 2 | – | 6 |
| F7 Resumo progressivo em linguagem de gente | 1 | 4 | – | – | 1 | – | 6 |
| F5 Medir antes (longtask, marks) | – | – | 3 | – | – | 1 | 4 |
| F8 Prévia do que a IA vai fazer | – | – | – | – | – | 4 | 4 |
| F4 Aposentar o cosmos (loader SVG da marca) | – | – | 2 | 1 | – | – | 3 |
| F12 Tirar a cara de terminal do app todo | – | 1 | – | – | – | – | 1, **vetada** (Júlia: big bang) |
| F11 Momento de marca ao aprovar | – | – | – | – | – | – | **vetada** (Rafa) |

## Vetos de princípio
- **Bia:** nenhuma tela da Nova demanda com dois CTAs primários nem com decisão antes de escrever.
- **Carla:** globs, slug, nome de modelo e siglas de git (PR, branch, e2e) não aparecem por padrão. Ficam em "Detalhes técnicos", a um clique.
- **Júlia:**
  - Animação infinita só no skeleton e no indicador "rodando", e só com transform/opacity: respeita `prefers-reduced-motion` e para com a janela oculta.
  - Uma tela por PR, com longtask medido antes e depois.
- **Lia:** nada de canvas, rAF, background-position, width, filter ou blur animados, nem spinner genérico. A forma do carregamento é a do conteúdo ou a da marca.
- **Marcos:** nada obrigatório entre o usuário e a primeira resposta da IA. O primeiro Enter funciona só com o texto.
- **Rafa:** nenhuma decisão da IA que afete escopo, custo ou risco fica escondida só em recolhido ou hover. O valor aparece antes do Aprovar e se troca com um clique ou atalho.

**Conflito Carla × Rafa**, resolvido assim:
- A prévia antes do Aprovar mostra os parâmetros **em linguagem de gente**, sempre visíveis e clicáveis: "Tipo: automático → correção", "IA: equilibrada", "Mexe em: 2 pastas", "~R$ 3".
- Os nomes técnicos (modelo, globs) aparecem no clique.
- Rafa vê o valor e troca com um clique; Carla não vê jargão por padrão.

## Decisão: entra em 3 PRs separados (regra da Júlia)

1. **PR A: carregamento.** F5, F3 e F4.
   - Medir primeiro: `performance.mark` em `openTab` e no primeiro paint, mais `PerformanceObserver('longtask')` gravando no log.
   - Um componente único de carregamento:
     - barra de 2px no topo da aba quando a carga passa de 150 ms;
     - skeleton com a forma do layout real, com brilho por pseudo-elemento via `transform`;
     - padrão "pinta, depois busca" nas abas principais;
     - texto de progresso nas esperas longas;
     - vazio e erro padronizados, com ação.
   - Aposentar o `cosmos` em canvas. No lugar entra o loader SVG da marca (a estrela que se bifurca, em traço), só em esperas de mais de 1,5 s.
2. **PR B: Nova demanda numa tela só.** F1, F2, F7 e F8 (a prévia em linguagem de gente).
   - "Nova demanda" abre direto no planner, em estado vazio acolhedor:
     - o projeto em destaque;
     - exemplos clicáveis, inclusive de projetos que não são software;
     - o composer em foco.
   - O "Mais opções" e o segmentado grande do topo viram controles no composer: um chip de tipo "Automático ▾" e o modo (Conversar · Formulário · Dividir).
   - O Resumo passa a ser progressivo, com o técnico em "Detalhes técnicos".
   - A prévia visível antes do Aprovar mostra os parâmetros em linguagem de gente, e dá para trocá-los.
   - A tela antiga fica atrás de uma flag por uma versão.
3. **PR C: identidade leve.** A parte de F6 que não é big bang.
   - A marca-símbolo estrela + bifurcação no logo, no ícone da Nova demanda e no loader.
   - O verde disciplinado: `--accent` só no CTA, no foco e em "rodando"; o resto usa `--accent-soft`.
   - Uma escala tipográfica aplicada às telas tocadas em A e B.

## Fica para depois (com motivo)
- **F12, cara de terminal no app todo:** vetada como big bang. Entra tela por tela, nas próximas rodadas.
- **F11, animação ao aprovar:** vetada pelo Rafa.
- **F9, polimento amplo do planner:** o essencial entra em B. O resto vem depois, medido.
- **F10, peso visual dos cards:** entra só nos exemplos e nos controles de B.
