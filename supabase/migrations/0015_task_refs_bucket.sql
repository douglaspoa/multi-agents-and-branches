-- 0015: bucket privado pra anexos do celular (fotos → agente).
-- Caminho: <taskId>/<arquivo>. Gate NO BANCO: só o DONO da task sobe/baixa
-- (o Mac do dono baixa pra .cardume/refs da worktree).
insert into storage.buckets (id, name, public) values ('task-refs','task-refs', false)
on conflict (id) do nothing;
drop policy if exists task_refs_rw on storage.objects;
create policy task_refs_rw on storage.objects for all
  using (
    bucket_id = 'task-refs'
    and task_owner((split_part(name, '/', 1))::uuid) = auth.uid()
  )
  with check (
    bucket_id = 'task-refs'
    and task_owner((split_part(name, '/', 1))::uuid) = auth.uid()
  );
