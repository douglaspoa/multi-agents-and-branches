-- Painel de Issues do TIME: a conexão com o tracker (conector declarativo gerado a
-- partir da doc da API), os projetos ligados a ele e as regras (criar issue ao abrir
-- tarefa, sincronizar status, observar comentários). Um painel por time.
-- NUNCA guarda valor de chave: o conector só cita {{secret.NOME}}; o valor mora no
-- user_secrets de cada pessoa (0012) e é vinculado ao host localmente.
create table if not exists issue_trackers (
  team_id    uuid primary key references teams(id) on delete cascade,
  config     jsonb not null default '{}'::jsonb,  -- { name, docs, connector, vars, projects[], allProjects, rules }
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table issue_trackers enable row level security;

-- Qualquer membro do time lê e escreve (mesma lógica do project_issue_config).
drop policy if exists issue_trackers_all on issue_trackers;
create policy issue_trackers_all on issue_trackers for all
  using (exists (select 1 from team_members tm where tm.team_id = issue_trackers.team_id and tm.user_id = auth.uid()))
  with check (exists (select 1 from team_members tm where tm.team_id = issue_trackers.team_id and tm.user_id = auth.uid()));

