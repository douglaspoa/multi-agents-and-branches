-- 0028 · site_events: medição do funil da landing (visita → CTA → conta → download → lead), sem cookie de
-- terceiros. anon_id é aleatório (guardado no navegador); utm = origem da 1ª visita. Nada de PII aqui.
-- A chave pública só INSERE nomes de evento conhecidos; a leitura é só pela admin-api. Idempotente.
create table if not exists site_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  name    text not null,
  anon_id text,
  path    text,
  props   jsonb not null default '{}',
  utm     jsonb not null default '{}'
);
create index if not exists site_events_at_idx on site_events (at desc);
create index if not exists site_events_name_idx on site_events (name, at desc);

alter table site_events drop constraint if exists site_events_chk;
alter table site_events add constraint site_events_chk check (
  name in ('page_view', 'cta_click', 'pricing_view', 'plan_select', 'signup_start', 'signup_done',
           'download_click', 'lead_open', 'lead_submit', 'faq_open', 'first_launch')
  and coalesce(length(anon_id), 0) <= 64 and coalesce(length(path), 0) <= 200
  and pg_column_size(props) <= 1000 and pg_column_size(utm) <= 2000
);

alter table site_events enable row level security;
drop policy if exists site_events_insert on site_events;
create policy site_events_insert on site_events for insert to anon, authenticated with check (true);
grant insert on site_events to anon, authenticated;
