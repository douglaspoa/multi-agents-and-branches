#!/usr/bin/env bash
# Cria os produtos e preços do Constellation na SUA conta Stripe e imprime o SQL
# de seed da tabela billing_plans. Rode você mesmo, com a sua chave:
#   STRIPE_SECRET_KEY=sk_live_... bash scripts/stripe-setup.sh
# (use sk_test_... primeiro pra testar tudo em modo teste)
set -euo pipefail
[ -n "${STRIPE_SECRET_KEY:-}" ] || { echo "defina STRIPE_SECRET_KEY (sk_test_... ou sk_live_...)"; exit 1; }
api(){ curl -s https://api.stripe.com/v1/$1 -u "$STRIPE_SECRET_KEY:" "${@:2}"; }
jqv(){ python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }

echo "→ criando produtos…"
P_IND=$(api products -d name="Constellation Individual" -d description="1 usuário — agentes, repos e memória vinculados à sua conta" | jqv id)
P_TEAM=$(api products -d name="Constellation Equipes" -d description="Até 6 membros — board do time, releases e catálogo compartilhado" | jqv id)

echo "→ criando preços (BRL)…"
IND_M=$(api prices -d product=$P_IND -d currency=brl -d unit_amount=3990  -d "recurring[interval]"=month | jqv id)
IND_Y=$(api prices -d product=$P_IND -d currency=brl -d unit_amount=39900 -d "recurring[interval]"=year  | jqv id)
TEAM_M=$(api prices -d product=$P_TEAM -d currency=brl -d unit_amount=9990  -d "recurring[interval]"=month | jqv id)
TEAM_Y=$(api prices -d product=$P_TEAM -d currency=brl -d unit_amount=99900 -d "recurring[interval]"=year  | jqv id)

echo ""
echo "✔ criado. Agora cole este SQL no Supabase (SQL Editor) — é ele que LIGA a cobrança no app:"
echo ""
cat <<SQL
insert into billing_plans (id, stripe_price_id, plan, "interval", amount_cents, seats, trial_days) values
  ('individual_month', '$IND_M',  'individual', 'month', 3990,  1, 7),
  ('individual_year',  '$IND_Y',  'individual', 'year',  39900, 1, 7),
  ('team_month',       '$TEAM_M', 'team',       'month', 9990,  6, 7),
  ('team_year',        '$TEAM_Y', 'team',       'year',  99900, 6, 7)
on conflict (id) do update set stripe_price_id = excluded.stripe_price_id,
  amount_cents = excluded.amount_cents, seats = excluded.seats, trial_days = excluded.trial_days, active = true;
SQL
