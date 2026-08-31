-- Perguntas do agente (ask_human) sincronizadas na nuvem: o Mac do dev empurra
-- a pergunta aberta e busca a resposta; o app mobile (PWA) responde de onde
-- o dev estiver. Fluxo: open (Mac publica) → answered (celular) → closed (Mac
-- entregou a resposta ao agente, ou a pergunta foi respondida no desktop).
create table if not exists questions (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references tasks(id) on delete cascade,
  local_pending_id bigint not null,
  agent            text not null default '',
  prompt           text not null default '',
  options          jsonb not null default '[]'::jsonb,
  status           text not null default 'open' check (status in ('open','answered','closed')),
  answer           text,
  answered_by      uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  answered_at      timestamptz,
  unique (task_id, local_pending_id)
);
alter table questions enable row level security;
create policy questions_select on questions for select
  using (exists (select 1 from tasks where tasks.id = task_id and can_see_team(tasks.team_id)));
create policy questions_write on questions for all
  using (exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)))
  with check (exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));

do $$ begin
  alter publication supabase_realtime add table questions;
exception when others then null; end $$;
