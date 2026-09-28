-- 0026 · brain_notes: o CÉREBRO DO TIME — memória do projeto em notas markdown ligadas por
-- [[links]], compartilhada pelos membros da org (mesmo padrão de project_prefs, 0018).
-- Cada nota é uma linha (org_id, repo, slug); o app espelha em .cardume/memoria/time/<slug>.md
-- e sincroniza nos dois sentidos (mais recente vence, por updated_at × mtime do arquivo).
-- `by` é o rastro legível de quem gravou (pessoa, ou "agente · tarefa …"); `origem` separa
-- memória gravada por agente (selo "nova" até alguém ver) da escrita por pessoa. Idempotente.
create table if not exists brain_notes (
  org_id     uuid not null references orgs(id) on delete cascade,
  repo       text not null,
  slug       text not null,
  title      text not null default '',
  type       text not null default 'contexto',   -- decisão | regra | gotcha | contexto | pessoa | glossário
  tags       text[] not null default '{}',
  body       text not null default '',
  by         text not null default '',
  origem     text not null default 'pessoa',     -- pessoa | agente
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (org_id, repo, slug)
);
create index if not exists brain_notes_repo_idx on brain_notes (org_id, repo, updated_at desc);

alter table brain_notes enable row level security;
-- qualquer membro da org lê e escreve as notas dos projetos dela
drop policy if exists brain_notes_all on brain_notes;
create policy brain_notes_all on brain_notes for all
  using (exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()))
  with check (exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()));

grant select, insert, update, delete on brain_notes to authenticated;
