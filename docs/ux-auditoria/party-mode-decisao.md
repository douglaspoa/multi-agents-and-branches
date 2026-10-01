# Party mode — decisão de features (27/09/2026)

Mesa com 5 vozes independentes (cada persona rodou como um agente separado, 2 rodadas: posição → debate e voto). Arquivos completos: `party/r1-*.md` e `party/r2-*.md` no relatório.

- **Bia**, vibe coder (designer, app de agendamento do pilates da irmã)
- **Rafa**, tech lead de squad numa fintech
- **Carla**, operações e marketing: projetos que NÃO são software
- **Marcos**, estratégia de produto (ativação, retenção, receita)
- **Júlia**, a cética: confiabilidade, time de 1 dev + IA

## Votos (top 5 de cada, peso 5→1)

| Proposta | Bia | Carla | Júlia | Marcos | Rafa | Total |
|---|---|---|---|---|---|---|
| Começar sem portões (criar projeto sem git/GitHub, doutor de ambiente) | 5 | 4 | 1 | 5 | 2 | **17** |
| Nova demanda "uma caixa só" | 4 | – | 5 | 4 | – | **13** |
| Gate de verificação real (checagem com exit code) | – | – | 4 | 3 | 5 | **12** |
| Custo antes, em R$, com teto | 2 | 3 | – | 1 | 4 | **10** |
| Modo seguro de permissões | – | – | 3 | – | 3 | **6** |
| Status humanos + erro pt-BR com ação | 1 | 1 | (1) | 2 | 1 | **6** (único com voto dos 5) |
| Entrega com prévia real | 3 | 2 | – | – | – | **5** |
| Modo Trabalho (não-software) | – | 5 | – | – | – | 5, **vetado** por Marcos e Júlia |
| Pontos de volta / nunca perder trabalho | – | – | 2 | – | – | 2 |

## Vetos
- **Júlia:** nada de toggle global "modo simples" nem segunda UI. O que não é código esconde branch/PR pelo **tipo da entrega**.
- **Marcos:** Modo Trabalho como produto paralelo agora.
- **Carla:** exigir GitHub, gh ou terminal de quem não programa.
- **Rafa:** IA resolvendo conflito, corrigindo ou mergeando sem mostrar o diff antes.
- **Bia:** enterprise, RBAC e auditoria exportável agora.

## Decisão (o que entra nesta rodada)
1. **Começar sem portões:** no estado vazio, um campo "O que você quer fazer?" cria o projeto sozinho, com uma pasta em `~/Documents/Starfork/<nome>` e git por baixo, sem GitHub, e segue direto para montar a demanda conversando.
2. **Nova demanda numa caixa só:** uma caixa de intenção; a IA infere o tipo; tipos, formulário e orquestrador ficam em "mais opções".
3. **Custo antes em R$ + teto por tarefa:** a previsão mostra US$ e ~R$. Com o teto atingido, a tarefa pausa e fica "aguardando você" com a pergunta de continuar.
4. **Modo protegido por padrão:** regras de negação para segredos (`.env*`, chaves) e comandos destrutivos, com selo visível na tarefa. Vale mesmo no modo sem confirmação do motor.
5. **Gate de verificação:** o projeto declara as checagens (testes, lint, build). Elas rodam na cópia da tarefa com exit code e log. "Aprovar" fica bloqueado com checagem vermelha; liberar exige um motivo, que fica registrado.
6. **Entrega com prévia real:** imagem, PDF, markdown e CSV em tabela. Em tarefa que não é código (investigação, design, documentação), o fim é "salvar entregáveis na pasta", sem vocabulário de PR.
7. **Erros em pt-BR com ação:** catálogo central (git, gh, claude, rede, Supabase), com mensagem e botão de conserto.

## Fica para depois (com motivo)
- **Projeto-exemplo guiado:** precisa de template e infraestrutura; a caixa "o que você quer fazer" cobre a ativação por ora.
- **Conta só depois do primeiro valor:** mexe no modelo de nuvem e na cobrança; é decisão do Douglas.
- **Modo Trabalho completo** (tipos próprios de não-software, galeria de modelos): vetado; o item 6 cobre o essencial.
- **Telemetria de funil:** precisa de migration no Supabase (a aba Banco do /admin aplica).
- **Pontos de volta, integração bidirecional com tracker, trilha de auditoria exportável:** próximas rodadas.
