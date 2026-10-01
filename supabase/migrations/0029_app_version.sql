-- 0029 · versão do app por usuário: o app grava o carimbo do build (mtime do executável, em ms — o mesmo
-- `buildMs` do releases/latest.json) e o sistema em profiles, junto da presença. A área /admin compara com o
-- release atual pra mostrar quem está desatualizado. Só colunas novas (a RLS de profiles já deixa cada um
-- atualizar a própria linha). Idempotente.
alter table profiles add column if not exists app_build_ms bigint;
alter table profiles add column if not exists app_os text;
alter table profiles add column if not exists app_build_seen_at timestamptz;
