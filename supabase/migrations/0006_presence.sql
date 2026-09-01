-- Presença leve: cada app logado marca o próprio profile a cada 60s.
-- "Online agora" = last_seen_at nos últimos 3 minutos.
alter table profiles add column if not exists last_seen_at timestamptz;
