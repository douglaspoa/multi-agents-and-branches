# 07 · Plano de marketing e posicionamento

[← voltar ao índice](README.md)

Este plano junta tudo o que está nos outros arquivos: concorrentes ([02](02-concorrentes.md)), dores ([03](03-reclamacoes.md)),
redes e anúncios ([04](04-redes-e-anuncios.md)) e mercado ([06](06-mercado-e-dinheiro.md)).

## 1. O ponto de partida em uma frase

**"Rodar vários agentes em paralelo" virou algo que dezenas de ferramentas fazem, muitas de graça.
O Starfork precisa ser vendido pelo que só ele entrega: trabalho com prova, para times, em português e em reais.**

## 2. Posicionamento

### Para quem (ICP), em ordem de prioridade

| # | Perfil | Por que ele compra | Onde está | Ticket |
|---|---|---|---|---|
| 1 | **Tech lead / CTO de time de 3–15 devs no Brasil** (software house, fintech, agência, SaaS) | Quer o time entregando mais com IA **sem perder controle** (prova, revisão, custo previsível) e precisa de nota fiscal em reais | LinkedIn, comunidades de liderança tech, eventos (TDC, QCon SP), indicação | **Time** |
| 2 | **Dev sênior que já usa Claude Code ou Codex todo dia** | Cansou de 14 terminais, quer paralelo sem bagunça e com prova | Reddit, X, TabNews, r/brdev, YouTube e TikTok de IA | Solo → leva para o time |
| 3 | **Vibe coder / não-dev** (fundador, PM, designer) | Quer **entrega pronta e provada** sem ler código | TikTok/Instagram de IA, cursos (Asimov, Hashtag, Alura) | Solo |

**O foco do primeiro trimestre é o perfil 1**, porque é onde o dinheiro está ([06](06-mercado-e-dinheiro.md)). O perfil 2 é o caminho de entrada: o dev sênior que leva o produto para o time.

### Categoria

Não brigar na categoria "orquestrador de agentes" (lotada e grátis). Criar uma categoria própria:

> **"Entrega com prova"**: o Starfork transforma pedido em trabalho entregue e **provado**, com vários agentes de IA em paralelo.

### Declaração de posicionamento

> Para **times de desenvolvimento brasileiros** que já usam Claude Code ou Codex,
> o **Starfork** é o **espaço de trabalho de agentes de IA** que **só entrega o que consegue provar**:
> cada requisito vem com teste, print ou vídeo, o custo aparece em reais antes de rodar e nada vai para o PR sem passar pelo gate.
> Diferente do Conductor, do Superset e do Orca, que só organizam terminais, o Starfork **planeja, prova e protege**, com time, nota fiscal e suporte em português.

### Os 4 pilares de mensagem

| Pilar | Mensagem principal | Prova (o que mostrar) | Dor que responde |
|---|---|---|---|
| **1. Prova** | *"Seu agente disse 'feito'. O Starfork pede a prova."* | Aba Entrega: requisito → print/teste → gate | Agente que mente (#1) |
| **2. Controle** | *"Você sabe quanto vai custar antes de apertar Enter. Em reais."* | Estimativa em R$, teto por tarefa, modo protegido bloqueando `dropdb` | Gasto surpresa (#3), comando destrutivo (#9) |
| **3. Paralelo sem bagunça** | *"Vários agentes no mesmo projeto. Cada um na sua cópia, com `.env`, dependências e porta próprios."* | Central com 5 agentes, sem configurar nada | Setup de worktree (#2), conflito (#5) |
| **4. Feito para o Brasil e para times** | *"Em português, em reais, com nota fiscal. No Mac, no Windows e no Linux."* | Preço em R$, Pix, NF, Windows | Só Mac (#6), dólar + IOF |

### Tom de voz

- Calmo e seguro, como o Conductor. Nada de "100x", "revolucionário" ou emoji de foguete.
- Português simples, do jeito que o PRODUCT.md pede ("Plain Portuguese").
- Sempre com número real e prova visual.

## 3. Oferta e preço

| Plano | Hoje | Proposta | Por quê |
|---|---|---|---|
| Grátis | Não existe (trial de 7 dias) | **Grátis para sempre**: 1 projeto, 1 agente por vez, com prova e gate | Todos os concorrentes têm. Deixa o dev sênior (perfil 2) entrar e levar para o time. **Limitado o bastante para não virar a Bloop** |
| Solo | R$ 39,90 | R$ 39,90: agentes em paralelo, épicos, app iOS | Mantém |
| Time | R$ 99,90 até 6 pessoas | **Por assento** (a migração `0019_billing_per_seat.sql` já existe), ex.: R$ 49/pessoa | O dinheiro está em times. Preço por pessoa cresce com o cliente |
| Organização | Sob consulta | Sob consulta + **piloto pago de 30 dias** | Venda consultiva |
| **Fundador** | — | **-40% vitalício para os 100 primeiros times** | FOMO real, com contador lido do banco |

*Plano grátis e preço por assento são decisões de negócio do Douglas: aqui está só a recomendação com o porquê.*

## 4. Funil e metas

```
Visitante → Download/cadastro → Ativação (1ª demanda provada em 24h) → Time convidado → Pago → Indica
```

| Etapa | Métrica | Meta inicial (a calibrar com dado real) |
|---|---|---|
| Visitante → cadastro | % de conversão da landing | 3–5% |
| Cadastro → ativação | % com 1ª demanda **provada** em 24h | 40% |
| Ativação → time | % que convida 1+ pessoa em 7 dias | 20% |
| Trial/grátis → pago | % de conversão | 5–10% |
| Retenção | Churn mensal do plano Time | < 3% |
| North Star | **Requisitos provados por semana** (todos os clientes) | Crescer toda semana |

**Por que a North Star são "requisitos provados":** mede valor entregue de verdade, alimenta o contador público da landing e é a métrica que nenhum concorrente consegue copiar.

## 5. Canais

### Orgânico (prioridade: custa tempo, não dinheiro)

| Canal | O que fazer | Por quê | Frequência |
|---|---|---|---|
| **Reddit + TabNews + r/brdev** | O **Douglas responde pessoalmente** threads de "qual orquestrador vocês usam?", sempre ajudando primeiro e citando o Starfork por último | É assim que o Superset cresceu, com o fundador respondendo ([04](04-redes-e-anuncios.md)) | 3–5 respostas por semana |
| **LinkedIn do Douglas e do Kelvin** | Posts com entregas reais: "1 pedido, 3 agentes, 14 min, R$ 6,88", com o print da prova | O ICP 1 (tech lead) está lá | 2 posts por semana cada |
| **YouTube / TikTok / Reels** | Vídeos de 30–60s: uma entrega de ponta a ponta, o modo protegido bloqueando `dropdb` e "o agente disse pronto, olha a prova" | Os vídeos curtos de Claude Code bombam no Brasil | 3 por semana |
| **Changelog público + newsletter** | Toda semana, o que saiu (Couryo) | Mostra ritmo e traz o usuário de volta | Semanal |
| **SEO** | Páginas "Alternativa ao Conductor para Windows", "Starfork vs Superset", "Como rodar vários Claude Code ao mesmo tempo" | Captura quem já está procurando | 2 páginas por mês |
| **GitHub** | Liberar partes como open source (ex.: o MCP de coordenação) | Estrelas no GitHub são prova social dev | Pontual |

### Parcerias

| Parceiro | Proposta | Por quê |
|---|---|---|
| **Criadores BR de Claude Code** (ex.: Felipe Tâmbara, Rodrigo Tadewald, Vitor Breda/farodev, Camila Moreira) | Vídeo patrocinado no formato que converte para o Devin: tela do produto + "comente STARFORK" | Criadores pequenos têm alcance de 5–90x a base e geram centenas de comentários ([04](04-redes-e-anuncios.md)) |
| **Escolas** (Asimov, Hashtag, Alura) | Starfork grátis nas turmas de "agentes de IA" + aula conjunta | Elas já investem em anúncios para esse público. Viramos a ferramenta da aula |
| **Comunidades e eventos** (TDC, QCon SP, meetups de IA) | Palestra "Agentes em paralelo com prova" + estande | Encontrar o tech lead em pessoa |

### Pago (só depois de a landing nova estar no ar)

| Canal | Campanha | Público | Por quê |
|---|---|---|---|
| **Google Search** | "alternativa conductor windows", "conductor em português", "orquestrador agentes ia", "claude code vários agentes", "superset alternativa" | Quem já procura | O Devin faz isso há 174 dias ("Cursor AI Alternative"). No Brasil, a concorrência pelo termo é zero |
| **Meta (Reels)** | Vídeo de criador + "comente STARFORK" (comentário vira DM automática) | Devs BR 22–40 anos interessados em Claude/ChatGPT | O formato vencedor do Devin (97–118 dias no ar) |
| **LinkedIn** | Carrossel "Como o time X entregou N requisitos provados em 1 semana" | CTO, tech lead, head de engenharia, Brasil | O ICP 1 |

**Orçamento inicial sugerido:** R$ 3–5 mil/mês por 2 meses, dividido em Google 50%, criadores 30% e Meta 20%. Cortar o que não trouxer ativação.

### Venda direta (B2B)

1. Lista de 100 software houses, fintechs e agências brasileiras com 5–50 devs.
2. Abordagem pelo LinkedIn com um **vídeo de 60s mostrando uma entrega com prova num repo parecido com o deles**.
3. Oferta: **piloto de 30 dias** com 1 time, com sucesso combinado antes ("N requisitos provados").
4. Fechar com nota fiscal, contrato simples e suporte em português no WhatsApp/Slack.

## 6. FOMO e urgência, só com dado real

| Tática | Como | Regra |
|---|---|---|
| **Preço de fundador** | "-40% vitalício · restam N de 100 vagas" | N lido da tabela de billing |
| **Contador público** | "N requisitos provados · N PRs entregues" na home | Agregado diário do Supabase |
| **"Agora: N agentes rodando"** | Faixa na landing | Lê a presença (`0006_presence.sql`), mostra só se N > 0 |
| **Trial com balanço** | "Faltam 2 dias e você já provou 37 requisitos" | E-mail com o dado da conta ([05](05-email-couryo.md)) |
| **Vagas de piloto Enterprise** | "3 vagas de piloto no 4º trimestre" | Número real de capacidade do time |
| **Lançamentos com data** | "Dia 10: modo X". Lista de espera para recursos novos | Datas que vamos cumprir |

**Regra de ouro:** contador falso e escassez inventada matam a credibilidade com dev. O PRODUCT.md já proíbe inventar métrica.

## 7. Loops de crescimento

| Loop | Mecânica | Por que funciona |
|---|---|---|
| **Entrega compartilhável** | Link público (opt-in) de uma entrega: pedido, requisitos, prints, custo em R$, tempo | Cada entrega vira uma peça de marketing que o próprio usuário espalha |
| **Rodapé no PR** | "Entregue com Starfork · N requisitos provados" na descrição do PR (desligável) | Todo reviewer do time do cliente vê. Foi o loop do Claude Code |
| **Convite de time** | O dev convida o time e os dois ganham 1 mês | Converte o perfil 2 em perfil 1 |
| **Card para redes** | Imagem pronta: "1 pedido · 3 agentes · 14 min · R$ 6,88" | Dev adora postar número |

## 8. Plano de 90 dias

### Mês 1: confiança (antes de gastar com anúncio)

- [ ] Ligar o Couryo (SMTP do Auth + e-mails de boas-vindas e de trial)
- [ ] Landing, Fase 1 do [plano](ANALISE-E-PLANO.md): prints reais, faixa de números reais, páginas de Segurança, FAQ e Changelog
- [ ] Coletar **3 depoimentos reais** (nome, cargo, foto) de quem já usa
- [ ] Definir o plano grátis e o preço de fundador
- [ ] Douglas: 3–5 respostas por semana no Reddit/TabNews
- [ ] 2 páginas de SEO: "Alternativa ao Conductor para Windows" e "Starfork vs Superset"

### Mês 2: identidade e lançamento

- [ ] Landing, Fase 2: hero com demo animada, identidade editorial
- [ ] **Lançamento no TabNews e no r/brdev** (história: "construímos um orquestrador brasileiro com prova por requisito")
- [ ] 2 criadores BR com vídeo patrocinado
- [ ] Google Search com os termos de conquista (R$ 1,5–2,5 mil)
- [ ] Entrega compartilhável + rodapé no PR
- [ ] 30 abordagens B2B → meta de 5 pilotos

### Mês 3: escala do que funcionou

- [ ] Product Hunt + Show HN (versão em inglês da landing)
- [ ] Meta Reels com o criador que melhor converteu
- [ ] Parceria com 1 escola
- [ ] Palestra num evento ou meetup
- [ ] Revisar o funil: cortar canal com custo por ativação alto e dobrar o melhor

## 9. Riscos

| Risco | Mitigação |
|---|---|
| A Anthropic ou a OpenAI lançam orquestração nativa | Multi-motor + time + prova + Brasil: o que o laboratório não vai fazer |
| Cobrança do `claude -p` por créditos (15/06) | Modo Terminal como padrão; deixar claro na landing quando "usa sua assinatura" vale |
| O plano grátis vira custo sem conversão (o caso Bloop) | Limitar a 1 projeto e 1 agente; medir a conversão por coorte |
| Concorrente grátis com VC | Não competir em preço: competir em prova, time e Brasil |
| Prova social fraca no começo | Pilotos B2B gratuitos/baratos em troca de case e depoimento |

## 10. Mensagens prontas

**Hero (opções):**
1. "Vários agentes de IA no seu projeto. **Só entra o que tem prova.**"
2. "Seu agente disse 'feito'. **O Starfork pede a prova.**"
3. "O time de agentes de IA que **entrega com prova**. Em português, em reais."

**Google Ads:**
- Título: "Alternativa ao Conductor p/ Windows" · Descrição: "Vários agentes de IA em paralelo, com prova por requisito. Em português, em reais. Teste grátis."
- Título: "Vários Claude Code ao mesmo tempo" · Descrição: "Cada agente na sua cópia do projeto, com .env e porta próprios. Custo em R$ antes de rodar."

**Roteiro de vídeo curto (30s):**
1. (0–3s) "Meu agente disse que tava pronto. Olha isso." *(tela: teste falhando)*
2. (3–15s) "No Starfork, cada requisito precisa de prova." *(Entrega: requisito → print → ✅)*
3. (15–25s) "Três agentes em paralelo, custo em reais antes de começar." *(Central + estimativa R$)*
4. (25–30s) "Comenta STARFORK que eu te mando o link."
