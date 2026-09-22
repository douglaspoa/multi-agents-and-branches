# Entrada e assinatura — o que ligar no Supabase (painel) e na Stripe

> **22/09/2026 — redefinir senha não funcionava pra usuários.** Diagnóstico e correção:
> 1. A página `/redefinir-senha` do site está **404 em produção**: o commit `347656f` no repo
>    `constellation-ai-v1` nunca foi enviado (`main` está 1 commit à frente de `origin/main`).
>    Quem clicava no link do e-mail caía num 404 **e o clique consumia o código** — depois o
>    código de 6 dígitos também não valia mais. Envie o commit (`git push` com a conta douglaspoa).
> 2. O painel Conta antigo (`40-nuvem-conta.js`) ainda mandava só o *link*; agora os dois
>    "esqueci a senha" (login novo e Conta) passam por `auRecover()` → código → nova senha.
> 3. Templates bonitos com as cores do produto em `supabase/templates/*.html` (recuperação **só
>    com o código**, sem link — o app é o caminho); `scripts/supabase-auth-mail.sh apply` sobe
>    tudo pela Management API. Precisa de `SUPABASE_ACCESS_TOKEN` de uma conta owner — a CLI
>    desta máquina está logada na conta da Logcomex e não vê o projeto `fivoakrhazlzcdoocgbg`.
> 4. Sem SMTP próprio, o Supabase só entrega e-mail **pros membros do projeto** (e ~2/hora).
>    É provável que seja por isso que "as pessoas" não recebem. `scripts/supabase-auth-mail.sh smtp`
>    liga um SMTP (Resend/Postmark) em um comando.
> 5. `GET /auth/v1/settings` mostra **só `email` ligado**: os botões Google/GitHub do app falham
>    até o provider ser ativado no painel (seção 3).

> Feito em 13/09/2026 pela Management API: código de e-mail com 6 dígitos (10 min), templates
> em PT com `{{ .Token }}` + link, Site URL = https://constellation-ai-v1.lovable.app,
> Redirect URLs (callback local, /confirmado, /redefinir-senha), coluna `billing_plans.per_seat`
> e deploy da `stripe-checkout` com assentos. FALTA: provider GitHub (precisa do OAuth App) e os
> preços novos na Stripe (seção 4) — os planos atuais (Individual/Equipes) continuam valendo.

O app (`app/src/js/44-onboarding.js`) implementa: criar conta · entrar · confirmar e-mail
por **código de 6 dígitos** · link mágico · esqueci a senha (código + senha nova) ·
trocar senha (Conta) · login com GitHub/Google · planos por assento · checkout na Stripe.
Tudo fala com o GoTrue e com as functions que já existem. O que NÃO dá pra fazer pelo
código (é configuração do projeto `fivoakrhazlzcdoocgbg`):
## 1. Templates de e-mail (Authentication → Email Templates)
Os templates prontos estão em `supabase/templates/` (recovery, confirmation, magic_link,
password_changed) — fundo `#0b0d0f`, cartão `#13171a`, verde `#3fd68a`, código em mono 40px.
Aplique tudo de uma vez (assuntos com o código, validade de 10 min, aviso de senha trocada):

```bash
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-auth-mail.sh check   # como está hoje
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-auth-mail.sh apply   # sobe os 4 templates
```
Token pessoal: https://supabase.com/dashboard/account/tokens (conta owner do projeto).
Ou cole cada HTML no painel. Regra: **Reset password só tem `{{ .Token }}`** (sem
`{{ .ConfirmationURL }}`), porque o app pede o código e um clique no link consumiria ele.

## 2. URLs (Authentication → URL Configuration)
- **Site URL**: o domínio do site (Lovable), ex. `https://constellation.lovable.app`.
- **Redirect URLs** (lista exata):
  - `http://localhost:8788/callback` — login GitHub/Google pelo app (callback local).
  - `https://<site>/confirmado` — destino do link de confirmação.
  - `https://<site>/redefinir-senha` — destino do link "esqueci a senha" (a página lê o
    token do hash e chama `PUT /auth/v1/user`).
- Em **Reset password** o `{{ .ConfirmationURL }}` deve apontar pra `/redefinir-senha`
  (o GoTrue usa o `redirect_to` do pedido; o app manda `recover` sem redirect, então
  vale o Site URL + `/redefinir-senha` se você trocar o template pra
  `{{ .SiteURL }}/redefinir-senha#access_token={{ .TokenHash }}` — ou deixe o padrão
  e use o código no app, que é o caminho principal).

## 2b. SMTP próprio (obrigatório pra usuários fora do time)
O SMTP padrão do Supabase só entrega pra e-mails dos membros do projeto e limita a ~2/hora.
Crie um domínio no Resend (ou Postmark), pegue a chave e rode:
```bash
SUPABASE_ACCESS_TOKEN=sbp_... SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend \
SMTP_PASS=re_... SMTP_FROM=no-reply@SEU-DOMINIO SMTP_NAME=Constellation scripts/supabase-auth-mail.sh smtp
```
(sobe pra 200 e-mails/hora; o remetente precisa ser do domínio verificado no Resend).

## 3. Providers
- **GitHub**: Authentication → Providers → GitHub (client id/secret de um OAuth App do
  GitHub com callback `https://fivoakrhazlzcdoocgbg.supabase.co/auth/v1/callback`).
- **Google**: idem (já usado antes).

## 4. Planos e Stripe (por assento)
```bash
STRIPE_SECRET_KEY=sk_live_... bash scripts/stripe-setup.sh   # cria Solo R$49 e Time R$39/assento (14 dias grátis)
```
Cole o SQL que ele imprime no SQL Editor (liga a cobrança). Depois publique a function
com o suporte a assentos (quantity):
```bash
supabase functions deploy stripe-checkout --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
```
(A CLI nesta máquina não tem permissão no projeto — rode com uma conta owner/admin.)

## 5. Site (Lovable)
Rota nova `src/routes/redefinir-senha.tsx` + `src/lib/supabase-public.ts` (URL/anon).
O `routeTree.gen.ts` é regenerado pelo plugin do TanStack no build.

## 6. Área de admin do site (`/admin`) — function `admin-api`
Página `https://constellation-ai-v1.lovable.app/admin` (repo `constellation-ai-v1`, rota
`src/routes/admin.tsx` + `src/components/admin/*`). Ela só fala com a Edge Function
`supabase/functions/admin-api` (service role), travada nos e-mails da allowlist (os mesmos da
`admin-sql`; extras via env `ADMIN_EMAILS`). Mostra: visão geral, usuários (trocar senha,
confirmar e-mail, reenviar código, bloquear, criar), logins (audit log do GoTrue), erros do app
(`app_errors`), empresas/times (criar, editar plano/assentos, convidar, revogar), uso & gastos
(demandas, USD, tokens) e cobrança (billing + planos). Publicar:
```bash
supabase functions deploy admin-api --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
# opcional: supabase secrets set ADMIN_EMAILS="outro@dominio.com" --project-ref fivoakrhazlzcdoocgbg
```
(conta owner — a CLI desta máquina está na conta Logcomex). O convite de quem ainda não tem
conta usa o template **Invite user** (`supabase/templates/invite.html`, já no `apply`) e o link
cai em `/redefinir-senha` pra pessoa criar a senha; no primeiro login o `accept_pending_invites`
coloca ela no time.
