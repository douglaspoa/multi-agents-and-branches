-- Convite amarrado ao E-MAIL convidado: o token só funciona pra quem entrou
-- com a conta daquele e-mail (evita token vazado dar acesso a estranho).
create or replace function accept_invite(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype; used int; cap int; my_email text;
begin
  select * into inv from invites where token = p_token and accepted_at is null and expires_at > now();
  if not found then return json_build_object('ok', false, 'error', 'convite inválido ou expirado'); end if;
  select email into my_email from auth.users where id = auth.uid();
  if lower(inv.email) <> lower(coalesce(my_email,'')) then
    return json_build_object('ok', false, 'error', 'este convite é para '||inv.email||' — entre com a conta desse e-mail');
  end if;
  select count(*) into used from org_members where org_id = inv.org_id;
  select seats into cap from orgs where id = inv.org_id;
  if used >= cap and not exists (select 1 from org_members where org_id = inv.org_id and user_id = auth.uid()) then
    return json_build_object('ok', false, 'error', 'sem assentos livres na organização');
  end if;
  insert into org_members (org_id, user_id) values (inv.org_id, auth.uid())
    on conflict (org_id, user_id) do nothing;
  insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), inv.role)
    on conflict (team_id, user_id) do nothing;
  update invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  return json_build_object('ok', true, 'team_id', inv.team_id, 'org_id', inv.org_id);
end $$;
