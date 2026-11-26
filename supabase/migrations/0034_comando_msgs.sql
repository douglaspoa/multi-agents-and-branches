-- 0034 — comando_msgs: a CONVERSA do assistente (Comando) entre o celular e o Mac.
-- O celular grava o que a pessoa FALOU (role 'user', state 'novo'); o Starfork do Mac dela pega (state 'atendendo'),
-- entrega ao agente do Comando — que age no projeto aberto ali — e grava a resposta (role 'bot', reply_to = a fala).
--   - só o dono lê e grava as próprias linhas (user_id = auth.uid()); ninguém do time enxerga a conversa de outro;
--   - corpo curto (texto falado / resposta resumida), sem anexo;
--   - retenção: a leitura só devolve os últimos 7 dias; linha velha fica invisível (limpeza de verdade pelo /admin);
--   - realtime: o celular recebe a resposta na hora e o Mac recebe a fala sem esperar a volta.
-- Idempotente (a aba Banco do /admin aplica de novo sem erro).

create table if not exists comando_msgs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role       text not null,
  body       text not null,
  reply_to   bigint references comando_msgs(id) on delete cascade,
  state      text not null default 'novo',
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table comando_msgs drop constraint if exists comando_msgs_role_check;
alter table comando_msgs add constraint comando_msgs_role_check check (role in ('user', 'bot'));
alter table comando_msgs drop constraint if exists comando_msgs_state_check;
alter table comando_msgs add constraint comando_msgs_state_check check (state in ('novo', 'atendendo', 'pronto', 'erro'));
alter table comando_msgs drop constraint if exists comando_msgs_body_check;
alter table comando_msgs add constraint comando_msgs_body_check check (char_length(body) between 1 and 4000);
alter table comando_msgs drop constraint if exists comando_msgs_meta_check;
alter table comando_msgs add constraint comando_msgs_meta_check
  check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 2048);

create index if not exists comando_msgs_user_at on comando_msgs (user_id, id desc);

alter table comando_msgs enable row level security;
drop policy if exists comando_msgs_select on comando_msgs;
drop policy if exists comando_msgs_insert on comando_msgs;
drop policy if exists comando_msgs_update on comando_msgs;
drop policy if exists comando_msgs_delete on comando_msgs;
create policy comando_msgs_select on comando_msgs for select
  using (user_id = auth.uid() and created_at > now() - interval '7 days');
create policy comando_msgs_insert on comando_msgs for insert
  with check (user_id = auth.uid()
    and created_at between now() - interval '5 minutes' and now() + interval '5 minutes');
create policy comando_msgs_update on comando_msgs for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy comando_msgs_delete on comando_msgs for delete
  using (user_id = auth.uid());

grant select, insert, update, delete on comando_msgs to authenticated;

do $$ begin alter publication supabase_realtime add table comando_msgs; exception when others then null; end $$;
