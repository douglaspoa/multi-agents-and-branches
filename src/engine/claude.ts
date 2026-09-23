import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ApprovalMode } from "../types.ts";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";
import { readAltConfig, ensureAltProxy } from "./altProxy.ts";

/**
 * Perfil do Chrome pra este agente. O perfil é PERSISTENTE por repo (login feito uma vez
 * vale pras próximas rodadas), mas o Chrome só aceita UMA instância por perfil: com tarefas
 * em paralelo, o 2º agente não conseguia abrir o navegador ("profile in use") e ficava sem
 * mexer na tela. Regra: se o perfil do repo está em uso (SingletonLock), o agente ganha uma
 * CÓPIA própria semeada com os cookies/logins atuais — cada tarefa no seu Chrome.
 */
export function browserProfileFor(cwd: string, taskId: string): string {
  const repoKey = (cwd.split("/.cardume/")[0] || cwd).replace(/[^a-zA-Z0-9]+/g, "_").slice(-60);
  const root = join(homedir(), ".constellation", "browser");
  const shared = join(root, repoKey);
  mkdirSync(shared, { recursive: true });
  // o SingletonLock do Chrome é um symlink PENDENTE ("host-pid") — existsSync devolve false; lstat enxerga
  const lexists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  const inUse = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"].some((f) => lexists(join(shared, f)));
  if (!inUse) return shared;
  const tasksDir = join(root, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  // limpa cópias antigas (>3 dias) — são descartáveis, o perfil de verdade é o do repo
  try {
    for (const d of readdirSync(tasksDir)) {
      const p = join(tasksDir, d);
      try { if (Date.now() - statSync(p).mtimeMs > 3 * 864e5) rmSync(p, { recursive: true, force: true }); } catch { /* ignora */ }
    }
  } catch { /* ignora */ }
  const mine = join(tasksDir, `${repoKey}__${taskId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(-40)}`);
  if (!existsSync(mine)) {
    const skip = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "CacheStorage", "Crashpad"]);
    try {
      cpSync(shared, mine, { recursive: true, filter: (src) => !skip.has(src.split("/").pop() ?? "") });
    } catch {
      // cópia parcial ou perfil sem nada ainda: perfil vazio próprio (funciona, só sem login salvo)
      mkdirSync(mine, { recursive: true });
    }
  }
  return mine;
}

/** "Mostrar o navegador dos agentes" (Configurações → ~/.constellation/settings.json). Padrão: segundo plano. */
export function browserVisibleSetting(): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".constellation", "settings.json"), "utf8")) as Record<string, unknown>;
    const v = raw.browserVisible;
    return v === true || v === "1" || v === "true";
  } catch {
    return false;
  }
}

/** A tarefa parece web/UI? Só nesses casos o agente ganha o navegador (Playwright). */
function needsBrowser(spec: { title?: string; objective?: string; deliverables?: string[]; requirements?: string[]; kind?: string }): boolean {
  if (spec.kind === "design") return true;
  const hay = [spec.title, spec.objective, ...(spec.deliverables ?? []), ...(spec.requirements ?? [])]
    .filter(Boolean).join(" ").toLowerCase();
  return /\b(ui|ux|tela|telas|front[- ]?end|frontend|web|p[áa]gina|p[áa]ginas|navegador|browser|playwright|puppeteer|e2e|end[- ]?to[- ]?end|screenshots?|responsiv\w*|css|landing|dashboard|modal|formul[áa]rio|bot[ãa]o|componente\w* visua)\b/.test(hay);
}
/** npx ao lado do node em uso (nvm/homebrew) — evita PATH stale; senão "npx". */
function npxNear(): string {
  const cand = join(dirname(process.execPath), "npx");
  return existsSync(cand) ? cand : "npx";
}

/**
 * Acha o binário do `claude` sem depender do PATH — que pode estar stale quando
 * o app é lançado via LaunchServices (LSEnvironment). Ordem: CARDUME_CLAUDE →
 * ao lado do node em uso (mesma pasta bin do nvm/homebrew) → "claude" no PATH.
 */
/** Há pergunta (ask_human) aberta pra esta tarefa? Esperar o humano NÃO é inatividade. */
function hasOpenAsk(dbFile: string, taskId: string): boolean {
  try {
    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM pending WHERE task_id = ? AND status = 'open'").get(taskId) as { n?: number } | undefined;
      return !!row && Number(row.n) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function resolveClaude(): string {
  if (process.env.CARDUME_CLAUDE) return process.env.CARDUME_CLAUDE;
  // Ao lado do node em uso PRIMEIRO (nvm/dev — o claude que o dono atualiza);
  // depois os locais padrão pra PATH mínimo de app GUI (instalador nativo etc.).
  try {
    const near = join(dirname(process.execPath), "claude");
    if (existsSync(near)) return near;
  } catch {
    /* ignora */
  }
  try {
    const home = homedir();
    for (const p of [
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]) {
      if (existsSync(p)) return p;
    }
  } catch {
    /* ignora */
  }
  return "claude";
}

/**
 * Motor REAL — roda o Claude Code headless dentro da worktree.
 * Isto é Claude Code (sua assinatura), NÃO a API /messages.
 *
 *   claude -p "<prompt>" --output-format stream-json --verbose \
 *     [--dangerously-skip-permissions]  (modo approval "auto")
 *     --append-system-prompt "<barramento>" [--model <m>]
 *
 * O parser abaixo foi ajustado ao schema real do stream-json (system/init,
 * assistant text+tool_use, post_turn_summary, result).
 */
export class ClaudeEngine implements AgentEngine {
  id = "claude";
  displayName = "Claude Code";
  private model?: string;
  private approval: ApprovalMode;

  constructor(opts: { model?: string; approval?: ApprovalMode } = {}) {
    this.model = opts.model;
    this.approval = opts.approval ?? "ask";
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const ROLE_INSTR: Record<string, string> = {
      planner: "Seu papel é PLANNER: leia o TASK.yaml e escreva .cardume/PLAN.md com o plano em passos. Não implemente.",
      reviewer: "Seu papel é REVIEWER: leia o diff da branch (git diff) e resuma o que foi feito, funções criadas e para que servem, e como testar.",
      designer: "Seu papel é DESIGNER: defina a UX/UI (layout, hierarquia, estados, acessibilidade) antes do código. Escreva .cardume/DESIGN.md.",
      tester: "Seu papel é TESTER: escreva e rode testes cobrindo o caminho principal e casos de borda.",
      docs: "Seu papel é DOCS: escreva documentação concisa com exemplos de uso.",
      security: "Seu papel é SECURITY: audite riscos (injeção, authz, segredos) e proponha correções.",
      investigator: "Seu papel é INVESTIGADOR: ache a CAUSA RAIZ do problema com evidência — NÃO implemente a correção. Reproduza o caso no ambiente/telemetria reais, prove a causa com experimento e entregue um diagnóstico.",
      builder: "Seu papel é BUILDER: implemente a tarefa descrita.",
    };
    const roleInstr = (ROLE_INSTR[input.role] ?? ROLE_INSTR.builder) + epicPlanRule(input);
    const askRule =
      this.approval === "ask"
        ? " IMPORTANTE: em QUALQUER decisão de requisito não trivial, chame mcp__cardume__ask_human e AGUARDE a resposta antes de prosseguir."
        : "";
    const arts = input.spec.artifacts ?? [];
    let artifactRule = "";
    if (arts.length && input.role !== "planner") {
      const lines = arts.map((a) =>
        a.kind === "doc"
          ? `- DOCUMENTO: escreva ".cardume/artifacts/${a.name}" em Markdown — ${a.desc ?? "documente a solução"}: contexto, decisões de design, principais componentes/arquivos criados e como se conectam. Seja claro e conciso.`
          : a.kind === "tests"
            ? `- TESTES: escreva e RODE testes REAIS na suíte do projeto (nada de script isolado ou front mockado — suba o ambiente local desta branch com as envs reais). Salve ".cardume/artifacts/tests.md" com os comandos e a SAÍDA real. Se algo não rodar, diga exatamente o quê e pergunte via ask_human.`
            : `- PROVA: comprove que a solução funciona NA UI/AMBIENTE REAL. Se for algo visual/web, suba a aplicação e capture screenshots reais como ".cardume/artifacts/proof.png". Caso contrário, salve ".cardume/artifacts/proof.md" com a evidência (comandos executados, saída, antes/depois). Se travar em algo, pergunte via ask_human — não improvise mock.`
      );
      artifactRule =
        ` Ao final, produza também estes ARTEFATOS (crie a pasta .cardume/artifacts/ se não existir):\n${lines.join("\n")}`;
    }
    const refs = input.spec.refs ?? [];
    const refRule = refs.length
      ? ` Há documentos de REFERÊNCIA anexados em .cardume/refs/ (${refs.join(", ")}) — LEIA-OS primeiro como ponto de partida (podem ser specs, prints de bug, PDFs, imagens).`
      : "";
    const envRule =
      " O ambiente desta worktree foi SEMEADO do repo principal (.env copiados, node_modules/.venv linkados) — veja .cardume/AMBIENTE.md. Antes de concluir que 'falta configuração', confira esse arquivo: o necessário pra RODAR o projeto provavelmente já está aqui.";
    const knowledgeRule =
      " MEMÓRIA DO PROJETO EM ARQUIVOS — USE ANTES DE REDESCOBRIR: (1) .cardume/RUNBOOK.md tem os passos JÁ VALIDADOS pra subir o ambiente (backend, front, envs, VPN) — siga-os literalmente em vez de deduzir; se você validar um passo novo ou corrigir um obsoleto, ATUALIZE o RUNBOOK.md (comandos exatos, pré-requisitos, portas) — o sistema leva sua edição de volta pro repo e TODAS as tarefas futuras ganham. (2) .cardume/HISTORY.md é o índice das tarefas passadas do projeto — faça grep por termos do seu problema ANTES de investigar do zero: issue parecida pode já ter sido resolvida, com a branch citada pra você ler o diff (git log/show). (3) .cardume/PREFS.md são as PREFERÊNCIAS/CONVENÇÕES DESTE PROJETO escritas pelo TIME (padrões de código, o que evitar, decisões acordadas) — LEIA e RESPEITE à risca; na dúvida entre duas formas, a que estiver aqui vence.";
    const specGapRule = (input.spec.linkedTo || (input.spec.refs ?? []).some((r) => /design|DESIGN\.md|INVESTIGATION\.md/i.test(r)))
      ? " HANDOFF DE DESIGN/DIAGNÓSTICO: esta entrega NASCE de um design ou investigação anexados — antes de escrever qualquer código, AVALIE se eles cobrem as decisões-chave (estados vazio/erro/carregando, origem dos dados, comportamentos de borda, o que fica fora). Qualquer lacuna ESSENCIAL ambígua → pergunte via mcp__cardume__ask_human ANTES de implementar, com opções concretas de interpretação — implementar em cima de suposição custa um rework inteiro; perguntar custa um minuto. Lacuna cosmética/pequena: decida sozinho e registre a decisão no resumo."
      : "";
    const scratchRule =
      " HIGIENE DO DIFF: scripts DESCARTÁVEIS de sondagem/verificação (probe, check, explore, harness de uma vez) NÃO fazem parte da entrega — crie-os em .cardume/tmp/ (ignorado pelo commit) ou APAGUE antes de finalizar. O diff final deve conter APENAS o que o revisor precisa mergear; teste reutilizável vai pra suíte do projeto, evidência vai pra .cardume/artifacts/.";
    const previewRule =
      " SERVIDOR LOCAL VISÍVEL: sempre que você SUBIR um servidor/ambiente pra testar (vite, uvicorn, next dev…), ANUNCIE numa linha de texto exatamente no formato '🌐 preview: http://127.0.0.1:PORTA/caminho' (use 127.0.0.1, não localhost) — e RE-ANUNCIE com o caminho novo quando mudar a página/subpágina que está testando. O humano clica nesse link pra acompanhar seu trabalho ao vivo (inclusive do celular).";
    const planRule =
      input.role === "builder" || input.role === "tester"
        ? " Se existir .cardume/PLAN.md, leia e SIGA o plano (o humano pode tê-lo revisado/ajustado)."
        : "";
    const adjustRule = input.spec.adjustment
      ? `⚠ AJUSTE SOLICITADO PELO HUMANO (prioridade máxima): ${input.spec.adjustment} — JÁ EXISTE trabalho feito nesta worktree; INCORPORE o ajuste sobre o que já existe (não recomece do zero). No seu papel: planner atualiza o .cardume/PLAN.md com o ajuste; builder aplica no código; reviewer confere o ajuste; docs atualiza a doc. `
      : "";
    // REVIEW DE PR: não há repositório pra editar — o diff completo está em DIFF.patch.
    const prRule = input.spec.kind === "review" && input.spec.prUrl
      ? ` Este é um REVIEW DE PULL REQUEST (${input.spec.prUrl}). NÃO há repositório pra editar; leia o arquivo DIFF.patch nesta pasta (o diff completo do PR) e faça um review CRÍTICO: bugs e correção, riscos/segurança, cobertura de testes, legibilidade e sugestões concretas por arquivo/trecho. Aponte também o que está bom. Escreva o parecer no chat (texto), com severidade por achado. NÃO tente implementar nem rodar o código.`
      : "";
    // PROVAS POR REQUISITO: cada requirement precisa de evidência linkada
    // (print e/ou teste) num JSON que a UI mostra junto dos critérios de aceite.
    const reqs = input.spec.requirements ?? [];
    const reqProofRule =
      reqs.length && input.role !== "planner"
        ? ` Ao FINAL do seu trabalho, escreva/atualize ".cardume/artifacts/requirements.json": um array JSON onde CADA requirement do TASK.yaml vira {"req": "<TEXTO EXATO do requisito, copiado do TASK.yaml>", "status": "done"|"blocked"|"deferred", "evidence": ["<arquivos em .cardume/artifacts/ que COMPROVAM — print e/ou teste>"], "note": "<explicação curta>"}. Requirement sem evidência real não é "done". Se algum ficar "blocked", pergunte ao humano ANTES de finalizar. Use "deferred" SOMENTE quando o HUMANO decidir (via ask_human) adiar/dispensar aquele requisito — registre a decisão dele na note; "deferred" não trava as próximas fases, "blocked" trava.`
        : "";
    // Regras INEGOCIÁVEIS (valem pra todos os papéis, em qualquer modo de autonomia):
    // o pior desfecho possível é entregar sem os requisitos ou "decidir não fazer".
    const integrityRule =
      " REGRAS INEGOCIÁVEIS: (1) Se você não entendeu algo, ou NÃO CONSEGUIR cumprir QUALQUER requisito/entregável do TASK.yaml, PERGUNTE ao humano via mcp__cardume__ask_human e AGUARDE — mesmo que a autonomia diga pra não perguntar; quebrar a regra de autonomia pra perguntar é MELHOR do que entregar sem um requisito, entregar errado ou decidir não fazer. NUNCA finalize silenciosamente com requisito de fora: ou cumpre, ou pergunta. (2) Antes de finalizar, CONFIRA a lista de requirements/deliverables um a um e diga no resumo final o status de cada um (cumprido / não cumprido + por quê). (3) NUNCA abra um Pull Request por conta própria; se o humano pedir pra abrir, só abra se NÃO houver pendências nem ressalvas — existindo qualquer ressalva, pergunte primeiro via ask_human.";
    const groundRule =
      " REGRA DE OURO — EXECUTE ANTES DE AFIRMAR: NUNCA conclua, diagnostique ou entregue com base só em LEITURA de código. Rode o projeto/fluxo LOCAL de verdade (as envs reais existem — .env, docker, suíte de testes, CLI) e OBSERVE o comportamento real antes de qualquer afirmação; 'provavelmente'/'deve ser'/'pelo código parece' sem ter executado NÃO VALE como verificação. Vale pra investigar, corrigir, revisar e entregar. Não conseguiu subir/rodar algo? Diga EXATAMENTE o que travou (comando + erro literal) e pergunte via mcp__cardume__ask_human — adivinhar é proibido.";
    const doneRule =
      " JULGAMENTO DE PRONTO — RECONHEÇA QUANDO ACABOU: antes de CADA nova rodada de trabalho, releia os requisitos e pergunte 'a evidência que JÁ TENHO satisfaz o critério como escrito?'. Se sim, PARE de coletar e FINALIZE — continuar 'reforçando' evidência já suficiente é desperdício, não rigor. Distinga determinístico de não-determinístico: código/teste SEU que falha é bug — investigue até a causa; saída de LLM/UI/rede que VARIA entre execuções é não-determinismo — no MÁXIMO 2 re-tentativas, e se seguir variando registre a ressalva honesta com os dados que tem e siga em frente (variação não é falha nem evidência faltante). PROIBIDO: loops de sleep/espera repetidos aguardando um resultado mudar sozinho, e re-rodar o mesmo comando esperando resultado diferente. Se um requisito parecer impossível de cumprir literalmente, mostre a evidência via mcp__cardume__ask_human em vez de moer.";
    const parallelRule =
      " RITMO E PARALELISMO — FECHE RÁPIDO: seu objetivo é CONVERGIR pra solução no menor tempo, não explorar sem fim. Divida o trabalho restante em frentes INDEPENDENTES e dispare subagentes (tool Task) EM PARALELO — várias chamadas Task na MESMA mensagem — ex.: reproduzir o bug ∥ escrever o teste ∥ varrer o código por ocorrências ∥ validar na UI. Cada subagente recebe instrução autocontida (arquivos, objetivo, critério de pronto) e a regra de ouro vale pra ele também. Só serialize o que realmente depende de resultado anterior. Passou de ~15 minutos sem avanço CONCRETO (edição, teste passando, causa provada)? PARE de insistir na mesma linha: paralelize hipóteses com subagentes ou pergunte via mcp__cardume__ask_human. Trabalho longo sem fechar pendência é falha, não diligência.";
    // liga o navegador se a SPEC for web/UI OU se a sua mensagem (steer/resume/
    // pedido) mencionar navegador/UI — assim "abre o navegador" funciona na hora.
    const steerText = input.resume?.instruction || input.promptOverride || "";
    const wantsBrowser = needsBrowser(input.spec) || needsBrowser({ objective: steerText });
    // Navegador em SEGUNDO PLANO por padrão (várias tarefas em paralelo não brigam pela tela);
    // "mostrar o navegador dos agentes" em Configurações liga a janela visível.
    const browserVisible = browserVisibleSetting();
    const browserRule = wantsBrowser
      ? (browserVisible
          ? " NAVEGADOR (mcp__playwright__*): você tem um navegador REAL e VISÍVEL na tela, com PERFIL PERSISTENTE (logins ficam salvos entre execuções)."
          : " NAVEGADOR (mcp__playwright__*): você tem um navegador REAL rodando em SEGUNDO PLANO (sem janela — o humano NÃO vê a tela, só os seus screenshots), com PERFIL PERSISTENTE (logins ficam salvos entre execuções).") +
        " Use pra PROVAR o comportamento na UI de verdade — suba o app local desta branch, navegue até a página, clique, preencha e tire SCREENSHOTS salvando em .cardume/artifacts/proof.png (ou proof-<n>.png). NUNCA descreva a tela lendo o código: abra e olhe." +
        (browserVisible
          ? " LOGIN / HUMANO NO MEIO: se a página exigir autenticação (login, 2FA, captcha, um formulário que só o humano tem os dados) — NÃO tente logar nem inventar credenciais. Navegue até a tela, tire um screenshot, e chame mcp__cardume__ask_human dizendo 'abri o navegador na tela X, faça login/preencha e me avise quando terminar' e AGUARDE. O humano usa a MESMA janela pra logar; quando ele responder, continue de onde parou — a sessão dele já estará ativa no navegador. Peça login UMA vez: o perfil persiste, então em rodadas seguintes você provavelmente já estará logado."
          : " LOGIN / HUMANO NO MEIO: se a página exigir autenticação (login, 2FA, captcha, dados que só o humano tem) — NÃO tente logar nem inventar credenciais. Como o navegador está em segundo plano, o humano não consegue usar a janela: tire um screenshot e chame mcp__cardume__ask_human pedindo que ele (1) ligue 'mostrar o navegador dos agentes' em Configurações e (2) responda 'ok'. Quando ele responder, FINALIZE o turno dizendo exatamente o que ficou pendente (a URL da tela de login) — na retomada o navegador abre visível e ele faz o login na sua janela. O perfil persiste: peça login UMA vez.")
      : "";
    const baseline =
      `${adjustRule}Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}${refRule}${envRule}${knowledgeRule}${specGapRule}${scratchRule}${previewRule}${planRule}${prRule}` +
      ` Você tem as tools mcp__cardume__ask_human (pergunte ao humano em caso de dúvida e aguarde) e` +
      ` mcp__cardume__claim (reivindique um caminho antes de editar fora do seu escopo).${askRule}${artifactRule}${reqProofRule}${integrityRule}${groundRule}${doneRule}${parallelRule}${browserRule}`;
    // Modo "resume": continua a sessão existente com uma instrução nova do humano.
    // promptOverride: turno fresco com um pedido específico (ex.: gerar entregável).
    // groundRule/parallelRule valem pra TODO turno (pipeline, chat/resume e
    // entregáveis sob demanda) — sem elas os agentes adivinham e serializam.
    // skillsRule: no resume o system prompt (com as skills ativas) NÃO é reenviado —
    // reinjeta a lista por turno, como groundRule/doneRule. Fresh/promptOverride já a
    // recebem via --append-system-prompt (systemContext), então aqui só o resume precisa.
    const skillsRule = input.skillsRule ?? "";
    const prompt = input.resume
      ? input.resume.instruction + skillsRule + groundRule + doneRule + parallelRule + browserRule
      : (input.promptOverride ? input.promptOverride + groundRule + doneRule + parallelRule + browserRule : baseline);

    // Escreve o mcp.json que injeta o servidor MCP do Cardume neste run.
    // Dev: src/mcp/server.ts ao lado do fonte. App empacotado: o bundle vira
    // Resources/engine/cli.mjs e o server mora em Resources/mcp/server.mjs.
    const serverPath = (() => {
      if (process.env.CARDUME_MCP && existsSync(process.env.CARDUME_MCP)) return process.env.CARDUME_MCP;
      for (const rel of ["../mcp/server.ts", "../mcp/server.mjs"]) {
        const p = fileURLToPath(new URL(rel, import.meta.url));
        if (existsSync(p)) return p;
      }
      return fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
    })();
    const mcpConfigPath = join(input.cwd, ".cardume", "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          cardume: {
            command: process.execPath,
            args: ["--disable-warning=ExperimentalWarning", serverPath],
            env: {
              CARDUME_DB: input.dbFile,
              CARDUME_TASK: input.spec.id,
              CARDUME_ROLE: String(input.role ?? ""), // só o revisor pode marcar o "pronto quando" (check_done_when)
              CARDUME_AGENT: input.agentName,
              CARDUME_ASK_TIMEOUT_MIN: String(input.askTimeoutMin ?? 0),
            },
          },
          // Navegador REAL só em tarefas web/UI — usa o Chrome do sistema (sem baixar
          // Chromium). Em segundo plano por padrão; visível quando ligado em Configurações.
          ...(wantsBrowser
            ? {
                playwright: {
                  command: npxNear(),
                  args: [
                    "-y", "@playwright/mcp@latest",
                    "--browser", "chrome",
                    ...(browserVisible ? [] : ["--headless"]),
                    "--viewport-size", "1280,800",
                    "--output-dir", join(input.cwd, ".cardume", "artifacts"),
                    // perfil PERSISTENTE por repo → você loga UMA vez e a sessão fica
                    // salva; em paralelo, cada tarefa ganha uma cópia própria (ver browserProfileFor)
                    "--user-data-dir", browserProfileFor(input.cwd, input.spec.id),
                  ],
                },
              }
            : {}),
        },
      }),
      "utf8"
    );

    // ROUTE AI: usar a IA alternativa neste turno? (fallback após limite do Claude,
    // ou modo "usar sempre" ligado na config). Se sim, o agente fala com o shim
    // local que traduz Anthropic→OpenAI pro gateway configurado.
    const alt = readAltConfig();
    const useAlt = !!((input.forceAlt || alt?.always) && alt);

    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions", // auto-aprova ações; o humano entra via ask_human
    ];
    if (input.resume?.sessionId) {
      // continua a MESMA sessão (modelo + system prompt já ficam na sessão)
      args.push("--resume", input.resume.sessionId);
    } else {
      // turno normal, ou instrução nova sem sessão capturada (fallback: turno fresco)
      if (input.systemContext) args.push("--append-system-prompt", input.systemContext);
      if (useAlt && alt) args.push("--model", alt.model);
      else if (this.model) args.push("--model", this.model);
    }

    // stdin "ignore": evita o aviso "no stdin data received in 3s".
    // Limpa marcadores de "sessão Claude Code" herdados (ex.: app aberto a
    // partir de um terminal com claude rodando) — senão o CLI recusa "nested".
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    if (useAlt && alt) {
      // ROUTE AI: aponta o agente pro shim local (Anthropic→OpenAI). A chave REAL
      // do gateway vive no shim (lida do cofre); o token aqui é só um placeholder
      // não-vazio pra o Claude Code usar o caminho de API em vez da assinatura.
      const proxyPort = await ensureAltProxy();
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
      env.ANTHROPIC_AUTH_TOKEN = "route-ai";
      env.ANTHROPIC_MODEL = alt.model;
      env.ANTHROPIC_SMALL_FAST_MODEL = alt.model;
      delete env.ANTHROPIC_API_KEY;
    } else {
      // API key no ambiente sobrepõe o login claude.ai: agente passa a COBRAR POR
      // TOKEN na API e perde os connectors. Aqui é sempre a ASSINATURA que paga.
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    const child = spawn(resolveClaude(), args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], env });
    const rl = createInterface({ input: child.stdout });

    const queue: AgentEvent[] = [];
    if (useAlt && alt) queue.push({ type: "note", text: `🔀 Route AI: rodando na ${alt.label} (${alt.model})` });
    let done = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };

    // Timeout de INATIVIDADE (não de relógio): reseta a cada sinal de vida do
    // agente. Assim um agente que trabalha muito (ou espera o humano responder)
    // não é morto — só encerra se ficar realmente parado por N minutos.
    const idleMin = 30;
    let killTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        // bloqueado numa pergunta ao humano → não é inatividade do agente
        if (hasOpenAsk(input.dbFile, input.spec.id)) { resetIdle(); return; }
        queue.push({ type: "error", text: `inatividade de ${idleMin}min — agente encerrado`, status: "error" });
        try {
          child.kill("SIGTERM");
        } catch {
          /* já morreu */
        }
        done = true;
        wake();
      }, idleMin * 60 * 1000);
    };
    resetIdle();

    // guarda o ÚLTIMO motivo de erro visto (stderr ou linha de saída com cara de
    // erro) pra ENRIQUECER o texto da morte — senão "código 1" some o porquê real
    // (ex.: limite de uso) e os detectores de retry/espera não conseguem agir.
    let lastErr = "";
    const CAUSE_RE = /session limit|usage limit|hit your .{0,24}limit|limit reached|rate[ _-]?limit|too many requests|\b429\b|quota|overloaded|resets? (at|\d)|try again later|insufficient|unauthorized|forbidden|\b401\b|\b403\b/i;
    rl.on("line", (line) => {
      resetIdle();
      if (CAUSE_RE.test(line)) lastErr = line.slice(0, 300);
      for (const ev of mapLine(line)) queue.push(ev);
      wake();
    });
    child.stderr.on("data", (d) => {
      resetIdle();
      const s = String(d).trim();
      if (s) { lastErr = s.slice(0, 300); queue.push({ type: "note", text: `stderr: ${s.slice(0, 140)}` }); }
      wake();
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (!queue.some((e) => e.type === "done")) {
        queue.push({
          type: code === 0 ? "note" : "error",
          text: code === 0 ? "claude finalizou" : `claude saiu com código ${code}${lastErr ? " — " + lastErr : ""}`,
          status: code === 0 ? undefined : "error",
        });
      }
      done = true;
      wake();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      queue.push({ type: "error", text: `falha ao iniciar claude: ${err.message}`, status: "error" });
      done = true;
      wake();
    });

    yield { type: "status", text: `iniciando claude (approval: ${this.approval})`, status: "running" };

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          notify = r;
        });
        continue;
      }
      yield queue.shift()!;
    }
  }
}

/** Traduz uma linha NDJSON do stream-json real do Claude Code em AgentEvent[]. */
export function mapLine(line: string): AgentEvent[] {
  const t = line.trim();
  if (!t) return [];
  let o: any;
  try {
    o = JSON.parse(t);
  } catch {
    return [];
  }

  if (o.type === "system") {
    if (o.subtype === "init") {
      const evs: AgentEvent[] = [{ type: "status", text: `sessão iniciada · ${o.model ?? ""} · ${o.permissionMode ?? ""}`.trim(), status: "running" }];
      if (o.session_id) evs.unshift({ type: "session", text: String(o.session_id) });
      return evs;
    }
    if (o.subtype === "post_turn_summary") {
      const st = o.status_category === "review_ready" ? "review" : undefined;
      return [{ type: "note", text: o.status_detail || "turno concluído", status: st }];
    }
    return [];
  }

  if (o.type === "assistant" && o.message?.content) {
    const out: AgentEvent[] = [];
    for (const p of o.message.content) {
      if (p.type === "tool_use") out.push(mapTool(p.name, p.input));
      else if (p.type === "text" && p.text?.trim()) out.push({ type: "think", text: p.text.trim().slice(0, 4000) });
    }
    return out;
  }

  if (o.type === "result") {
    const ok = !o.is_error;
    const usd = typeof o.total_cost_usd === "number" ? o.total_cost_usd : 0;
    const cost = usd ? ` · $${usd.toFixed(3)}` : "";
    const denials = Array.isArray(o.permission_denials) && o.permission_denials.length
      ? ` · ${o.permission_denials.length} permissão(ões) negada(s)`
      : "";
    const u = o.usage || {};
    const inTok = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
    const outTok = Number(u.output_tokens) || 0;
    const ms = Number(o.duration_ms) || 0;
    return [
      {
        type: "done",
        text: (o.result ? String(o.result).slice(0, 4000) : "concluído") + cost + denials,
        status: ok ? "review" : "error",
        ok,
        cost: { usd, inTok, outTok, ms },
      },
    ];
  }

  return [];
}

function mapTool(name: string | undefined, inp: any): AgentEvent {
  const n = (name ?? "").toLowerCase();
  if (n.includes("ask_human")) return { type: "note", text: "❓ perguntou ao humano: " + String(inp?.question ?? "") };
  if (n.includes("claim")) return { type: "claim", text: String(inp?.path ?? ""), path: inp?.path, mode: inp?.mode ?? "write" };
  if (n.includes("edit") || n.includes("str_replace") || n.includes("notebook")) return { type: "edit", text: fileOf(inp), ok: true };
  if (n.includes("write") || n.includes("create")) return { type: "write", text: fileOf(inp), ok: true };
  if (n.includes("read") || n.includes("grep") || n.includes("glob")) return { type: "read", text: fileOf(inp) || String(inp?.pattern ?? "") };
  if (n.includes("bash") || n.includes("shell")) return { type: "bash", text: String(inp?.command ?? "").slice(0, 120) };
  if (n.includes("task")) return { type: "note", text: "subagente: " + String(inp?.description ?? "") };
  if (n.includes("todo")) return { type: "note", text: "atualizou o plano" };
  return { type: "note", text: name ?? "tool" };
}

function fileOf(inp: any): string {
  return String(inp?.file_path ?? inp?.path ?? inp?.filename ?? "");
}

/**
 * Tarefa SOB ÉPICO no papel PLANNER (CAP-5, refinamento tardio): os critérios de aceite nascem aqui, dos
 * requisitos do épico que a tarefa cobre (EPIC.md) e do `verify` da tarefa — não vieram prontos do card.
 * Tarefa comum, ou de épico no formato antigo (sem verify/covers), segue o fluxo de sempre.
 */
function epicPlanRule(input: { role: string; spec: { epicId?: string; verify?: string; covers?: string[]; refs?: string[] } }): string {
  if (input.role !== "planner" || !input.spec.epicId || !(input.spec.verify || input.spec.covers?.length)) return "";
  const hasEpicMd = (input.spec.refs ?? []).some((r) => /^EPIC\.md$/i.test(r));
  return (
    ` TAREFA DE ÉPICO — CRITÉRIOS DE ACEITE NASCEM AGORA: leia ${hasEpicMd ? ".cardume/refs/EPIC.md e " : ""}o bloco \`epic:\` do TASK.yaml.` +
    ` Derive de 2 a 5 critérios de aceite VERIFICÁVEIS a partir dos requisitos do épico que esta tarefa cobre (${(input.spec.covers ?? []).join(", ") || "os citados em covers"}) e da prova da tarefa (verify: "${input.spec.verify ?? ""}").` +
    " Cada critério cita o requisito (ex.: 'R2: …') e diz como alguém checa; NUNCA enfraqueça o verify — ele é o mínimo. Registre CADA critério com mcp__cardume__add_requirement (só os que ainda não estão no TASK.yaml), e liste-os no PLAN.md numa seção 'Critérios de aceite'." +
    " Não escreva Dado/Quando/Então completo: isso é só pra bug, tarefa sem épico ou marcada refine."
  );
}
