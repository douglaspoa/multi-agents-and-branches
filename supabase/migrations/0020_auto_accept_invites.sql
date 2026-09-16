-- Convite aceito SEM token: quem cria a conta com o e-mail convidado entra na org/time
-- sozinho no primeiro login (o app chama isto antes de decidir se mostra planos —
-- membro de org enterprise nunca vê a tela de pagamento).
create or replace function accept_pending_invites()
returns json language plpgsql security definer set search_path = public as $$
declare inv record; my_email text; used int; cap int; joined json[] := '{}';
begin
  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then return json_build_object('ok', false, 'error', 'não autenticado'); end if;
  for inv in select * from invites where lower(email) = lower(my_email) and accepted_at is null and expires_at > now() order by expires_at loop
    select count(*) into used from org_members where org_id = inv.org_id;
    select seats into cap from orgs where id = inv.org_id;
    if used >= cap and not exists (select 1 from org_members where org_id = inv.org_id and user_id = auth.uid()) then
      continue; -- sem assento: deixa o convite pendente pro admin resolver
    end if;
    insert into org_members (org_id, user_id) values (inv.org_id, auth.uid()) on conflict (org_id, user_id) do nothing;
    insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), inv.role) on conflict (team_id, user_id) do nothing;
    update invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
    joined := joined || json_build_object('org_id', inv.org_id, 'team_id', inv.team_id);
  end loop;
  return json_build_object('ok', true, 'joined', to_json(joined));
end $$;
grant execute on function accept_pending_invites() to authenticated;
