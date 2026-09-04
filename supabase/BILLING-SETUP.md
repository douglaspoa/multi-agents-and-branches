# Cobrança (Stripe) — setup em 6 passos

O app fica **livre até você concluir o passo 6** (o gate liga sozinho quando a
tabela `billing_plans` tiver linhas). Dá pra fazer tudo em modo TESTE primeiro
(chaves `sk_test_...`) e repetir com `sk_live_...` quando estiver satisfeito.

## 1. Conta Stripe
Crie/acesse a conta em https://dashboard.stripe.com (ative "Brasil" como país,
moeda BRL). Em **Developers → API keys**, copie a **Secret key**.

## 2. Migração SQL
Cole `supabase/migrations/0010_billing.sql` no SQL Editor do Supabase
(projeto fivoakrhazlzcdoocgbg) e execute. Cria: billing, billing_plans,
trava de 6 assentos no time, e as tabelas de dados por usuário
(user_repos / user_repo_docs).

## 3. Produtos e preços
No seu terminal (a chave NÃO passa pelo Claude/app):
```bash
STRIPE_SECRET_KEY=sk_test_... bash scripts/stripe-setup.sh
```
Ele cria Individual R$39,90/mês · R$399/ano e Equipes R$99,90/mês · R$999/ano
(anual = 2 meses grátis) e imprime o SQL de seed — guarde pra o passo 6.

## 4. Secrets das functions
No dashboard do Supabase → **Edge Functions → Secrets** (ou via CLI):
```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_... --project-ref fivoakrhazlzcdoocgbg
```

## 5. Deploy das functions + webhook
```bash
supabase functions deploy stripe-checkout --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
supabase functions deploy stripe-webhook  --no-verify-jwt --project-ref fivoakrhazlzcdoocgbg
supabase functions deploy stripe-portal   --project-ref fivoakrhazlzcdoocgbg
```
Depois, na Stripe → **Developers → Webhooks → Add endpoint**:
- URL: `https://fivoakrhazlzcdoocgbg.supabase.co/functions/v1/stripe-webhook`
- Eventos: `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`
- Copie o **Signing secret** (whsec_...) e:
```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref fivoakrhazlzcdoocgbg
```

## 6. Ligar a cobrança
Cole no SQL Editor o SQL de seed que o passo 3 imprimiu. Pronto: no próximo
boot o app mostra a tela de planos pra quem não tem assinatura (7 dias grátis
no primeiro checkout — a Stripe só cobra depois do trial).

## Como funciona no app
- Sem assinatura → tela de planos (Individual / Equipes, mensal ou anual).
- "Assinar" abre o Checkout da Stripe no navegador (cartão nunca toca o app).
- O webhook grava em `billing`; o app relê e libera sozinho.
- Plano Equipes cobre o time inteiro (até 6 — o banco trava o 7º convite).
- Conta → Assinatura: status, trial, renovação e "gerenciar" (portal da Stripe:
  trocar cartão, cancelar, notas).
- Cancelou? Vale até o fim do período; depois o gate volta.

## Teste rápido (modo teste)
Cartão `4242 4242 4242 4242`, qualquer validade futura e CVC. Assine, veja a
linha em `billing`, cancele no portal e veja o status mudar.
