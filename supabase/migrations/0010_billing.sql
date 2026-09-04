-- 0010: cobrança via Stripe + dados vinculados ao USUÁRIO
-- Regras:
--  · billing_plans: catálogo de preços (semeado no fim do setup da Stripe).
--    ENQUANTO ESTIVER VAZIO, o app roda livre (gate desligado) — liga sozinho
--    quando os planos existirem. Nuvem sem clique.
--  · billing: 1 linha por usuário pagante; plano team aponta team_id e dá
--    assinatura pro time inteiro (até `seats` membros — trigger trava o excesso).
--  · escrita SÓ pelo service role (webhook da Stripe); o app apenas lê.

create table if not exists billing_plans (
  id text primary key,                 -- individual_month | individual_year | team_month | team_year
  stripe_price_id text not null,
  plan text not null check (plan in ('individual','team')),
  "interval" text not null check ("interval" in ('month','year')),
  amount_cents int not null,
  currency text not null default 'brl',
  seats int not null default 1,
  trial_days int not null default 7,
  active boolean not null default true
);
alter table billing_plans enable row level security;
drop policy if exists billing_plans_read on billing_plans;
create policy billing_plans_read on billing_plans for select using (auth.role() = 'authenticated');

create table if not exists billing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  plan text,
  "interval" text,
  status text,                          -- trialing | active | past_due | canceled | incomplete
  seats int not null default 1,
  team_id uuid references teams(id) on delete set null,
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  updated_at timestamptz not null default now()
);
create index if not exists billing_team_idx on billing(team_id);
alter table billing enable row level security;
drop policy if exists billing_read_own on billing;
create policy billing_read_own on billing for select using (auth.uid() = user_id);
drop policy if exists billing_read_team on billing;
create policy billing_read_team on billing for select using (team_id is not null and can_see_team(team_id));

-- o time tem plano ativo? (usado pelo app e por checks futuros)
create or replace function team_has_active_plan(p_team uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from billing where team_id = p_team and plan = 'team' and status in ('trialing','active'));
$$;

-- trava de assentos do plano team
create or replace function enforce_team_seats() returns trigger
language plpgsql security definer as $$
declare cap int;
begin
  select seats into cap from billing
    where team_id = new.team_id and plan = 'team' and status in ('trialing','active') limit 1;
  if cap is not null and (select count(*) from team_members where team_id = new.team_id) >= cap then
    raise exception 'plano do time permite no máximo % membros — fale com o dono da assinatura', cap;
  end if;
  return new;
end $$;
drop trigger if exists trg_team_seats on team_members;
create trigger trg_team_seats before insert on team_members
  for each row execute function enforce_team_seats();

-- ---------- dados que SEGUEM a conta do usuário ----------
-- repos que o usuário usa (metadados) e a memória de cada repo
-- (.cardume: RUNBOOK.md, HISTORY.md, SPEC.md, policy.json)
create table if not exists user_repos (
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  path text,
  last_opened timestamptz not null default now(),
  primary key (user_id, repo)
);
create table if not exists user_repo_docs (
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  doc text not null,
  content text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, repo, doc)
);
alter table user_repos enable row level security;
alter table user_repo_docs enable row level security;
drop policy if exists user_repos_all on user_repos;
create policy user_repos_all on user_repos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists user_repo_docs_all on user_repo_docs;
create policy user_repo_docs_all on user_repo_docs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
