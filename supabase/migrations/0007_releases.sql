-- Canal de RELEASES do app (privado): latest.json + zips. Qualquer usuário
-- AUTENTICADO baixa (o updater roda logado); só org OWNERS publicam.
insert into storage.buckets (id, name, public) values ('releases','releases', false)
  on conflict (id) do nothing;

create policy releases_read_auth on storage.objects for select
  using (bucket_id = 'releases' and auth.role() = 'authenticated');

create policy releases_write_owner on storage.objects for all
  using (bucket_id = 'releases' and exists (select 1 from org_members where user_id = auth.uid() and role = 'owner'))
  with check (bucket_id = 'releases' and exists (select 1 from org_members where user_id = auth.uid() and role = 'owner'));
