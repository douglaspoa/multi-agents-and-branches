-- Planos por ASSENTO (Time): amount_cents passa a ser o preço de 1 assento/mês e o
-- checkout manda quantity = assentos. Planos antigos (preço fechado por time) ficam false.
alter table billing_plans add column if not exists per_seat boolean not null default false;
