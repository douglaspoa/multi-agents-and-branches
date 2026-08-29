# Times — desenvolvimento local

O backend do modo Times roda **100% local** com o Supabase CLI (mesma API da
nuvem — o app não sabe a diferença).

## Subir

```bash
supabase start        # na raiz do repo (precisa do Docker aberto)
```

- Portas movidas pra **543x1..7** (`supabase/config.toml`) pra não colidir com
  outros projetos Supabase locais da máquina.
- API: `http://127.0.0.1:54341` · Studio (inspecionar o banco): `http://127.0.0.1:54343`
- O app já vem apontado pro local por padrão (`SB_DEFAULT` no `index.html`);
  confirmação de e-mail está desligada — criar conta loga na hora.

## Migrações

Schema + RLS + RPCs vivem em `supabase/migrations/0001_teams.sql`.

```bash
supabase db reset     # re-aplica as migrações do zero (apaga os dados locais)
```

## Teste de regressão do contrato

```bash
node scripts/e2e-teams.mjs
```

Cobre: signup→profile, criar org+time, convite com assento, RLS (fora do time
não vê nada), compartilhar tarefa, claim livre, claim NEGADO em tarefa "pra
si", sync do cartão (status/custo/versão) e trilha de atividade.

## Migrar pra nuvem (quando o projeto Supabase existir)

1. Criar o projeto em supabase.com;
2. `supabase link --project-ref <ref>` e `supabase db push` (aplica as mesmas
   migrações), ou colar o SQL no SQL Editor;
3. No app: **Entrar → backend… → colar Project URL + anon key** (fica em
   localStorage, com precedência sobre o local) — ou trocar o `SB_DEFAULT` no
   `index.html` pra deixar baked no build de todo mundo.
