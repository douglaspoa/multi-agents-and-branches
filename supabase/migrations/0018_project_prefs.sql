-- 0018: PREFERÊNCIAS DO PROJETO — um arquivo por projeto, criado e evoluído
-- pelo TIME, que os agentes seguem. Não é cópia de memória de ninguém: é um
-- documento novo, compartilhado (convenções do projeto).
create table if not exists project_prefs (
  org_id     uuid not null references orgs(id) on delete cascade,
  repo       text not null,
  content    text not null default '',
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (org_id, repo)
);
alter table project_prefs enable row level security;
-- qualquer membro da org lê e edita as preferências dos projetos dela
drop policy if exists project_prefs_all on project_prefs;
create policy project_prefs_all on project_prefs for all
  using (exists (select 1 from org_members om where om.org_id = project_prefs.org_id and om.user_id = auth.uid()))
  with check (exists (select 1 from org_members om where om.org_id = project_prefs.org_id and om.user_id = auth.uid()));
