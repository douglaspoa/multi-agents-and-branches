-- 0008 — mobile ao vivo: iniciar task do celular, feed condensado e chat com o agente.
-- O celular escreve INTENÇÕES (task status='requested', task_messages); o Mac
-- do dono executa e publica o task_feed. Stream completo continua só no Mac.

create table if not exists task_feed (
  id      bigint generated always as identity primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  agent   text not null default '',
  kind    text not null default 'note',   -- note|think|cmd|status|error|done
  text    text not null default '',
  at      timestamptz not null default now()
);
create index if not exists task_feed_task on task_feed (task_id, id);
alter table task_feed enable row level security;
create policy feed_select on task_feed for select
  using (exists (select 1 from tasks where tasks.id = task_id and can_see_team(tasks.team_id)));
create policy feed_insert on task_feed for insert
  with check (exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));

create table if not exists task_messages (
  id           bigint generated always as identity primary key,
  task_id      uuid not null references tasks(id) on delete cascade,
  author       uuid not null references auth.users(id),
  body         text not null,
  delivered_at timestamptz,               -- o Mac marca quando entrega ao agente
  created_at   timestamptz not null default now()
);
create index if not exists task_messages_task on task_messages (task_id, id);
alter table task_messages enable row level security;
create policy msg_select on task_messages for select
  using (exists (select 1 from tasks where tasks.id = task_id and can_see_team(tasks.team_id)));
create policy msg_insert on task_messages for insert
  with check (author = auth.uid() and exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));
create policy msg_update on task_messages for update
  using (exists (select 1 from tasks where tasks.id = task_id and is_team_member(tasks.team_id)));
