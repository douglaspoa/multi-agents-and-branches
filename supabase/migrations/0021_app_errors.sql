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
