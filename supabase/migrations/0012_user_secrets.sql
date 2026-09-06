-- 0012: chaves de provedores de modelo VINCULADAS À CONTA
-- (ex.: LGCX_API_KEY do LLM hospedado da Logcomex). RLS: só o dono lê/escreve.
-- O app sincroniza pro ~/.constellation/llm.env local (600) que os motores leem.
create table if not exists user_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);
alter table user_secrets enable row level security;
drop policy if exists user_secrets_all on user_secrets;
create policy user_secrets_all on user_secrets for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
