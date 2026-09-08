-- 0014: NEM ADMIN manda no Mac alheio.
-- A RLS (0013) deixa lead/admin atualizarem cartões (gestão: status, flag,
-- épico). Este trigger fecha o que sobrou: o campo spec (onde viaja o INTENT
-- pausar/abortar/abrir-PR e a própria especificação) só muda pela mão do DONO.
-- Service role (webhooks/admin-sql) tem auth.uid() nulo e passa.
create or replace function guard_task_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and coalesce(old.assignee, old.created_by) is distinct from auth.uid()
     and new.spec is distinct from old.spec then
    raise exception 'spec/intent são do dono da demanda — gestão de cartão sim, executar no Mac alheio não';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_task_update on tasks;
create trigger trg_guard_task_update before update on tasks
  for each row execute function guard_task_update();
