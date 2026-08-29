-- ============================================================================
-- Constellation Teams — F1: identidade, orgs, times, tarefas compartilhadas
-- Decisões (29/08): Supabase; stream NÃO sobe; dev escolhe o que sobe de
-- artefato; assumir livre exceto tarefa marcada "pra si"; licença = chave manual.
-- Rodar no SQL Editor do projeto Supabase (ou via `supabase db push`).
-- ============================================================================

-- ---------- perfis (espelho leve de auth.users) ----------
create table if not exists profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  email      text not null default '',
  created_at timestamptz not null default now()
);

-- cria o perfil automaticamente no signup
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), coalesce(new.email,''))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- orgs (enterprise = 1 org, N times) ----------
create table if not exists orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'team' check (plan in ('solo','team','enterprise')),
  seats       int  not null default 5,
  license_key text,                       -- v1: chave manual emitida pelo Douglas
  created_at  timestamptz not null default now()
);

create table if not exists org_members (
  org_id  uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role    text not null default 'member' check (role in ('owner','admin','member')),
  primary key (org_id, user_id)
);

-- ---------- times ----------
create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role    text not null default 'member' check (role in ('lead','member')),
  primary key (team_id, user_id)
);

create table if not exists invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  team_id    uuid not null references teams(id) on delete cascade,
  email      text not null,
  role       text not null default 'member' check (role in ('lead','member')),
  token      text not null unique default encode(gen_random_bytes(18),'hex'),
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz
);

-- ---------- projetos (repo git, identificado pelo remote normalizado) ----------
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  name        text not null,
  repo_remote text not null,              -- ex.: github.com/comexio/logcomex-ai-v2
  created_at  timestamptz not null default now(),
  unique (team_id, repo_remote)
);

-- ---------- tarefas compartilhadas (o "cartão"; stream NÃO sobe) ----------
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  local_id     text not null,             -- id do slug local (ex.: autocomplete-filtros-home-ncm)
  project_id   uuid not null references projects(id) on delete cascade,
  team_id      uuid not null references teams(id) on delete cascade,
  created_by   uuid not null references auth.users(id),
  assignee     uuid references auth.users(id),
  claim_mode   text not null default 'open' check (claim_mode in ('open','reserved')), -- reserved = "pra mim"
  title        text not null,
  status       text not null default 'backlog',  -- backlog|running|thinking|plan-review|review|delivered|error|aborted
  flag         text check (flag in ('blocked','closed')),
  spec         jsonb not null default '{}'::jsonb,
  branch       text,
  linked_to    uuid references tasks(id),
  cost_usd     numeric not null default 0,
  cost_tokens  bigint  not null default 0,
  stage        text,                      -- papel atual (planner/builder/…)
  last_note    text,                      -- última narração resumida do agente
  requirements_proof jsonb,               -- o requirements.json (req → status + evidência)
  pr_url       text,
  version      bigint not null default 1, -- LWW com aviso no cliente
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (project_id, local_id)
);
create index if not exists tasks_team_idx on tasks (team_id, status);

create or replace function touch_task() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;
drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function touch_task();

-- ---------- atividade do cartão (quem criou/editou/assumiu/entregou/comentou) ----------
create table if not exists task_activity (
  id      bigint generated always as identity primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  kind    text not null check (kind in ('created','edited','claimed','released','started','delivered','comment','status')),
  body    text not null default '',
  at      timestamptz not null default now()
);
create index if not exists task_activity_idx on task_activity (task_id, id);

-- ---------- artefatos que o DEV ESCOLHEU subir (Storage: bucket "artifacts") ----------
create table if not exists artifacts_meta (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  uploaded_by  uuid not null references auth.users(id),
  name         text not null,
  kind         text not null default 'file',   -- doc|image|file
  size         bigint not null default 0,
  storage_path text not null,                  -- artifacts/<task_id>/<name>
  created_at   timestamptz not null default now()
);

-- ============================================================================
-- HELPERS de permissão (security definer pra não recursionar nas policies)
-- ============================================================================
create or replace function is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members
    where org_id = p_org and user_id = auth.uid() and role in ('owner','admin')
  );
$$;

create or replace function is_team_member(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = p_team and user_id = auth.uid());
$$;

create or replace function is_team_lead(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = p_team and user_id = auth.uid() and role = 'lead');
$$;

create or replace function org_of_team(p_team uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from teams where id = p_team;
$$;

create or replace function can_see_team(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_team_member(p_team) or is_org_admin(org_of_team(p_team));
$$;

-- ============================================================================
-- RLS — "membro vê o time; org admin vê tudo" vive AQUI, não na UI
-- ============================================================================
alter table profiles       enable row level security;
alter table orgs           enable row level security;
alter table org_members    enable row level security;
alter table teams          enable row level security;
alter table team_members   enable row level security;
alter table invites        enable row level security;
alter table projects       enable row level security;
alter table tasks          enable row level security;
alter table task_activity  enable row level security;
alter table artifacts_meta enable row level security;

-- perfis: eu edito o meu; vejo perfis de quem divide org comigo
create policy profiles_self on profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy profiles_coworkers on profiles for select
  using (exists (
    select 1 from org_members a join org_members b on a.org_id = b.org_id
    where a.user_id = auth.uid() and b.user_id = profiles.user_id
  ));

-- orgs: membros veem; owner administra
create policy orgs_select on orgs for select
  using (exists (select 1 from org_members where org_id = orgs.id and user_id = auth.uid()));
create policy orgs_update on orgs for update
  using (exists (select 1 from org_members where org_id = orgs.id and user_id = auth.uid() and role = 'owner'));
create policy orgs_insert on orgs for insert with check (true);  -- criar org: qualquer autenticado (vira owner via RPC)

create policy org_members_select on org_members for select
  using (user_id = auth.uid() or is_org_admin(org_id));
create policy org_members_admin on org_members for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- times: membro do time OU admin da org
create policy teams_select on teams for select using (can_see_team(id));
create policy teams_admin  on teams for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

create policy team_members_select on team_members for select using (can_see_team(team_id));
create policy team_members_manage on team_members for all
  using (is_team_lead(team_id) or is_org_admin(org_of_team(team_id)))
  with check (is_team_lead(team_id) or is_org_admin(org_of_team(team_id)));

-- convites: lead/admin criam e veem os do time
create policy invites_manage on invites for all
  using (is_team_lead(team_id) or is_org_admin(org_id))
  with check (is_team_lead(team_id) or is_org_admin(org_id));

-- projetos/tarefas/atividade/artefatos: quem vê o time
create policy projects_select on projects for select using (can_see_team(team_id));
create policy projects_write  on projects for all
  using (is_team_member(team_id)) with check (is_team_member(team_id));

create policy tasks_select on tasks for select using (can_see_team(team_id));
create policy tasks_insert on tasks for insert with check (is_team_member(team_id));
create policy tasks_update on tasks for update using (is_team_member(team_id));
create policy tasks_delete on tasks for delete
  using (created_by = auth.uid() or is_team_lead(team_id) or is_org_admin(org_of_team(team_id)));

create policy activity_select on task_activity for select
  using (exists (select 1 from tasks where tasks.id = task_id and can_see_team(tasks.team_id)));
create policy activity_insert on task_activity for insert
  with check (user_id = auth.uid() and exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));

create policy artifacts_select on artifacts_meta for select
  using (exists (select 1 from tasks where tasks.id = task_id and can_see_team(tasks.team_id)));
create policy artifacts_insert on artifacts_meta for insert
  with check (uploaded_by = auth.uid() and exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));
create policy artifacts_delete on artifacts_meta for delete using (uploaded_by = auth.uid());

-- ============================================================================
-- RPCs (fluxos que precisam de transação/regra — chamados via /rest/v1/rpc/…)
-- ============================================================================

-- criar org + primeiro time; criador vira owner e lead
create or replace function create_org_with_team(p_org_name text, p_team_name text)
returns json language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_team uuid;
begin
  insert into orgs (name) values (p_org_name) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  insert into teams (org_id, name) values (v_org, p_team_name) returning id into v_team;
  insert into team_members (team_id, user_id, role) values (v_team, auth.uid(), 'lead');
  return json_build_object('org_id', v_org, 'team_id', v_team);
end $$;

-- aceitar convite por token (checa assento da org)
create or replace function accept_invite(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype; used int; cap int;
begin
  select * into inv from invites where token = p_token and accepted_at is null and expires_at > now();
  if not found then return json_build_object('ok', false, 'error', 'convite inválido ou expirado'); end if;
  select count(*) into used from org_members where org_id = inv.org_id;
  select seats into cap from orgs where id = inv.org_id;
  if used >= cap and not exists (select 1 from org_members where org_id = inv.org_id and user_id = auth.uid()) then
    return json_build_object('ok', false, 'error', 'sem assentos livres na organização');
  end if;
  insert into org_members (org_id, user_id) values (inv.org_id, auth.uid())
    on conflict (org_id, user_id) do nothing;
  insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), inv.role)
    on conflict (team_id, user_id) do nothing;
  update invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  return json_build_object('ok', true, 'team_id', inv.team_id, 'org_id', inv.org_id);
end $$;

-- assumir tarefa: livre quando 'open'; 'reserved' só o criador. Troca de dono
-- exige que a atual esteja parada (sem status de execução).
create or replace function claim_task(p_task uuid)
returns json language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype;
begin
  select * into t from tasks where id = p_task for update;
  if not found then return json_build_object('ok', false, 'error', 'tarefa não encontrada'); end if;
  if not is_team_member(t.team_id) then return json_build_object('ok', false, 'error', 'sem acesso'); end if;
  if t.claim_mode = 'reserved' and t.created_by <> auth.uid() then
    return json_build_object('ok', false, 'error', 'tarefa reservada pelo criador');
  end if;
  if t.assignee is not null and t.assignee <> auth.uid()
     and t.status in ('running','thinking','plan-review') then
    return json_build_object('ok', false, 'error', 'em execução com outro dev — peça pra pausar/entregar');
  end if;
  update tasks set assignee = auth.uid() where id = p_task;
  insert into task_activity (task_id, user_id, kind, body) values (p_task, auth.uid(), 'claimed', '');
  return json_build_object('ok', true);
end $$;

-- ============================================================================
-- Realtime + Storage
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table tasks;
  alter publication supabase_realtime add table task_activity;
exception when others then null; end $$;

insert into storage.buckets (id, name, public) values ('artifacts','artifacts', false)
  on conflict (id) do nothing;
create policy artifacts_storage_rw on storage.objects for all
  using (bucket_id = 'artifacts' and exists (
    select 1 from tasks where tasks.id::text = split_part(storage.objects.name, '/', 1)
      and can_see_team(tasks.team_id)))
  with check (bucket_id = 'artifacts' and exists (
    select 1 from tasks where tasks.id::text = split_part(storage.objects.name, '/', 1)
      and is_team_member(tasks.team_id)));
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
-- Convite amarrado ao E-MAIL convidado: o token só funciona pra quem entrou
-- com a conta daquele e-mail (evita token vazado dar acesso a estranho).
create or replace function accept_invite(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype; used int; cap int; my_email text;
begin
  select * into inv from invites where token = p_token and accepted_at is null and expires_at > now();
  if not found then return json_build_object('ok', false, 'error', 'convite inválido ou expirado'); end if;
  select email into my_email from auth.users where id = auth.uid();
  if lower(inv.email) <> lower(coalesce(my_email,'')) then
    return json_build_object('ok', false, 'error', 'este convite é para '||inv.email||' — entre com a conta desse e-mail');
  end if;
  select count(*) into used from org_members where org_id = inv.org_id;
  select seats into cap from orgs where id = inv.org_id;
  if used >= cap and not exists (select 1 from org_members where org_id = inv.org_id and user_id = auth.uid()) then
    return json_build_object('ok', false, 'error', 'sem assentos livres na organização');
  end if;
  insert into org_members (org_id, user_id) values (inv.org_id, auth.uid())
    on conflict (org_id, user_id) do nothing;
  insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), inv.role)
    on conflict (team_id, user_id) do nothing;
  update invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  return json_build_object('ok', true, 'team_id', inv.team_id, 'org_id', inv.org_id);
end $$;
