---
title: Gateway de pagamento dá timeout no sandbox
type: gotcha
tags: [checkout, pagamento]
updated: 2026-09-28
by: agente · fim da tarefa "Checkout único" (checkout-unico)
origem: agente
aliases: [gateway lento]
---
O sandbox do gateway corta em 30s: use o mock `PAY_MOCK=1` nos testes do checkout. Relacionado: [[decisao-um-passo]] e [[usar-pnpm]].
