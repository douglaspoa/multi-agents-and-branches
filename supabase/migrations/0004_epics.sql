-- Épicos compartilhados (F5): agrupam tarefas do time; progresso = tarefas
-- entregues/mergeadas sobre o total. Qualquer membro cria; RLS do time.
create table if not exists epics (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  name       text not null,
  status     text not null default 'open',   -- open | done | archived
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table epics enable row level security;
create policy epics_select on epics for select using (can_see_team(team_id));
create policy epics_write on epics for all
  using (is_team_member(team_id)) with check (is_team_member(team_id));

alter table tasks add column if not exists epic_id uuid references epics(id) on delete set null;
