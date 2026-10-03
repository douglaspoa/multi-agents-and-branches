-- agent_stats_prev (F4 · P12): o PREVISTO de cada tarefa (US$, o que a pessoa viu na Nova demanda — 33-previsao.js grava
-- em `estimate.json.total.usd`). Query à parte porque a tabela `estimate` só existe depois da 1ª previsão salva: sem ela,
-- o boletim continua (o erro de previsão fica "sem previsão"). Mesmo texto no Rust (include_str!) e no teste node.
SELECT task_id, json_extract(json, '$.total.usd') FROM estimate
 WHERE json_valid(json) AND json_type(json, '$.total.usd') IN ('real', 'integer') AND json_extract(json, '$.total.usd') > 0
