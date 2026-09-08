-- 0017: lead pode RENOMEAR o próprio time (delete/create seguem só admin da org).
-- team_members já deixa o lead gerenciar os membros do time dele (0-base).
drop policy if exists teams_lead_rename on teams;
create policy teams_lead_rename on teams for update
  using (is_team_lead(id)) with check (is_team_lead(id));
