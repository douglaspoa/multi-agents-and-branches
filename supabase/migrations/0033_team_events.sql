-- 0033 — team_events: AVISOS DO TIME que não pertencem a uma tarefa (task_activity exige task_id).
-- Primeiro uso: "padrão do time desligado" (PR #170). Quem desliga uma skill (ou o "sempre…" dela) ou tira um agente do
-- catálogo/de uma equipe grava um evento aqui; a faixa âmbar da Semana de TODOS os membros mostra o mais novo dos
-- últimos 7 dias, com o nome da pessoa (o app resolve user_id → profiles; nunca mostra o id).
--   - ler: quem enxerga o time (membro, ou owner/admin da org — mesma regra de tasks);
--   - gravar: só membro do time, sempre em nome de si mesmo (user_id = auth.uid()) e com a hora de agora;
--   - não se edita (sem policy de update); apagar: o autor, o líder do time ou admin da org;
--   - retenção: a leitura só devolve os últimos 14 dias (o app pede 7). Linha velha fica invisível — quem quiser
--     limpar de verdade apaga pelo /admin (service role); não há job aqui.
-- Idempotente (a aba Banco do /admin aplica de novo sem erro). Não usa `join team_members` cru em policy
-- (a armadilha das 0010/0022/0023): só as funções de papel da 0001.

create table if not exists team_events (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null,
  body       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- tipos aceitos (lista fechada; um tipo novo = migration nova trocando esta constraint) + corpo pequeno
alter table team_events drop constraint if exists team_events_kind_check;
alter table team_events add constraint team_events_kind_check check (kind in ('padrao-desligado'));
alter table team_events drop constraint if exists team_events_body_check;
alter table team_events add constraint team_events_body_check
  check (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 2048);

create index if not exists team_events_team_at on team_events (team_id, created_at desc);

alter table team_events enable row level security;
drop policy if exists team_events_select on team_events;
drop policy if exists team_events_insert on team_events;
drop policy if exists team_events_update on team_events;
drop policy if exists team_events_delete on team_events;
create policy team_events_select on team_events for select
  using (can_see_team(team_id) and created_at > now() - interval '14 days');
create policy team_events_insert on team_events for insert
  with check (user_id = auth.uid() and is_team_member(team_id)
    and created_at between now() - interval '5 minutes' and now() + interval '5 minutes'); -- sem data forjada pra ficar no topo
create policy team_events_delete on team_events for delete
  using (user_id = auth.uid() or is_team_lead(team_id) or is_org_admin(org_of_team(team_id)));

grant select, insert, delete on team_events to authenticated;
