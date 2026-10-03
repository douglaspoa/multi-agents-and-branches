-- 0031 · org_learnings: APRENDIZADO DE AGENTE COMPARTILHADO COM O TIME, POR ITEM (F5 · P17 da mesa de 03/10/2026).
-- O aprendizado de agente mora no repo/na máquina por padrão. Ir pro time é um "⇡ compartilhar" por item: entra aqui
-- como PENDENTE, alguém aprova (quem pode aprovar sai da política da org — orgs.policy.agentes.aprovaAprendizado:
-- 'admins' (padrão) ou 'membros' = qualquer OUTRA pessoa da org; nunca quem compartilhou) e só então os colegas veem
-- "trazer pro <agente>" — que no app cai na fila "pra você decidir" e só entra com o sim item a item.
-- NUNCA há sincronia automática: o app só lê esta tabela ao abrir a ficha do agente.
-- Recurso de NUVEM = plano pago (regra do dono: o Grátis não guarda dado do usuário na nossa nuvem). A RLS confere o
-- plano no insert (org_cloud_ok). Idempotente: pode rodar de novo sem efeito.

-- plano pago ativo pra recurso de nuvem: licença da org (Empresa/Time com validade) OU assinatura ativa de alguém da org
create or replace function org_cloud_ok(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from orgs o where o.id = p_org
                   and ((o.paid_until is not null and o.paid_until > now()) or (o.plan = 'enterprise' and o.paid_until is null)))
      or exists (select 1 from billing b join org_members om on om.user_id = b.user_id
                  where om.org_id = p_org and b.status in ('active', 'trialing'));
$$;

create table if not exists org_learnings (
  org_id         uuid not null references orgs(id) on delete cascade,
  id             uuid not null default gen_random_uuid(),
  agent_id       text not null,
  agent_name     text not null default '',
  kind           text not null,
  title          text not null,
  description    text not null default '',
  body           text not null default '',
  status         text not null default 'pendente',
  shared_by      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shared_by_name text not null default '',
  decided_by     uuid references auth.users(id) on delete set null,
  decided_at     timestamptz,
  reason         text,
  created_at     timestamptz not null default now(),
  primary key (org_id, id)
);
create unique index if not exists org_learnings_item_uq on org_learnings (org_id, agent_id, kind, title);
create index if not exists org_learnings_agent_idx on org_learnings (org_id, agent_id, created_at desc);

alter table org_learnings drop constraint if exists org_learnings_chk;
alter table org_learnings add constraint org_learnings_chk check (
  kind in ('nota', 'skill') and status in ('pendente', 'aprovado', 'recusado')
  and length(agent_id) between 1 and 64 and length(agent_name) <= 80
  and length(title) between 1 and 160 and length(description) <= 600 and length(body) <= 8000
  and length(shared_by_name) <= 120 and coalesce(length(reason), 0) <= 400
);

-- quem pode decidir (aprovar/recusar) um item: admins da org; com a política 'membros', qualquer OUTRO membro.
-- Nunca quem compartilhou (ninguém aprova o próprio item).
create or replace function org_learning_can_decide(p_org uuid, p_shared_by uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() <> p_shared_by and (
    is_org_admin(p_org)
    or (exists (select 1 from org_members where org_id = p_org and user_id = auth.uid())
        and coalesce((select policy->'agentes'->>'aprovaAprendizado' from orgs where id = p_org), 'admins') = 'membros')
  );
$$;

-- decisão carimbada pelo SERVIDOR (o cliente não forja quem aprovou nem quando) e só pendente → aprovado/recusado
create or replace function org_learnings_stamp() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.shared_by := auth.uid(); new.status := 'pendente'; new.decided_by := null; new.decided_at := null; new.created_at := now();
    return new;
  end if;
  if new.status is distinct from old.status then
    if old.status <> 'pendente' then raise exception 'esse aprendizado já foi decidido'; end if;
    new.decided_by := auth.uid(); new.decided_at := now();
  end if;
  -- o conteúdo não muda depois de compartilhado (pra mudar: recusar e compartilhar de novo)
  new.org_id := old.org_id; new.agent_id := old.agent_id; new.kind := old.kind; new.title := old.title;
  new.description := old.description; new.body := old.body; new.shared_by := old.shared_by; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists org_learnings_stamp on org_learnings;
create trigger org_learnings_stamp before insert or update on org_learnings
  for each row execute function org_learnings_stamp();

alter table org_learnings enable row level security;
drop policy if exists org_learnings_select on org_learnings;
drop policy if exists org_learnings_insert on org_learnings;
drop policy if exists org_learnings_decide on org_learnings;
drop policy if exists org_learnings_delete on org_learnings;
create policy org_learnings_select on org_learnings for select
  using (exists (select 1 from org_members om where om.org_id = org_learnings.org_id and om.user_id = auth.uid()));
create policy org_learnings_insert on org_learnings for insert
  with check (shared_by = auth.uid() and status = 'pendente' and org_cloud_ok(org_id)
    and exists (select 1 from org_members om where om.org_id = org_learnings.org_id and om.user_id = auth.uid()));
create policy org_learnings_decide on org_learnings for update
  using (status = 'pendente' and org_learning_can_decide(org_id, shared_by))
  with check (status in ('aprovado', 'recusado'));
create policy org_learnings_delete on org_learnings for delete
  using ((shared_by = auth.uid() and status = 'pendente') or is_org_admin(org_id));

grant select, insert, update, delete on org_learnings to authenticated;
