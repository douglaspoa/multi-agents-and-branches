# 03 · Do que os usuários reclamam (e onde o Starfork ganha)

[← voltar ao índice](README.md)

Fontes: threads do Hacker News, issues do GitHub, fóruns oficiais, Trustpilot e blogs. A frequência foi estimada pelo número de fontes independentes.
Algumas reclamações são do próprio Claude Code/Codex: todo orquestrador as herda, e quem resolver ganha.
**[NV]** = só fonte secundária. As menções no Reddit/X estão em [04-redes-e-anuncios.md](04-redes-e-anuncios.md).

## As 10 reclamações que mais se repetem

### 1. "O agente disse que estava pronto, mas está quebrado". Frequência: **muito alta**

Afeta Claude Code, Devin e Vibe Kanban.

- *"reports ALL PASSED when tests are FAILING"*: [issue #46940 do Claude Code](https://claudeissues.com/issue/46940-claude-fabricates-test-results-reports-all-passed-when-tests-are-failing)
- *"you end up with compounded false affirmatives"*: [HN, lançamento do Vibe Kanban](https://hn.svelte.dev/item/44533004)
- A Answer.AI testou o Devin em 20 tarefas: **3 sucessos**. Citações: *"rabbit hole… couldn't get out of"*, *"spaghetti code… more confusing than if I'd written it"* ([answer.ai](https://www.answer.ai/posts/2025-01-08-devin))
- Um projeto (Cosmo) criou *"three-layer defense against test-gaming"* ao perceber que o agente burlava testes ([Reddit](https://www.reddit.com/r/ClaudeCode/comments/1vx07ry/weekly_showcase_thread_what_are_you_building_with/p6t1098/))

**Starfork:** ✅ já resolve, com prova por requisito, gate e "rodar checagens" fora do agente.
**Melhorar:** o gate detectar se o agente **alterou testes ou asserts** (contar asserts, `skip`, `.only`) e mostrar isso na revisão.
**Mensagem:** *"Seu agente disse 'feito'. O Starfork pede a prova."*

### 2. Setup de cada worktree (`.env`, portas, `node_modules`, banco). Frequência: **muito alta**

Afeta Superset, Conductor e Claude Squad.

- *"this means I would need ten different copies of my database"* / *"it would be great if tool like this could manage the ports"*: [HN, lançamento do Superset](https://news.ycombinator.com/item?id=46368739)
- Claude Squad [issue #260](https://github.com/smtg-ai/claude-squad/issues): *"worktree environment setup hook (deps, env files, port isolation)"*
- O Conductor exige script de setup próprio e cópia manual de arquivos ignorados pelo git. Usa `CONDUCTOR_PORT`.
- No Reddit, usuários contam que escrevem um `setup-wt.sh` por projeto para dependências, symlinks e portas ([Reddit](https://www.reddit.com/r/ClaudeCode/comments/1rae7sa/5_claude_code_worktree_tips_from_creator_of/o6kdaoq/))

**Starfork:** ✅ quase completo. `src/env-up.ts` acha porta livre, a worktree é **semeada** do repo principal (`.env` copiados, `node_modules`/`.venv` linkados) e o `RUNBOOK.md` guarda os passos validados.
**Melhorar:** banco por worktree (snapshot ou template).
**Mensagem:** *"Cada agente na sua cópia do projeto, com `.env`, dependências e porta próprios. Sem configurar nada."*

### 3. Gasto surpresa. Frequência: **muito alta**

Afeta Cursor, Warp, Factory e Devin.

- Cursor: *"nearly 50 separate Opus calls in under 10 minutes"*, *"silently logged"*, com o plano Pro consumido em 10 minutos ([fórum do Cursor](https://forum.cursor.com/t/pro-plan-burned-in-10-minutes-by-background-agent-calls-completely-unacceptable/118368))
- Warp: *"2500 requests vanished after only 10 prompts"* ([Trustpilot](https://nz.trustpilot.com/review/warp.dev)). As "AI requests unlimited" viraram limitadas, e o modelo de preço mudou em dez/2025 ([blog](https://www.warp.dev/blog/warp-new-pricing-flexibility-byok))
- Factory: cobrança por token surpreende no primeiro mês [NV]

**Starfork:** ✅ estimativa em R$ antes de rodar e teto por tarefa.
**Melhorar:** mostrar **real × estimado ao vivo** e pausar ao atingir 80% do teto.
**Mensagem:** *"Você sabe quanto vai custar antes de apertar Enter. Em reais."*

### 4. A revisão vira o gargalo. Frequência: **alta**

Vale para todas as ferramentas.

- *"the natural bottleneck on all of this is how fast I can review the results"*: [Simon Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- *"The real bottleneck isn't human review per se, it's unstructured review."*: [HN Superset](https://news.ycombinator.com/item?id=46368739)
- *"Codex burnout"*: quem orquestrou 8 agentes diz que *"can't remember anything much from the work"* ([Reddit](https://www.reddit.com/r/codex/comments/1thr1kw/codex_burnout/ompp8on/))

**Starfork:** ⚠️ parcial. A Entrega organiza por requisito.
**Melhorar:** resumo de revisão mostrando só o que falhou ou mudou de risco, e um "o que você precisa saber deste código".
**Mensagem:** *"Revise provas, não 2.000 linhas de diff."*

### 5. Conflito de merge entre agentes. Frequência: **alta**

- *"Most of these tools don't make working with Git merges or conflicts to main simpler"* ([HN Superset](https://news.ycombinator.com/item?id=46368739))
- Uma análise de 33.596 PRs aponta que 4 em cada 5 PRs de agente disputam o mesmo alvo de merge ([danielvaughan.com](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/))
- *"A clean git merge of my two agents' worktrees that failed its own tests"*, ou seja, conflito **semântico** ([Reddit](https://www.reddit.com/r/AI_Agents/comments/1wntjk6/a_clean_git_merge_of_my_two_agents_worktrees_that/pbhwt1y/))

**Starfork:** ⚠️ parcial. O barramento de claims evita parte dos conflitos e a Central mostra "arquivo disputado".
**Melhorar:** **gate de integração** (mergear numa branch de integração e rodar a suíte inteira) e sugerir a ordem de merge.
**Mensagem:** *"Saiba do conflito antes do merge, não depois."*

### 6. Só Mac ou Windows quebrado. Frequência: **alta**

- *"any particular reason a Windows build isn't available yet?"* ([HN Superset](https://news.ycombinator.com/item?id=46368739))
- Claude Squad [#275](https://github.com/smtg-ai/claude-squad/issues): *"creack/pty is unsupported on Windows"*
- Conductor: *"macOS only, Apple Silicon required"* ([morphllm.com](https://www.morphllm.com/parallel-coding-agents)). O app novo é Cloud.
- No Reddit, em *"for my windows peeps how are you using it?"*, a resposta é *"Try superset.sh"* ([Reddit](https://www.reddit.com/r/ClaudeCode/comments/1roonw1/for_my_windows_peeps_how_are_you_using_it/o9fhhjm/))

**Starfork:** ✅ Tauri em macOS, Windows e Linux.
**Mensagem:** *"Agentes em paralelo também no Windows e no Linux."* + página "Alternativa ao Conductor para Windows".

### 7. Rate limit (429) com agentes em paralelo. Frequência: **alta**

- *"429 Rate Limit with Multiple Parallel Sessions Below Usage Cap"* ([issue #46037](https://claudeissues.com/issue/46037-bug-anthropic-api-error-429-rate-limit-with-multiple-parallel-sessions-below-usa))
- Vídeo *"Claude, what time do you reset?"*: 42 mil views em 1 dia ([TikTok](https://www.tiktok.com/@agentmorphy/video/7696090369607421216))
- Usuários montam roteamento entre várias contas para fugir do limite ([clausona](https://www.reddit.com/r/ClaudeCode/comments/1wz4oif/my_parallelagent_workflow_one_claude_code_session/))

**Starfork:** ❌ hoje só mostra *"O Claude está sem cota/limite no momento — espere um pouco e tente de novo"* (`src/ai-once.ts`).
**Melhorar:** fila com concorrência adaptativa (ao receber 429, segurar os próximos e retomar sozinho) e troca de motor com um clique (Codex/DeepSeek).
**Mensagem:** *"Bateu no limite? O Starfork segura a fila e continua sozinho."*

### 8. Privacidade e permissões. Frequência: **média**

- Os background agents do Cursor exigiam o privacy mode desligado ([docs](https://docs.cursor.com/background-agent))
- Vibe Kanban: *"analytics appear to default to enabled"*, *"The permissions this asks for feel kinda insane"* ([HN](https://hn.svelte.dev/item/44533004))

**Starfork:** ⚠️ parcial, porque o código fica local.
**Melhorar:** telemetria só com opt-in e permissão mínima no GitHub, tudo documentado na página de Segurança.
**Mensagem:** *"Seu código não sai da sua máquina."*

### 9. Comando destrutivo e segredos. Frequência: **média, mas cada caso é grave**

- *"executed destructive database operation without user approval"* ([issue #45463](https://claudeissues.com/issue/45463-claude-code-executed-destructive-database-operation-without-user-approval))
- `terraform destroy` em produção ([vibegraveyard.ai](https://vibegraveyard.ai/story/claude-code-terraform-datatalks-infrastructure-destruction/))
- Conductor: *"Agents run directly on your system without sandboxing"* ([FAQ](https://www.conductor.build/docs/faq#what-permissions-do-agents-have)), e um usuário parou de usar por isso ([Reddit](https://www.reddit.com/r/conductorbuild/comments/1t0875l/approvals_and_sandboxing/))

**Starfork:** ✅ modo protegido (bloqueia `.env` e comandos destrutivos).
**Melhorar:** ampliar a lista (`rm -rf ~`, `dropdb`, `terraform destroy`, `git push --force` na main) e checar a expansão de caminho.
**Mensagem:** *"O agente não apaga o seu banco."* Em vídeo: o modo protegido bloqueando os comandos dos incidentes reais.

### 10. App pesado e ferramenta que morre. Frequência: **média**

- Sculptor: *"sculptor_backend seems to consume a lot of CPU and memory when just idling… switching from Electron to Tauri?"* ([HN](https://news.ycombinator.com/item?id=45462236))
- Vibe Kanban encerrado em 10/04/2026 ([shutdown](https://vibekanban.com/shutdown)), Crystal descontinuado ([GitHub](https://github.com/stravu/crystal)) e Terragon fechado
- No r/brdev, um dev "ressuscitou" o Vibe Kanban porque precisava dele ([Reddit](https://www.reddit.com/r/brdev/comments/1vy3gvg/peguei_um_projeto_abandonado_de_vibe_coding_e/))

**Starfork:** ⚠️ parcial. Tauri é mais leve que Electron.
**Melhorar:** publicar o benchmark de RAM e CPU em repouso e oferecer exportação completa dos dados.
**Mensagem:** *"Leve como Tauri. Seus dados exportáveis sempre."*

## Reclamações por ferramenta (só as verificadas)

| Ferramenta | Reclamações |
|---|---|
| Conductor | Antes só Mac com Apple Silicon. Sem sandbox. Workspace nasce sem os arquivos ignorados pelo git. Não dá para editar código no app ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1uwguoh/those_of_you_running_multiple_claude_code/oxj33xz/)). Força worktree até para mudança pequena ([Reddit](https://www.reddit.com/r/termic/comments/1tji4uv/welcome_to_rtermic_opensource_sandboxed/)) |
| Superset | Sem build para Windows no lançamento. Banco e portas em 10 agentes. *"10x the cost with 0 to show"*. Licença ELv2 [NV] |
| Orca | Bugs no Windows e release quase diária. O app mobile só acompanha [NV] |
| Vibe Kanban | Telemetria ligada por padrão, permissões amplas, empresa encerrada |
| Claude Squad | Quebra no Windows (#275), prompt perdido (#266), sem hook de setup (#260) |
| Sculptor | Electron pesado, setup multi-repo/Docker desajeitado |
| Devin | 3 sucessos em 20 tarefas, custo por ACU difícil de prever [NV] |
| Cursor | Plano consumido em minutos, suporte por bot ([fórum](https://forum.cursor.com/t/cursor-support-email-replies/122111)), exigia privacy mode desligado |
| Warp | "Unlimited" virou limitado, overage 8x mais caro que os créditos incluídos |

## Resumo: placar do Starfork

| Dor | Frequência | Starfork |
|---|---|---|
| Agente que mente | Muito alta | ✅ |
| Setup de worktree | Muito alta | ✅ (falta o banco) |
| Gasto surpresa | Muito alta | ✅ |
| Fadiga de revisão | Alta | ⚠️ |
| Conflito de merge | Alta | ⚠️ |
| Só Mac | Alta | ✅ |
| Rate limit | Alta | ❌ **prioridade** |
| Privacidade | Média | ⚠️ |
| Comando destrutivo | Média/grave | ✅ |
| Peso e continuidade | Média | ⚠️ |
