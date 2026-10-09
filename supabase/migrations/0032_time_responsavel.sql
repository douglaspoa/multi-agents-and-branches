-- 0032 — RESPONSÁVEL do cartão do time (mesa 09/10, T2–T4).
-- Antes: qualquer membro inseria cartão com QUALQUER assignee e o claim_task deixava tomar o cartão de um colega
-- (bastava ele não estar rodando). Agora, no BANCO (não só na tela):
--   - pôr a SI MESMO ou deixar livre: qualquer membro do time;
--   - pôr OUTRA pessoa, ou tirar/trocar o cartão de outra pessoa: só o líder do time ou owner/admin da org;
--   - o responsável tem que ser do time;
--   - assumir (claim_task) só cartão LIVRE ou já meu — cartão de colega não se toma;
--   - devolver (release_task): quem está com ele (ou líder/admin), nunca com o agente rodando; volta pra LIVRE.
-- Idempotente (a aba Banco do /admin aplica de novo sem erro). Service role (webhooks/admin) tem auth.uid() nulo e passa.
-- Não usa `join team_members` cru em policy (a armadilha das 0010/0022/0023): só as funções de papel.

create or replace function can_assign_others(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_team_lead(p_team) or is_org_admin(org_of_team(p_team));
$$;

create or replace function is_member_of_team(p_team uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = p_team and user_id = p_user);
$$;

-- o gatilho vale pra insert/update direto (PostgREST) E pras RPCs abaixo
create or replace function guard_task_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return new; end if;
  if tg_op = 'UPDATE' and new.assignee is not distinct from old.assignee then return new; end if;
  if new.assignee is not null and not is_member_of_team(new.team_id, new.assignee) then
    raise exception 'o responsável precisa ser do time';
  end if;
  if new.assignee is not null and new.assignee <> me and not can_assign_others(new.team_id) then
    raise exception 'só o líder do time ou um admin atribui tarefa a outra pessoa';
  end if;
  if tg_op = 'UPDATE' and old.assignee is not null and old.assignee <> me and not can_assign_others(new.team_id) then
    raise exception 'a tarefa está com outra pessoa — peça pra ela devolver, ou ao líder do time pra reatribuir';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_task_assignee on tasks;
create trigger trg_guard_task_assignee before insert or update of assignee on tasks
  for each row execute function guard_task_assignee();

-- atividade: 'assigned' (alguém atribuiu) entra na lista
alter table task_activity drop constraint if exists task_activity_kind_check;
alter table task_activity add constraint task_activity_kind_check
  check (kind in ('created','edited','claimed','released','started','delivered','comment','status','assigned'));

-- assumir: só cartão livre (ou já meu). Antes deixava tomar o de um colega parado.
create or replace function claim_task(p_task uuid)
returns json language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype;
begin
  select * into t from tasks where id = p_task for update;
  if not found then return json_build_object('ok', false, 'error', 'tarefa não encontrada'); end if;
  if not is_team_member(t.team_id) then return json_build_object('ok', false, 'error', 'sem acesso'); end if;
  if t.claim_mode = 'reserved' and t.created_by <> auth.uid() and t.assignee is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'tarefa reservada pelo criador');
  end if;
  if t.assignee is not null and t.assignee <> auth.uid() then
    return json_build_object('ok', false, 'error', 'já está com outra pessoa — peça pra ela devolver, ou ao líder do time pra reatribuir');
  end if;
  if t.assignee is null then
    update tasks set assignee = auth.uid() where id = p_task;
    insert into task_activity (task_id, user_id, kind, body) values (p_task, auth.uid(), 'claimed', '');
  end if;
  return json_build_object('ok', true);
end $$;

-- devolver: quem está com o cartão (ou líder/admin); nunca com o agente rodando nem depois de entregue
create or replace function release_task(p_task uuid, p_note text default '')
returns json language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype;
begin
  select * into t from tasks where id = p_task for update;
  if not found then return json_build_object('ok', false, 'error', 'tarefa não encontrada'); end if;
  if not can_see_team(t.team_id) then return json_build_object('ok', false, 'error', 'sem acesso'); end if;
  if t.assignee is null then return json_build_object('ok', true); end if;
  if t.assignee <> auth.uid() and not can_assign_others(t.team_id) then
    return json_build_object('ok', false, 'error', 'só quem está com a tarefa (ou o líder do time) devolve');
  end if;
  if t.status in ('running','thinking','plan-review','queued') then
    return json_build_object('ok', false, 'error', 'a tarefa está rodando — pare antes de devolver');
  end if;
  if t.status in ('review','delivered','merged','done') or t.pr_url is not null then
    return json_build_object('ok', false, 'error', 'a tarefa já foi entregue — não dá pra devolver');
  end if;
  update tasks set assignee = null, claim_mode = 'open', status = 'backlog' where id = p_task;
  insert into task_activity (task_id, user_id, kind, body) values (p_task, auth.uid(), 'released', left(coalesce(p_note, ''), 200));
  return json_build_object('ok', true);
end $$;

-- atribuir (líder/admin pra qualquer um do time; membro só a si mesmo — o gatilho confere)
create or replace function assign_task(p_task uuid, p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype;
begin
  select * into t from tasks where id = p_task for update;
  if not found then return json_build_object('ok', false, 'error', 'tarefa não encontrada'); end if;
  if not can_see_team(t.team_id) then return json_build_object('ok', false, 'error', 'sem acesso'); end if;
  if p_user is null then return release_task(p_task, ''); end if;
  if p_user <> auth.uid() and not can_assign_others(t.team_id) then
    return json_build_object('ok', false, 'error', 'só o líder do time ou um admin atribui tarefa a outra pessoa');
  end if;
  if not is_member_of_team(t.team_id, p_user) then return json_build_object('ok', false, 'error', 'o responsável precisa ser do time'); end if;
  if t.assignee is not distinct from p_user then return json_build_object('ok', true); end if;
  if t.status in ('running','thinking','plan-review','queued') then
    return json_build_object('ok', false, 'error', 'a tarefa está rodando com outra pessoa — ela precisa parar antes');
  end if;
  update tasks set assignee = p_user where id = p_task;
  insert into task_activity (task_id, user_id, kind, body) values (p_task, auth.uid(), 'assigned', p_user::text);
  return json_build_object('ok', true);
end $$;

grant execute on function claim_task(uuid) to authenticated;
grant execute on function release_task(uuid, text) to authenticated;
grant execute on function assign_task(uuid, uuid) to authenticated;
