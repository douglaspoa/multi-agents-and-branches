# 05 · E-mail transacional e de ciclo de vida com o Couryo

[← voltar ao índice](README.md)

## Hoje

- Os e-mails de autenticação (código de 6 dígitos, convite, recuperação, senha trocada) saem pelo **Auth do Supabase**,
  com os templates em [`supabase/templates/`](../../supabase/templates/) e a configuração via [`scripts/supabase-auth-mail.sh`](../../scripts/supabase-auth-mail.sh).
- **Sem SMTP próprio, o Supabase só entrega para membros do projeto e cerca de 2 e-mails por hora** (o próprio script avisa isso no `check`).
  Isso não serve para produção.
- O script já tem o subcomando `smtp`, que liga um SMTP próprio. O exemplo do comentário usa o Resend.
- Não existem e-mails de ciclo de vida (boas-vindas, trial, resumo semanal).

## Proposta: [Couryo](https://couryo.com)

API brasileira de e-mail transacional. Dados do site em 14/10/2026:

| Item | Detalhe |
|---|---|
| SMTP | `smtp.couryo.com`, portas **587** (STARTTLS), **465** (TLS) e **2525**. A senha é a API key |
| Preço | **Free R$ 0** (3.000/mês, até 100/dia, 1 domínio, logs de 7 dias) · **Pro R$ 99/mês** (50 mil) · **Escala R$ 299/mês** (200 mil) · Empresa sob consulta. Paga com **Pix** |
| Domínio | DKIM, return path e DMARC. **Automático no Cloudflare**; para outros DNS (inclusive Registro.br), registros prontos para copiar com verificação ao vivo. Não mexe no SPF existente |
| Entregabilidade | Agente que checa SPF/DKIM/DMARC, blocklists, bounces e reclamações, e sugere quando endurecer o DMARC. Nota 0–100 antes de enviar, também no CI |
| Diagnóstico | Linha do tempo por e-mail com a resposta crua do servidor de destino **traduzida para português** |
| Webhooks | Padrão Standard Webhooks, assinados, com retry por 3 dias e `/v1/events` para recuperar eventos perdidos |
| Templates | Variáveis `{{nome}}`, envio em lote (100 por chamada), agendamento (`scheduled_at`) |
| MCP | `mcp.couryo.com` (OAuth ou API key). Funciona com Claude Code, Codex, Claude, ChatGPT e Cursor |
| Marketing | Campanhas em fluxo **separado** do transacional, descadastro em 1 clique, rastreio de abertura e clique. Automações: add-on de R$ 49/mês no Pro, incluso no Escala |

### Por que o Couryo e não Resend/SendGrid/Postmark

1. **Liga sem código novo**: é SMTP, então entra no `scripts/supabase-auth-mail.sh smtp` que já existe.
2. **Reais e Pix**: o mesmo argumento que usamos para vender o Starfork. Sem IOF, sem cartão internacional.
3. **Suporte e diagnóstico em português**: quando um cliente disser "o código não chegou", a linha do tempo mostra o porquê.
4. **Grátis até 3.000 por mês**: cobre a fase atual sem custo.
5. **MCP**: os próprios agentes do Starfork conseguem consultar entregas e erros.
6. **Marketing no mesmo lugar**: trial, changelog e newsletter sem outra ferramenta.

## Passo a passo para ligar

1. Criar a conta no Couryo e adicionar o domínio `starfork.com.br` (se o DNS estiver no Cloudflare, os registros são criados sozinhos).
2. Esperar DKIM e DMARC ficarem verdes.
3. Gerar uma API key.
4. Rodar:
   ```bash
   SMTP_HOST=smtp.couryo.com SMTP_PORT=465 SMTP_USER=<usuário indicado pelo Couryo> \
   SMTP_PASS=<API key> SMTP_FROM=no-reply@starfork.com.br SMTP_NAME=Starfork \
   scripts/supabase-auth-mail.sh smtp
   scripts/supabase-auth-mail.sh check   # confirma "SMTP próprio: smtp.couryo.com"
   ```
5. Testar login, convite e recuperação com um Gmail, um Outlook e um domínio corporativo.
6. (Opcional) MCP local: adicionar ao `.mcp.json` **local** (que não é versionado, como mostra o `.mcp.json.example`):
   ```json
   { "mcpServers": { "couryo": { "type": "http", "url": "https://mcp.couryo.com" } } }
   ```

**Segurança:** a API key nunca entra no repositório. Ela fica só no SMTP do Supabase e no `.mcp.json` local.

## E-mails de ciclo de vida

Todos com **dado real** da conta: nada de número genérico.

| # | Quando | Assunto (sugestão) | Conteúdo | Objetivo |
|---|---|---|---|---|
| 1 | Cadastro | "Seu primeiro time de agentes" | 3 passos: conectar o repo, abrir a 1ª demanda, ver a prova | Ativação |
| 2 | 24h sem 1ª demanda | "Falta 1 passo" | Vídeo de 40s com uma demanda real | Ativação |
| 3 | Dia 3 do trial | "Você já provou N requisitos" | Balanço: demandas, requisitos provados, tempo, custo em R$ | Valor percebido |
| 4 | Véspera do fim do trial | "Amanhã seus agentes param" | O que ele perde (as demandas abertas dele) + preço de fundador, se houver vaga | Conversão |
| 5 | Fim do trial sem assinar | "Suas N demandas ficam guardadas" | Os dados continuam lá, voltar é um clique | Reativação |
| 6 | Entrega pronta (fora do app, sem iOS) | "Pronto pra revisar: <título>" | Requisitos com prova + botão "abrir no app" | Engajamento |
| 7 | Toda segunda | "Semana do time" | Entregas, custo em R$, % aprovado na primeira revisão | Retenção de time |
| 8 | Pagamento falhou | "Não conseguimos cobrar" | Link do portal Stripe | Evitar churn involuntário |
| 9 | Release nova | Changelog | O que saiu, com GIF | Mostrar ritmo |

**Métricas:** taxa de ativação (1ª demanda em 24h), conversão trial → pago e churn mensal por plano.
