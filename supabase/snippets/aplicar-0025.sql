-- Constellation · caminho normal: aba Banco do /admin → "0025_epic_spec.sql" → aplicar.
-- Fallback (SQL Editor): https://supabase.com/dashboard/project/fivoakrhazlzcdoocgbg/sql/new
-- Idempotente; pode rodar mais de uma vez.

-- ===== 0025_epic_spec.sql =====
alter table epics add column if not exists spec jsonb not null default '{}'::jsonb;
alter table epics add column if not exists updated_at timestamptz not null default now();

-- conferir:
-- select id, name, status, spec, updated_at from epics order by created_at desc limit 5;
