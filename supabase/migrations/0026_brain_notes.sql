-- 0026 · brain_notes: o CÉREBRO DO TIME — memória do projeto em notas markdown ligadas por
-- [[links]], compartilhada pelos membros da org (mesmo padrão de project_prefs, 0018).
-- Cada nota é uma linha (org_id, repo, slug); o app espelha em .cardume/memoria/time/<slug>.md
-- e sincroniza nos dois sentidos (mais recente vence, por updated_at × mtime do arquivo).
-- Apagar é SOFT (deleted_at = lápide): quem ainda tem a nota a apaga só se a lápide for mais
-- nova que a cópia dela; uma edição posterior (de qualquer lado) vence a lápide e revive a nota.
-- `by` é o rastro legível de quem escreveu (pessoa, ou "agente · tarefa …"); `origem` separa
-- memória gravada por agente (selo "nova" até alguém ver) da escrita por pessoa.
-- updated_by/updated_at são carimbados pelo SERVIDOR (gatilho). Idempotente.
create table if not exists brain_notes (
  org_id     uuid not null references orgs(id) on delete cascade,
  repo       text not null,
  slug       text not null,
  title      text not null default '',
  type       text not null default 'contexto',
  tags       text[] not null default '{}',
  body       text not null default '',
  by         text not null default '',
  origem     text not null default 'pessoa',
  updated_by uuid references auth.users(id) default auth.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (org_id, repo, slug)
);
alter table brain_notes add column if not exists deleted_at timestamptz;
create index if not exists brain_notes_repo_idx on brain_notes (org_id, repo, updated_at desc);

alter table brain_notes drop constraint if exists brain_notes_type_chk;
alter table brain_notes add constraint brain_notes_type_chk
  check (type in ('decisão', 'regra', 'gotcha', 'contexto', 'pessoa', 'glossário'));
alter table brain_notes drop constraint if exists brain_notes_origem_chk;
alter table brain_notes add constraint brain_notes_origem_chk check (origem in ('pessoa', 'agente'));

-- quem gravou e quando: sempre o servidor (o cliente não forja autor nem data)
create or replace function brain_notes_stamp() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists brain_notes_stamp on brain_notes;
create trigger brain_notes_stamp before insert or update on brain_notes
  for each row execute function brain_notes_stamp();

alter table brain_notes enable row level security;
-- qualquer membro da org lê e escreve as notas dos projetos dela; só grava em nome de si mesmo
drop policy if exists brain_notes_all on brain_notes;
drop policy if exists brain_notes_select on brain_notes;
drop policy if exists brain_notes_write on brain_notes;
drop policy if exists brain_notes_update on brain_notes;
drop policy if exists brain_notes_delete on brain_notes;
create policy brain_notes_select on brain_notes for select
  using (exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()));
create policy brain_notes_write on brain_notes for insert
  with check (updated_by = auth.uid()
    and exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()));
create policy brain_notes_update on brain_notes for update
  using (exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()))
  with check (updated_by = auth.uid()
    and exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()));
create policy brain_notes_delete on brain_notes for delete
  using (exists (select 1 from org_members om where om.org_id = brain_notes.org_id and om.user_id = auth.uid()));

grant select, insert, update, delete on brain_notes to authenticated;
