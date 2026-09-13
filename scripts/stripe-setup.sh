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
P_IND=$(api products -d name="Constellation Solo" -d description="1 pessoa, 1 repo — agentes, branch + worktree isolada por tarefa, histórico de 30 dias" | jqv id)
P_TEAM=$(api products -d name="Constellation Time" -d description="Por assento (squads de 3 a 12) — agentes em paralelo, workflows compartilhados, daily e custo por pessoa" | jqv id)

echo "→ criando preços (BRL)…"
IND_M=$(api prices -d product=$P_IND -d currency=brl -d unit_amount=4900  -d "recurring[interval]"=month | jqv id)
IND_Y=$(api prices -d product=$P_IND -d currency=brl -d unit_amount=46800 -d "recurring[interval]"=year  | jqv id)   # R$39/mês no anual (-20%)
TEAM_M=$(api prices -d product=$P_TEAM -d currency=brl -d unit_amount=3900  -d "recurring[interval]"=month | jqv id)  # POR assento
TEAM_Y=$(api prices -d product=$P_TEAM -d currency=brl -d unit_amount=37200 -d "recurring[interval]"=year  | jqv id)  # R$31/assento/mês no anual (-20%)

echo ""
echo "✔ criado. Agora cole este SQL no Supabase (SQL Editor) — é ele que LIGA a cobrança no app."
echo "   (amount_cents = preço POR ASSENTO por mês, como o app mostra; seats = teto de assentos do plano)"
echo ""
cat <<SQL
insert into billing_plans (id, stripe_price_id, plan, "interval", amount_cents, seats, trial_days, per_seat) values
  ('individual_month', '$IND_M',  'individual', 'month', 4900,  1,  14, false),
  ('individual_year',  '$IND_Y',  'individual', 'year',  3900,  1,  14, false),
  ('team_month',       '$TEAM_M', 'team',       'month', 3900,  12, 14, true),
  ('team_year',        '$TEAM_Y', 'team',       'year',  3100,  12, 14, true)
on conflict (id) do update set stripe_price_id = excluded.stripe_price_id,
  amount_cents = excluded.amount_cents, seats = excluded.seats, trial_days = excluded.trial_days, per_seat = excluded.per_seat, active = true;
SQL
