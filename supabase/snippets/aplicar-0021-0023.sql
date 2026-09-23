-- Constellation · aplicar no SQL Editor (https://supabase.com/dashboard/project/fivoakrhazlzcdoocgbg/sql/new)
-- Migrations pendentes em produção: 0021 (app_errors — a área /admin precisa), 0022 e 0023 (issues). Todas idempotentes.

-- ===== 0021_app_errors.sql =====
-- 0021 — rastreabilidade de erros: TODO erro do app (do login ao mais banal) é
-- registrado aqui pela captura global do front (envelope no invoke + handlers de
-- window.error/unhandledrejection). Aceita insert ANÔNIMO de propósito: um erro
-- de LOGIN acontece antes de haver sessão e ainda assim precisa ser rastreado.

create table if not exists app_errors (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  user_id  uuid,                               -- null quando o erro é pré-login
  team_id  uuid,                               -- contexto de time, se houver
  source   text not null default 'app',        -- invoke:<cmd> | window.error | unhandledrejection | planner | pr | login…
  message  text not null default '',
  detail   text,                               -- stack / detalhe técnico
  repo     text,                               -- projeto (basename) em que ocorreu
  build    text,                               -- carimbo do build do app
  context  jsonb not null default '{}'::jsonb  -- extras (arquivo:linha, UA, args…)
);
create index if not exists app_errors_at    on app_errors (at desc);
create index if not exists app_errors_team  on app_errors (team_id, at desc);
create index if not exists app_errors_user  on app_errors (user_id, at desc);
create index if not exists app_errors_source on app_errors (source, at desc);

alter table app_errors enable row level security;

-- INSERT: qualquer papel (inclusive anon/pré-login) pode REGISTRAR um erro.
drop policy if exists app_errors_insert on app_errors;
create policy app_errors_insert on app_errors for insert with check (true);

-- SELECT: o próprio usuário vê os seus…
drop policy if exists app_errors_select_own on app_errors;
create policy app_errors_select_own on app_errors for select using (user_id = auth.uid());
-- …e quem enxerga o time vê os erros daquele time (dashboard de suporte).
drop policy if exists app_errors_select_team on app_errors;
create policy app_errors_select_team on app_errors for select
  using (team_id is not null and can_see_team(team_id));

-- os papéis do PostgREST precisam do GRANT além da RLS
grant insert on app_errors to anon, authenticated;
grant select on app_errors to authenticated;

-- ===== 0022_project_issue_config.sql =====
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

-- ===== 0023_issue_trackers.sql =====
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

