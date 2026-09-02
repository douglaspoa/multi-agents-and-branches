-- 0009 — tokens de push do celular (APNs). Cada usuário enxerga e gerencia
-- só os próprios tokens; o remetente (Mac/Edge com a chave APNs) usa service role.
create table if not exists device_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   text not null default 'ios',
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user on device_tokens (user_id);
alter table device_tokens enable row level security;
create policy devtok_own on device_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
