-- 0027 · site_leads: contatos deixados na landing (starfork.com.br) — "Falar com vendas / agendar piloto"
-- e "me avise do Windows". A chave pública (anon) só INSERE; ninguém lê pela API pública: a leitura é
-- só pela admin-api (service role). Limites de tamanho no banco porque o formulário é público. Idempotente.
create table if not exists site_leads (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null,
  name       text,
  email      text not null,
  company    text,
  team_size  text,
  concern    text,
  message    text,
  utm        jsonb not null default '{}',
  anon_id    text,
  handled_at timestamptz
);
create index if not exists site_leads_created_idx on site_leads (created_at desc);

alter table site_leads drop constraint if exists site_leads_chk;
alter table site_leads add constraint site_leads_chk check (
  kind in ('vendas', 'windows')
  and email ~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' and length(email) <= 200
  and coalesce(length(name), 0) <= 120 and coalesce(length(company), 0) <= 120
  and coalesce(length(team_size), 0) <= 40 and coalesce(length(concern), 0) <= 80
  and coalesce(length(message), 0) <= 1000 and coalesce(length(anon_id), 0) <= 64
  and pg_column_size(utm) <= 2000
);

alter table site_leads enable row level security;
drop policy if exists site_leads_insert on site_leads;
create policy site_leads_insert on site_leads for insert to anon, authenticated
  with check (handled_at is null);
grant insert on site_leads to anon, authenticated;
