-- agent_stats (F3 · P8): UMA query agregada — uma linha por (agente, tarefa) em que ele trabalhou.
-- ?1 = agent_id ou NULL (todos — a grade "Meu time" sai de uma chamada só). Mesmo texto no Rust (include_str!) e no
-- teste de desempenho do node (src/agentes-f3.test.ts): 500 tarefas < 150 ms. Linha antiga sem agent_id = "sem ficha".
WITH part AS (
  SELECT agent_id, task_id, MAX(role) AS role FROM (
    SELECT agent_id, task_id, role FROM event
     WHERE agent_id IS NOT NULL AND agent_id <> '' AND type IN ('papel', 'veredito', 'done') AND (?1 IS NULL OR agent_id = ?1)
    UNION ALL
    SELECT agent_id, task_id, role FROM cost
     WHERE agent_id IS NOT NULL AND agent_id <> '' AND (?1 IS NULL OR agent_id = ?1)
  ) GROUP BY agent_id, task_id
),
usd AS (
  SELECT agent_id, task_id, SUM(usd) AS usd FROM cost
   WHERE agent_id IS NOT NULL AND agent_id <> '' AND (?1 IS NULL OR agent_id = ?1)
   GROUP BY agent_id, task_id
),
tev AS (
  SELECT task_id,
         SUM(CASE WHEN type = 'note' AND text LIKE 'rework: aplicando ajuste%' THEN 1 ELSE 0 END) AS reworks,
         SUM(CASE WHEN type = 'veredito' AND ok = 0 THEN 1 ELSE 0 END) AS muda
    FROM event
   WHERE type IN ('note', 'veredito') AND task_id IN (SELECT task_id FROM part)
   GROUP BY task_id
),
rv AS (
  SELECT agent_id, task_id, COUNT(*) AS rounds FROM event
   WHERE type = 'veredito' AND agent_id IS NOT NULL AND (?1 IS NULL OR agent_id = ?1)
   GROUP BY agent_id, task_id
)
SELECT p.agent_id, p.task_id, t.title, t.status, t.created_at, COALESCE(p.role, ''),
       COALESCE(u.usd, 0), COALESCE(e.reworks, 0), COALESCE(e.muda, 0), COALESCE(r.rounds, 0),
       CASE WHEN json_valid(t.spec_json) AND json_type(t.spec_json, '$.taskKind') = 'text' THEN json_extract(t.spec_json, '$.taskKind') END,
       CASE WHEN json_valid(t.spec_json) AND json_type(t.spec_json, '$.prUrl') = 'text' THEN json_extract(t.spec_json, '$.prUrl') END
  FROM part p
  JOIN task t ON t.id = p.task_id
  LEFT JOIN usd u ON u.agent_id = p.agent_id AND u.task_id = p.task_id
  LEFT JOIN tev e ON e.task_id = p.task_id
  LEFT JOIN rv r ON r.agent_id = p.agent_id AND r.task_id = p.task_id
 ORDER BY t.created_at DESC
