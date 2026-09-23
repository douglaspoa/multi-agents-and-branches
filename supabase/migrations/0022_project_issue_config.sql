-- Config de "criar issue ao abrir demanda", COMPARTILHADA por projeto + time.
-- Espelha o padrão de project_prefs (0018), mas chaveada por project_id (que já é
-- (team_id, repo_remote) único) — então cada TIME tem sua própria config por projeto.
create table if not exists project_issue_config (
  project_id     uuid primary key references projects(id) on delete cascade,
  enabled        boolean not null default false,
  instructions   text not null default '',   -- COMO criar a issue no tracker do projeto (gh/curl/MCP…)
  title_template text not null default '',    -- opcional; vazio = deriva do TASK.yaml
  body_template  text not null default '',    -- opcional; vazio = objetivo+requisitos do TASK.yaml
  updated_by     uuid references auth.users(id),
  updated_at     timestamptz not null default now()
);

alter table project_issue_config enable row level security;

-- Qualquer membro do TIME dono do projeto lê E escreve (mesma lógica de acesso das tasks).
drop policy if exists project_issue_config_all on project_issue_config;
create policy project_issue_config_all on project_issue_config for all
  using (exists (
    select 1 from team_members tm
    join projects p on p.id = project_issue_config.project_id
    where tm.team_id = p.team_id and tm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from team_members tm
    join projects p on p.id = project_issue_config.project_id
    where tm.team_id = p.team_id and tm.user_id = auth.uid()
  ));

-- Link da issue criada/atrelada a uma tarefa, visível pro time (espelha tasks.pr_url).
alter table tasks add column if not exists issue_url text;
