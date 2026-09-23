-- 0025 · epics.spec: o envelope do épico (Description, Outcome, Requirements, Done when,
-- Boundaries), gravado pelo card "Épico proposto" do planner. Idempotente.
-- Formato do jsonb:
--   { description, outcome,
--     requirements: [{ id: "R1", text }],
--     doneWhen:     [{ id: "D1", text, checkedBy, checkedAt, evidence }],   -- checkedBy ausente = em aberto
--     boundaries:   [text] }
-- checkedBy é o uuid de quem marcou OU "agent:<local_id da tarefa>" quando foi o agente revisor.
-- Épico antigo fica com '{}' e continua válido. Convenção do app a partir daqui: status também usa 'in-progress'
-- (open | in-progress | done | archived); a coluna é texto livre (0004), nada muda nela.
-- RLS: epics_write (0004) já deixa qualquer membro do time atualizar — nada novo aqui.
alter table epics add column if not exists spec jsonb not null default '{}'::jsonb;
alter table epics add column if not exists updated_at timestamptz not null default now();
