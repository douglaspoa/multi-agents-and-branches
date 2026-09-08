-- 0016: licença ENTERPRISE por ORGANIZAÇÃO (cobre todos os membros, inclusive
-- futuros — sem linha por usuário). O app checa: minha org tem enterprise ativo?
alter table orgs add column if not exists plan text;
alter table orgs add column if not exists paid_until timestamptz;

-- org tem licença ativa? (usada pelo app e por checagens futuras)
create or replace function org_has_active_plan(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from orgs where id = p_org and plan = 'enterprise'
                 and (paid_until is null or paid_until > now()));
$$;

-- Logcomex: enterprise por 1 ano (dogfooding — empresa inteira liberada)
update orgs set plan='enterprise', paid_until = now() + interval '1 year'
where id = '2f655a3b-d4b3-425a-aa15-dd62ebb1813b';

-- limpa as cortesias por-usuário (substituídas pela licença da org)
delete from billing where stripe_subscription_id is null
  and user_id in (select user_id from org_members where org_id='2f655a3b-d4b3-425a-aa15-dd62ebb1813b');
