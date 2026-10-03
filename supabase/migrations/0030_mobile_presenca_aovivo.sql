-- 0030 · companion nível Orca: PRESENÇA do Mac + AO VIVO do feed e das mensagens do celular.
--  - desktop_presence: o app do Mac bate a cada 45s (uma linha por computador da pessoa) com o projeto ABERTO e
--    os projetos clonados nele. O celular mostra a verdade: "Mac online · loja-web aberto", "Mac offline · visto
--    há 12min", "abra o projeto X no Mac pra ele executar". Sem esta tabela o app usa profiles.last_seen_at.
--  - publicação supabase_realtime: + task_feed, task_messages e desktop_presence (tasks/questions/task_activity
--    já estavam — 0001/0005). O celular assina e relê pelo cursor; sem a publicação ele cai no polling de 5s.
-- Só cada pessoa lê/escreve as PRÓPRIAS linhas (RLS). Idempotente: pode rodar de novo sem efeito.
create table if not exists desktop_presence (
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_id     text not null,
  device_name   text,
  os            text,
  app_build_ms  bigint,
  open_remote   text,
  open_legacy   text,
  open_project  text,
  local_remotes jsonb not null default '[]'::jsonb,
  running       int not null default 0,
  online        boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);
create index if not exists desktop_presence_seen_idx on desktop_presence (user_id, last_seen_at desc);

alter table desktop_presence drop constraint if exists desktop_presence_chk;
alter table desktop_presence add constraint desktop_presence_chk check (
  length(device_id) <= 64 and coalesce(length(device_name), 0) <= 80 and coalesce(length(os), 0) <= 16
  and coalesce(length(open_remote), 0) <= 300 and coalesce(length(open_legacy), 0) <= 300
  and coalesce(length(open_project), 0) <= 120 and pg_column_size(local_remotes) <= 20000
  and running between 0 and 999
);

alter table desktop_presence enable row level security;
drop policy if exists desktop_presence_own on desktop_presence;
create policy desktop_presence_own on desktop_presence for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on desktop_presence to authenticated;

-- ao vivo: cada tabela num bloco próprio (já estar na publicação não derruba a migration)
do $$ begin alter publication supabase_realtime add table desktop_presence; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table task_feed; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table task_messages; exception when others then null; end $$;
