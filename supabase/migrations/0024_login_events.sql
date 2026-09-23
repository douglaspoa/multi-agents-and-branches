-- 0024 · login_events: registro próprio de eventos de conta (o auth.audit_log_entries vem vazio no Supabase atual).
-- Um gatilho em auth.users grava: signup · login · email_confirmed · recovery_requested · password_changed · email_changed.
-- Só o service role lê (área /admin via admin-api). Idempotente.
create table if not exists login_events (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  email    text,
  kind     text not null,
  meta     jsonb not null default '{}'::jsonb
);
create index if not exists login_events_at_idx on login_events (at desc);
create index if not exists login_events_user_idx on login_events (user_id, at desc);
alter table login_events enable row level security;
revoke all on login_events from anon, authenticated;

create or replace function log_auth_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare prov text;
begin
  prov := coalesce(new.raw_app_meta_data->>'provider', 'email');
  if tg_op = 'INSERT' then
    insert into login_events (user_id, email, kind, meta) values (new.id, new.email, 'signup', jsonb_build_object('provider', prov));
    return new;
  end if;
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
    insert into login_events (at, user_id, email, kind, meta) values (new.last_sign_in_at, new.id, new.email, 'login', jsonb_build_object('provider', prov));
  end if;
  if new.email_confirmed_at is distinct from old.email_confirmed_at and new.email_confirmed_at is not null then
    insert into login_events (user_id, email, kind) values (new.id, new.email, 'email_confirmed');
  end if;
  if new.recovery_sent_at is distinct from old.recovery_sent_at and new.recovery_sent_at is not null then
    insert into login_events (user_id, email, kind) values (new.id, new.email, 'recovery_requested');
  end if;
  if new.encrypted_password is distinct from old.encrypted_password and old.encrypted_password is not null then
    insert into login_events (user_id, email, kind) values (new.id, new.email, 'password_changed');
  end if;
  if new.email is distinct from old.email then
    insert into login_events (user_id, email, kind, meta) values (new.id, new.email, 'email_changed', jsonb_build_object('old', old.email));
  end if;
  if new.banned_until is distinct from old.banned_until then
    insert into login_events (user_id, email, kind, meta) values (new.id, new.email, case when new.banned_until is null then 'unbanned' else 'banned' end, '{}'::jsonb);
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_event on auth.users;
create trigger on_auth_user_event
  after insert or update on auth.users
  for each row execute function log_auth_event();
