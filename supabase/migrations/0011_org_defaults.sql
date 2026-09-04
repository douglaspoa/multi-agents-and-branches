-- 0011: padrões de demanda POR ORGANIZAÇÃO
-- O produto entrega um template padrão (testado); a org pode sobrescrever
-- (guia de spec + política de obrigatoriedade). O .cardume/ do repo ainda
-- refina por cima. Cadeia: produto < org < repo.
alter table orgs add column if not exists spec_template text;
alter table orgs add column if not exists policy jsonb;
-- leitura já coberta pela policy de select de orgs (membros);
-- escrita já coberta pela policy de update (admins/owner) — mesmas da license_key.
