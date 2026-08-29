# Bugs críticos & ajustes — feedback do Douglas (28/08)

Fonte: `2026-08-28-bugs-criticos-e-pr-autocomplete.pdf` (dogfooding real).
O PDF também guarda o **escopo real do PR do autocomplete** (usar em breve):
NCM semântico portado do api-hub-ia (OpenSearch, sem HTTP ao hub), provider
genérico de entidade/dimensão, front generalizado (`FilterAutocompleteInput`
por `kind`), gate beta `home_ncm_autocomplete` (RDS beta_testers, fail-closed),
merge com origin/main já feito. **Ressalvas conhecidas:** filtros bloqueados do
recorte Importação Brasil NÃO entram nesse PR (gate real é o contrato da tool
`logcomex_product_intelligence`); ranking do NCM com `limit=20` degenera
(brand_match espúrio + similarity_score) — fix de scoring em tarefa separada.

## Checklist

- [x] 1. **Chat contínuo** — quando o agente pergunta (ask_human), responder no
      chat deve RESOLVER a pergunta e continuar o MESMO turno (hoje mata o
      processo e reinicia a conversa).
- [x] 2. **Chat: Enter envia** (Shift+Enter quebra linha); botão de **anexo**;
      `@`/`/` pra referenciar arquivos da task e artefatos.
- [x] 3. **Artefatos ilegíveis** — nome preto em tema preto; ordenar por data de
      criação; **versões** (v2, v3…) quando gerado mais de uma vez; separar por
      **categoria** (Docs / Testes / Provas / Outros).
- [x] 4. **Agente deve SEMPRE perguntar** quando não entendeu ou não consegue
      cumprir um requisito — mesmo em modo auto. Antes quebrar a regra e
      perguntar do que entregar sem os requisitos / decidir não fazer.
- [x] 5. **Testes reais** — nada de script + front mockado: subir o ambiente
      local na branch trabalhada e testar de verdade.
- [x] 6. **PR sem ressalvas** — o agente não deve abrir PR por conta própria; se
      pedirem, só abrir depois de revisar e SEM pendências (senão pergunta).
- [ ] 7. **Planner (criar task com IA)** — poder selecionar docs/prints/testes
      (artefatos) na criação; a IA deve perguntar se queremos.
- [ ] 8. **Provas por requisito** — linkar print e/ou teste a cada requisito
      colocado como entregável (verificar no fim se TODOS foram cumpridos).
- [ ] 9. **Área dedicada de PR** — abrir PR, ver comentários, corrigir (estava
      no redesign); ao criar a issue, perguntar se quer abrir PR e pra qual
      branch.
