# Spec — Companion mobile no nível do Orca (e acima)

Branch `feat/mobile-nivel-orca` · app iOS `mobile/ios` (SwiftUI, 0.4) + lado do Mac (`app/src/js/42`, `48`) + migration `0030`.

## 1. Objetivo

Dar ao celular o mesmo poder que o companion do Orca dá: saber o que cada agente está fazendo agora, ser avisado quando ele termina ou precisa de você, responder, mandar follow-up, aprovar, parar. E fazer isso com uma conexão em que dá pra confiar. Por cima disso, usar o que só o Starfork tem: requisitos com prova, teto de custo, demandas e um time na nuvem.

## 2. Comparação com o Orca (feature a feature)

Fonte do Orca: docs em onorca.dev/docs/mobile e o código em github.com/stablyai/orca (`mobile/`, `cloud/`, `src/shared/`), lidos em 03/10/2026.

| Recurso | Orca mobile | Starfork antes (0.3) | Starfork agora (0.4) |
|---|---|---|---|
| **Como conecta** | Relay WebSocket com E2EE (Curve25519 + XSalsa20) e pareamento por QR ou código; LAN direta quando dá | REST no Supabase com polling de 6–7s em três laços paralelos | Supabase **Realtime** (WebSocket Phoenix) como empurrão + leitura REST **por cursor**. Polling só como rede de segurança (30s ao vivo, 5s sem). Sem pareamento: é a mesma conta do Mac, com RLS |
| **Reconexão** | Backoff 0,5→60s, watchdog de vida (sonda a 20s), reconecta ao voltar à frente | Nenhuma: cada laço tentava de novo a cada 6s, calado | Backoff exponencial com jitter (0,5→30s). Batimento de 25s: sem resposta = conexão morta. Rede voltou (NWPathMonitor) ou app voltou à frente = reconecta **já**. No fundo, fecha |
| **Estado honesto da conexão** | Faixas "{host} is offline", "Can't reach Relay" | Selo "AO VIVO" **fixo**, mesmo sem internet | Selo AO VIVO, RECONECTANDO, OFFLINE ou A CADA 5S, mais faixa "sem internet", "reconectando… tentativa N", "a nuvem não responde", "**Mac offline · visto há 12min**" e "MacBook online · loja-web aberto" |
| **Host offline** | Código 4404 do relay: o desktop não está conectado | Não sabia | **Presença** (`desktop_presence`, batimento de 45s, `online=false` ao fechar o app). Sem a migration, usa `profiles.last_seen_at` |
| **O host consegue agir nisto?** | — | Não sabia: o pedido sumia se o Mac estivesse com outro projeto aberto | Aviso **por demanda**: "o Mac está com X aberto, abra este projeto", "nenhum Mac seu tem este projeto", "Mac offline, fica na fila" |
| **Token / auth** | Device token rotacionado e re-pareamento | Renovava só no 401, com várias `Supa()` renovando em paralelo (risco de deslogar) | **Uma** `Supa.shared` com renovação em voo único, renovação **antes** de vencer (`expires_at`) e token novo empurrado pro canal ao vivo. Canal fechado por token vencido: renova e entra de novo |
| **Sem duplicar nem perder** | Sequência do RPC | Feed por `id > último`, mas duplicava em corrida | Cursor por id mais um conjunto de ids vistos. O ao vivo só acorda a leitura, então um buraco no socket é recuperado pelo cursor |
| **Status ao vivo do agente** | Trabalhando, pronto ou esperando, por worktree | Fase e % por polling | Fase, **requisitos com prova (✓2/3)**, custo **e teto**, última fala do agente e estado igual ao do desktop (`STATUS_META`) |
| **Feed ao vivo** | Terminal xterm.js e chat | Conversa com passos técnicos recolhidos, a cada 1,5s | Canal ao vivo **desta** demanda (`task_feed` com filtro `task_id`). Suas mensagens viram bolha sua (antes um "Você: ok" curto caía nos passos técnicos) |
| **Terminal / teclas** | Sim (Live mode, Tab/Shift+Tab) | Não | **Não, por decisão** (ver §4): o Starfork é dirigido por demanda e prova, não por terminal |
| **Notificação: terminou** | Push do gateway (APNs/FCM) | APNs do Mac só pra "entrega pronta" e pergunta; o app avisava localmente **só** pergunta | Avisos **por transição**: pronta (com "2/3 com prova"), travou ou conflito, PR aberto, integrada, o Mac não conseguiu executar, pergunta e **teto de custo**. Dedupe com o APNs do Mac. Preferência por tipo em Conta |
| **Notificação: precisa de você** | Sim | Sim (pergunta) | Sim, com **resposta direto na notificação** (texto livre), e o **teto** com os botões "Continuar (+1 teto)" e "Parar aqui" |
| **Responder o agente** | Permissões e perguntas no chat | Opções no card. **Erro engolido** (`try?`): o botão fingia que foi | Opções no card e no detalhe. Erro **visível** (toast). "Já foi respondida em outro aparelho" é detectado (PATCH com `status=eq.open`) |
| **Follow-up** | Composer com @arquivo, /comandos e anexos | Campo no detalhe. A mensagem **sumia** até o Mac ecoar e o "pedir ajuste" só trocava de aba | Bolha **"na fila do Mac…"** até ser entregue. "Pedir ajuste" é uma folha com "virar requisito". Skills `/` e foto continuam. O Mac **devolve pra fila** se a entrega falhar (3x) e **segura** a mensagem enquanto o teto está aberto |
| **Voz** | Ditado, transcrito no desktop | Ditado no aparelho (pt-BR) | Igual (no aparelho, sem depender do Mac) |
| **Iniciar trabalho do celular** | Create Workspace (GitHub, Linear…) | Nova demanda com remote start | Igual, com **aviso de alcance**: em que projeto o Mac está e se vai assumir |
| **Aprovar** | Permissões no chat. Não achamos um "aprovar" | "aprovar e abrir PR" **sem portão de prova** (o Mac também não checava pelo celular) | **Portão de prova igual ao do desktop (PR #100)**. Com requisito sem prova, o principal vira "pedir a prova ao agente" e "aprovar sem prova…" **exige motivo**. O motivo vai no PR e no registro de override. O Mac **recusa** `openPr` sem motivo |
| **Merge** | Source Control: stage/commit, ligar PR | Merge sem confirmação | Merge com confirmação, mais "aplicar correção" em comentário do PR |
| **Ver provas** | — | Ícones 🖼/📄, só imagem, e **vídeo não tocava** | Miniaturas reais, imagem com zoom, **vídeo tocando (AVKit)**, texto (tests.md) e compartilhar |
| **Parar / pausar** | Não achamos controle dedicado | Escondido no ⋯ | **À vista** no detalhe: pausar, parar o turno, retomar. Abortar com confirmação. "Retomar" no teto é recusado pelo Mac (decida o teto) |
| **Múltiplos projetos** | Lista multi-host | Uma lista misturada | **Chips de projeto** (com • no projeto aberto no Mac), nome do projeto no card e alcance por projeto |
| **Diff / arquivos / navegador** | Sim | Stat do diff, preview por túnel | Igual (stat, preview por túnel). Diff linha a linha fica fora (§4) |
| **Time** | — | Aba Time e acompanhamento das demandas dos outros (só leitura) | Igual |
| **Custo e teto** | Uso da conta e reset de créditos | Custo | Custo da demanda **e o teto**, e a pergunta do teto no app e na notificação |

## 3. Arquitetura

```
 iPhone (SwiftUI)                                   Supabase                          Mac (Tauri)
 ┌──────────────────────┐   Realtime (WS)   ┌───────────────────────┐   REST    ┌──────────────────────────┐
 │ SyncHub (único)      │◀──── nudge ───────│ tasks, questions       │◀──────────│ 42 sync/feed/perguntas   │
 │  • RealtimeClient    │                   │ task_feed, task_msgs   │           │ 42 intenções (+portão)   │
 │  • REST por cursor   │──── intenções ───▶│ desktop_presence (0030)│◀── 45s ───│ 48 presença              │
 │  • NWPathMonitor     │                   └───────────────────────┘           └──────────────────────────┘
 │  • Transitions→aviso │
 └──────────────────────┘
```

- **Canais**: `realtime:core` (tasks, questions, que já estavam publicadas), `realtime:mac` (desktop_presence do usuário) e `realtime:feed-<id>` (task_feed e task_messages da demanda aberta). Ficam separados de propósito: se um for recusado (tabela fora da publicação), os outros seguem e só aquela parte cai pro polling.
- **Ao vivo é empurrão, não fonte**: toda mudança acorda uma leitura REST coalescida (`wake`). O feed é lido por `id > lastId` e deduplicado por id. É isso que garante que nada duplica nem se perde.
- **Ciclo de vida**: `.active` liga, `.background` desliga, e `.inactive` (central de controle) não derruba nada. O BGAppRefresh roda a mesma leitura e gera os avisos.
- **Regras puras** em `Logic.swift` (`ProofGate`, `StatusMeta`, `MacStatus`, `MacReach`, `Backoff`, `ConnSummary`, `Transitions`), testadas no `ConstellationTests`.
  - O portão de prova é conferido contra o **fixture dourado** `tests/fixtures/proof-gate-golden.json`, gerado pelo JS do desktop.
  - Os rótulos de status são conferidos lendo o `STATUS_META` do `00-util.js`.

### Contrato de intenções (celular → Mac, `tasks.spec.intent`)

| kind | extra | Mac (42 `cloudIntentTick`) |
|---|---|---|
| `openPr` | `noProofReason?`, `missing?` | portão de prova (`mobileApproveDecide`) → checagens → push → PR com `chkPrBodyExtra` |
| `askProof` | — | `proofAskMsg` via `fwSendText` (mesmo botão do Mac) |
| `merge` | — | `merge_pr` squash |
| `pause` / `resume` / `stop` / `abort` | — | `pause_task` / `resume_task` (recusa se teto) / `stop_task` (+`budgetQuiet`) / `abort_task` |
| `fixComment` | `commentId` | `prFixOne` |

Um teste (`mobile-orca.test.mjs`) lê os `.swift` e falha se o app mandar um `kind` que o Mac não trata.

## 4. Decisões

1. **Supabase Realtime em vez de relay próprio.** O Starfork já tem nuvem por conta e time (RLS, pareamento = login). Um relay como o do Orca seria infraestrutura nova (Cloud Run, E2EE, pareamento) sem ganho pro nosso modelo, que é por demanda e não por terminal. O preço: o conteúdo passa pelo Supabase, como já passava.
2. **Sem terminal remoto.** O diferencial do Starfork é prova e requisitos, não tecla. O feed condensado mais as skills `/` cobrem o "mandar um prompt de qualquer lugar". Teclas cruas pelo celular é risco sem retorno.
3. **Presença numa tabela própria (0030)** em vez de só `profiles.last_seen_at`. Precisamos saber **qual projeto está aberto** e quais estão clonados, porque o Mac só executa o projeto aberto. Sem a migration, o app degrada para `last_seen_at` e não promete projeto.
4. **O batimento não usa `tickLoop`**, porque com a janela escondida ele fica 3× mais lento e o Mac minimizado pareceria offline. Vai com `setInterval` de 45s mais `keepalive` no `beforeunload`.
5. **O portão de prova vale do celular também, e é o Mac que manda.** O app mostra o portão, mas quem decide é o `openPr` no Mac, que relê o `requirements.json`. Uma versão velha do app não fura o portão.
6. **Teto de custo segura mensagens.** Antes, uma mensagem do celular com o teto aberto ia direto pro `talk_task`, e o `budgetWatch` tratava isso como "retomou por outro caminho" e liberava mais um teto **sem ninguém decidir**. Agora ela fica na fila com aviso no feed.
7. **A permissão de notificação** é pedida depois do login, não na primeira abertura por cima do onboarding.
8. **Simulador de dev sem o prefixo `Starfork-`.** A varredura do desktop apagava qualquer `Starfork-*`, inclusive o simulador deste trabalho. Agora ela só apaga o formato exato que ela cria (`Starfork-<id>-<hash6>`, `isOurSimName`), com teste.

## 5. Auditoria do app 0.3 (o que estava quebrado)

- "AO VIVO" fixo e "conectado à nuvem" fixo em Conta, mesmo sem internet.
- Três laços de polling iguais (Central, Minhas, barra de abas), mais 1,5s no detalhe, sem backoff nem pausa no fundo.
- Várias `Supa()`: o push e o BGRefresh criavam a sua e renovavam o token em paralelo, com risco de logout. Também havia warning de concorrência em `Supa.swift`.
- Erros engolidos (`try?`) em responder, intenção, mensagem e túnel: o botão parecia ter funcionado.
- A mensagem do celular sumia até o Mac ecoar, e "Você: ok" curto caía em "passos técnicos".
- "Pedir ajuste" não fazia nada além de trocar de aba.
- Aprovar ignorava o portão de prova (PR #100). "3/3 provados" contava requisito sem arquivo de evidência.
- O vídeo de prova não tocava e as miniaturas eram emoji.
- Status `paused`, `aborted` e outros apareciam crus ("paused").
- Pedido de permissão de notificação na primeira abertura, por cima do onboarding.
- As preferências de push em Conta não eram usadas por nada.
- O badge contava as perguntas do time inteiro, e o "custo" da Central somava as demandas dos outros.
- Nova demanda / follow-up não diziam que o Mac estava offline ou com outro projeto (o pedido ficava parado sem explicação).
- Desktop: `openPr` pelo celular sem portão de prova. A mensagem do celular era marcada entregue **antes** de entregar (falhou = perdida). A mensagem com teto aberto liberava mais teto sozinha.

## 6. Verificação

- `npm run typecheck`, `npm test` (751, 0 falhas) e `node --test app/tests/*.mjs` (inclui `mobile-orca.test.mjs`: laço real do Mac com nuvem e Tauri falsos, contrato iOS↔Mac, migration registrada, fixture dourado).
- `xcodebuild build` limpo (sem warnings do projeto).
- `ConstellationTests`: 10 testes (portão ≡ desktop, STATUS_META ≡ desktop, presença, alcance, backoff, faixa de conexão, transições, decodificação tolerante).
- `ConstellationUITests`: 9 fluxos de ponta a ponta contra a **nuvem falsa** `mobile/ios/mock/mock-supabase.mjs`. Ela imita GoTrue, PostgREST, Storage com Range e Realtime Phoenix, e faz o papel do Mac (batimento, entrega, intenções com o portão). Os fluxos cobrem:
  - ao vivo;
  - filtro de projeto;
  - responder e teto;
  - follow-up com o Mac offline e depois entregue uma única vez;
  - portão de prova e aprovar com motivo;
  - vídeo e imagem de prova;
  - pausar e retomar;
  - queda do websocket, nuvem fora, volta e token vencido no meio;
  - nova demanda com aviso de projeto;
  - as outras abas.
- **Checagem na nuvem REAL (só leitura, 03/10)**: socket Phoenix em `wss://fivoakrhazlzcdoocgbg.supabase.co/realtime/v1/websocket`, com a anon key, sem escrever nada.
  - `realtime:core` (tasks): `Subscribed to PostgreSQL`.
  - `task_feed` e `desktop_presence`: `Unable to subscribe… table: task_feed`. É exatamente o caso "migration 0030 pendente" que o app trata: aquela parte cai pro polling.
  - A nuvem falsa responde com a mesma mensagem.
- Prints em `_bmad-output/prints-mobile-orca/` (antes/ e depois/) e o vídeo da rodada dos testes de UI.

## 7. Pendências

- **Aplicar a migration 0030** pela aba Banco do /admin. Confirmado na nuvem real que hoje `task_feed` e `desktop_presence` recusam o ao vivo. Ela está registrada em `migrations.ts`, mas a função `admin-api` precisa de deploy pra aparecer lá. A alternativa é o SQL Editor. Sem ela, o app funciona com polling no feed e presença pelo `last_seen_at`.
- O APNs real depende da chave da conta Apple no Mac (`apns_push`). Os avisos locais por transição funcionam sem isso, com o app aberto ou pelo BGAppRefresh (o iOS decide a frequência).
- Fora de escopo, por decisão: terminal remoto, diff linha a linha, Android.
- Validar no aparelho real, com a nuvem real, depois do merge e da migration (regra "validar no produto").
