-- 0013: gates de segurança NO BANCO (não só na UI)
-- Regra do produto: demanda de outro membro é ACOMPANHAMENTO (spec, entregáveis,
-- provas). Chat do agente, mensagens e comandos (intents via tasks.spec) são do
-- DONO — dono = assignee, senão quem criou. Lead/admin mantêm gestão de cartões.

create or replace function task_owner(p_task uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(assignee, created_by) from tasks where id = p_task;
$$;

-- tasks.UPDATE era "qualquer membro do time" → qualquer um mandava intent
-- (pausar/abortar/abrir PR) pro Mac alheio. Agora: dono; cartão livre do
-- backlog (sem assignee) segue editável pelo time; lead/admin gerenciam.
drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks for update
  using (
    coalesce(assignee, created_by) = auth.uid()
    or (assignee is null and is_team_member(team_id))
    or is_team_lead(team_id)
    or is_org_admin(org_of_team(team_id))
  );

-- task_feed (chat/passos do agente): SÓ o dono lê e escreve
drop policy if exists feed_select on task_feed;
create policy feed_select on task_feed for select
  using (task_owner(task_id) = auth.uid());
drop policy if exists feed_insert on task_feed;
create policy feed_insert on task_feed for insert
  with check (task_owner(task_id) = auth.uid());

-- task_messages (humano → agente): idem, só o dono
drop policy if exists msg_select on task_messages;
create policy msg_select on task_messages for select
  using (task_owner(task_id) = auth.uid());
drop policy if exists msg_insert on task_messages;
create policy msg_insert on task_messages for insert
  with check (author = auth.uid() and task_owner(task_id) = auth.uid());
drop policy if exists msg_update on task_messages;
create policy msg_update on task_messages for update
  using (task_owner(task_id) = auth.uid());

-- questions: VER continua do time (transparência — professor/TL acompanham);
-- RESPONDER/editar é só do dono da task (a resposta guia o agente DELE)
drop policy if exists questions_write on questions;
drop policy if exists questions_owner_write on questions;
create policy questions_owner_write on questions for all
  using (task_owner(task_id) = auth.uid())
  with check (task_owner(task_id) = auth.uid());
