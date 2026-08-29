-- ============================================================================
-- Catálogo da ORGANIZAÇÃO: agentes e workflows (equipes de agentes)
-- compartilhados entre todos os devs da org — "os agentes da Logcomex".
-- Membros leem; org owner/admin escrevem. O app puxa pro cardume.config.json
-- do projeto ("aplicar neste projeto") ou envia o local ("enviar os deste").
-- ============================================================================
create table if not exists org_agents (
  org_id  uuid not null references orgs(id) on delete cascade,
  id      text not null,                 -- slug estável (ex.: "iris")
  name    text not null,
  role    text not null default 'builder',
  engine  text not null default 'claude',
  model   text,
  color   text,
  persona text not null default '',
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table if not exists org_workflows (
  org_id uuid not null references orgs(id) on delete cascade,
  id     text not null,
  name   text not null,
  steps  jsonb not null default '[]'::jsonb,   -- ids de agentes, em ordem
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

alter table org_agents    enable row level security;
alter table org_workflows enable row level security;

create policy org_agents_read on org_agents for select
  using (exists (select 1 from org_members where org_id = org_agents.org_id and user_id = auth.uid()));
create policy org_agents_write on org_agents for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

create policy org_workflows_read on org_workflows for select
  using (exists (select 1 from org_members where org_id = org_workflows.org_id and user_id = auth.uid()));
create policy org_workflows_write on org_workflows for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));
