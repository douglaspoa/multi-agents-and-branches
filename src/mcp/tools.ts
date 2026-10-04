// Ferramentas do Starfork (MCP cardume) — a MESMA lógica serve ao servidor MCP (src/mcp/server.ts, stdio) e ao
// comando `starfork …` do terminal integrado (src/starfork-cli.ts), pra qualquer IA: o contexto (banco, tarefa,
// agente, papel) entra por parâmetro em vez de vir das globais do processo.
import type { TaskSpec } from "../types.ts";
import { Store } from "../store.ts";
import { CoordinationBus } from "../bus.ts";
import { notify } from "../util/notify.ts";
import type { Orchestrator } from "../orchestrator.ts";
import { dirname } from "node:path";
import { editEpic, editTask, type EditAuthor } from "../agent-edits.ts";
import { ensureFreshContext, epicTasksText, knownEpics, listEpicTasks, resolveEditTarget, resolveEpicTarget } from "../epic-context.ts";

/** Quem chama a ferramenta: banco/tarefa/agente/papel (o servidor lê do env; o CLI também) + orquestrador sob demanda. */
export interface ToolCtx { store: Store; db: string; task: string; agent: string; role: string; bus?: CoordinationBus; orch: () => Promise<Orchestrator> }
export type ToolResult = { text: string; isError?: boolean };
/** Contexto a partir do ambiente (CARDUME_DB/TASK/AGENT/ROLE). O orquestrador só abre o 2º acesso ao banco se precisar. */
export function ctxFromEnv(env: NodeJS.ProcessEnv = process.env): ToolCtx & { close: () => void } {
  const db = env.CARDUME_DB ?? "";
  if (!db) throw new Error("falta CARDUME_DB");
  const store = new Store(db);
  let o: Orchestrator | null = null;
  const repo = dirname(dirname(db));
  return {
    store, db, task: env.CARDUME_TASK ?? "", agent: env.CARDUME_AGENT ?? "agente", role: env.CARDUME_ROLE ?? "",
    orch: async () => (o ??= new (await import("../orchestrator.ts")).Orchestrator(repo)),
    close: () => { try { store.close(); } catch { /* ok */ } try { o?.close(); } catch { /* ok */ } },
  };
}

/** Resposta do ask_human no piloto automático (sem humano, CARDUME_AUTOPILOT=1). Não é exportada: o teste
 * (src/autopilot.test.ts) chama o servidor de verdade e confere o texto devolvido. */
export const AUTOPILOT_ANSWER =
  "PILOTO AUTOMÁTICO — não há humano para responder. Decida você mesmo seguindo o objetivo da tarefa e o .cardume/refs/EPIC.md " +
  "(na dúvida, a opção mais simples que entrega o \"pronto quando\"). Registre a suposição em .cardume/artifacts/ASSUMPTIONS.md " +
  "(uma linha: a pergunta → o que você decidiu e por quê) e siga sem perguntar de novo. Se a pergunta era se pode finalizar: sim, finalize. " +
  "Se algo é IMPOSSÍVEL nesta máquina (ex.: falta o simulador), marque o requisito como \"blocked\" no requirements.json com o motivo exato e finalize.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const TOOLS = [
  {
    name: "ask_human",
    description:
      "Pergunte ao humano quando houver ambiguidade sobre requisitos ou uma decisão que precise de aprovação. BLOQUEIA até o humano responder na UI do Starfork. Use apenas quando realmente necessário.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "A pergunta, clara e específica." },
        options: { type: "array", items: { type: "string" }, description: "Opções de resposta (opcional)." },
      },
      required: ["question"],
    },
  },
  {
    name: "add_deliverable",
    description:
      "Registre um ENTREGÁVEL NOVO quando o humano pedir no chat algo que ainda não fazia parte da tarefa (não use para correções/ajustes do que já existe). O item entra na lista de entregáveis e será cobrado na finalização.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "O entregável, curto e verificável (ex.: 'Filtro de data no dashboard de vendas')." },
      },
      required: ["item"],
    },
  },
  {
    name: "add_requirement",
    description:
      "Registre um REQUISITO NOVO quando o humano pedir na conversa um critério/condição que ainda não está no TASK.yaml. Ele entra na checklist oficial (contador X/Y da UI) e será cobrado com prova na finalização. Use junto com add_deliverable quando o pedido também for uma entrega.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "O requisito, curto e VERIFICÁVEL (ex.: 'Filtro persiste após reload')." },
      },
      required: ["item"],
    },
  },
  {
    name: "map_requirement",
    description:
      "Registre, para UM requisito do TASK.yaml, O QUE você fez e QUAIS TRECHOS de código mudou por ele (arquivo + faixa de linhas no arquivo NOVO) e os testes que o cobrem. A Revisão do Starfork mostra ao humano só esses trechos por requisito; o que você mudou e não estiver em nenhum requisito aparece como \"fora dos requisitos\". Grava em .cardume/artifacts/requirements.json (campos did/code/tests) sem mexer no status nem na evidência da prova. Chame de novo quando os trechos mudarem — substitui o mapa daquele requisito.",
    inputSchema: {
      type: "object",
      properties: {
        req: { type: "string", description: "TEXTO EXATO do requisito, copiado do TASK.yaml." },
        did: { type: "string", description: "O que você fez por este requisito, em 1-2 frases (aparece como 'o que o agente diz que fez')." },
        code: { type: "array", items: { type: "object", properties: { file: { type: "string", description: "caminho relativo ao repo" }, lines: { type: "string", description: "faixa no arquivo novo, ex.: '12-30' (vazio = o arquivo inteiro)" } }, required: ["file"] }, description: "Trechos mudados POR ESTE requisito." },
        tests: { type: "array", items: { type: "object", properties: { name: { type: "string", description: "arquivo › caso de teste" }, status: { type: "string", enum: ["pass", "fail", "missing"] } }, required: ["name", "status"] }, description: "Testes que cobrem o requisito ('missing' = falta teste)." },
      },
      required: ["req", "code"],
    },
  },
  {
    name: "set_issue",
    description:
      "Registre o LINK da issue desta demanda no tracker do projeto. Use quando o projeto tem 'criar issue ao abrir demanda' ligado E o TASK.yaml ainda NÃO traz issueUrl: crie a issue seguindo as INSTRUÇÕES DE ISSUE do projeto (título/corpo a partir do TASK.yaml) e chame esta tool com a URL resultante. O link fica na tarefa e é compartilhado com o time. Se o TASK.yaml já trouxer issueUrl, NÃO crie outra nem chame esta tool.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL completa da issue criada (ex.: https://github.com/org/repo/issues/123)." },
      },
      required: ["url"],
    },
  },
  {
    name: "check_done_when",
    description:
      "SÓ PARA O PAPEL REVISOR, e só quando a tarefa pertence a um ÉPICO (bloco `epic:` no TASK.yaml, com `done_when`). Marque UM item do 'pronto quando' do épico que a sua revisão PROVOU (a evidência tem que ser algo que você viu: teste rodado, tela, comando). O app espelha a marca no épico do time e, se era o último item, fecha o épico. NUNCA marque por suposição; item que a tarefa só ajuda mas não prova fica pra quem revisar o restante.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id do item em `epic.done_when` do TASK.yaml (ex.: 'D2')." },
        evidence: { type: "string", description: "O que prova o item, em 1 frase concreta (ex.: 'suíte e2e cart-total passou em CI #412')." },
      },
      required: ["id", "evidence"],
    },
  },
  {
    name: "edit_task",
    description:
      "Atualize a SPEC de uma tarefa do projeto quando a ideia mudou conforme você programa — tipicamente uma tarefa IRMÃ do seu épico (ids em .cardume/refs/EPIC.md) ou um rascunho; também serve pra própria tarefa. Muda objetivo/título/requisitos/entregáveis/escopo SEM iniciar, retomar nem conversar com o agente dela (NÃO use talk pra isso). Se ela estiver rodando, a mudança chega ao agente dela no PRÓXIMO turno, sem interromper. Acrescentar/reescrever vale na hora; REMOVER requisito ou estreitar owns/off vira PROPOSTA que o humano aprova. Tarefa mergeada/concluída não muda; o papel revisor não edita. Sempre diga o porquê em `note` — o humano vê o rastro e pode desfazer.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Id da tarefa (da nuvem ou local — veja com epic_tasks) OU o título dela. Alvo desconhecido/ambíguo é recusado com a lista das irmãs." },
        objective: { type: "string", description: "Objetivo novo (substitui)." },
        title: { type: "string", description: "Título novo (substitui)." },
        requirements_add: { type: "array", items: { type: "string" }, description: "Requisitos a ACRESCENTAR (curtos e verificáveis)." },
        requirements_remove: { type: "array", items: { type: "string" }, description: "TEXTO exato dos requisitos a remover — vira PROPOSTA que o humano aprova ou recusa (até lá o requisito vale)." },
        deliverables: { type: "array", items: { type: "string" }, description: "Lista NOVA de entregáveis (substitui a atual)." },
        deliverables_add: { type: "array", items: { type: "string" }, description: "Entregáveis a ACRESCENTAR." },
        owns: { type: "array", items: { type: "string" }, description: "Escopo desejado (caminhos/globs): o que entra vale na hora; o que sai vira proposta." },
        off: { type: "array", items: { type: "string" }, description: "Caminhos proibidos desejados: o que entra vale na hora; o que sai vira proposta." },
        note: { type: "string", description: "POR QUE mudou (1 frase). Obrigatório." },
      },
      required: ["task_id", "note"],
    },
  },
  {
    name: "edit_epic",
    description:
      "Atualize o ÉPICO desta tarefa (id em epic.id no TASK.yaml) quando a ideia mudou: descrição, outcome, requisitos novos e o 'pronto quando' (acrescentar/remover itens). Não aciona nenhum agente. O app aplica no épico do time e guarda no histórico com o seu motivo; a cópia do 'pronto quando' no TASK.yaml das tarefas deste computador ganha os itens novos na hora. Remover item do 'pronto quando' vira PROPOSTA. O papel revisor não edita. Sempre diga o porquê em `note`.",
    inputSchema: {
      type: "object",
      properties: {
        epic_id: { type: "string", description: "Id do épico (epic.id no TASK.yaml) ou o nome dele. Vazio = o épico desta tarefa." },
        description: { type: "string", description: "Descrição nova (substitui)." },
        outcome: { type: "string", description: "Resultado esperado novo (substitui)." },
        done_when_add: { type: "array", items: { type: "string" }, description: "Itens NOVOS do 'pronto quando' (checagem que uma pessoa roda)." },
        done_when_remove: { type: "array", items: { type: "string" }, description: "Ids (ex.: 'D3') do 'pronto quando' a remover — vira PROPOSTA pra quem cuida do épico; item já marcado não sai." },
        requirements_add: { type: "array", items: { type: "string" }, description: "Requisitos NOVOS do épico." },
        note: { type: "string", description: "POR QUE mudou (1 frase). Obrigatório." },
      },
      required: ["note"],
    },
  },
  {
    name: "epic_tasks",
    description:
      "Lista as tarefas do ÉPICO (irmãs) AO VIVO: id (passe esse pro edit_task), título, status, se está neste computador ou só na nuvem, e os requisitos. Use antes de editar uma irmã — ou passe o título direto pro edit_task.",
    inputSchema: {
      type: "object",
      properties: { epic_id: { type: "string", description: "Id ou nome do épico. Vazio = o épico desta tarefa." } },
    },
  },
  {
    name: "suggest_replies",
    description:
      "No FIM de todo turno em que você para esperando o humano, sugira de 2 a 4 respostas CURTAS (até 60 caracteres) e concretas que ele provavelmente mandaria a seguir (ex.: \"pode seguir\", \"mostra o diff\", \"abre o PR\"). O app mostra como botões que mandam o texto pro terminal. Não substitui a sua resposta: chame depois de responder.",
    inputSchema: {
      type: "object",
      properties: { options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4, description: "2 a 4 respostas curtas, na voz do humano." } },
      required: ["options"],
    },
  },
  {
    name: "task_status",
    description:
      "Status da TAREFA no Starfork: título, status/etapa, cada requisito com o estado da prova (provado / sem evidência / pendente / adiado / bloqueado), entregáveis, arquivos em .cardume/artifacts, PR e o que falta pra ficar PROVADA e ENTREGUE. Use quando o humano perguntar o status/o que falta, e antes de set_status review ou open_pr. Não roda a suíte de testes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_status",
    description:
      "Muda o status da tarefa no Starfork quando o humano pedir na conversa (ou ao terminar): \"review\" = pronta pra revisar/provar (a resposta traz o que ainda falta provar); \"needs-you\" = parada esperando uma decisão do humano; \"running\" = voltou a construir. Não vale em tarefa integrada/cancelada. Diga o porquê em `note`.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["review", "needs-you", "running"] },
        note: { type: "string", description: "Por que (1 frase) — aparece no feed da tarefa." },
      },
      required: ["status", "note"],
    },
  },
  {
    name: "list_skills",
    description: "Lista as skills disponíveis: primeiro as ATIVAS deste projeto, depois as outras do projeto e as pessoais — nome, descrição e origem. Depois use use_skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "use_skill",
    description: "Carrega uma skill (SKILL.md, sem o cabeçalho) pelo nome pra você seguir as instruções dela nesta tarefa. Nome desconhecido → erro com as disponíveis.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Nome da skill (veja list_skills)." } }, required: ["name"] },
  },
  {
    name: "create_task",
    description:
      "Cria uma tarefa NOVA no mesmo projeto do Starfork (quando o humano pedir uma tarefa nova ou pra quebrar esta). Nasce SEMPRE como RASCUNHO (o humano inicia pelo quadro — tarefa custa) e no mesmo épico desta (same_epic=true), com a mesma equipe/motor. Devolve o id. Não use pra mudar ESTA tarefa (isso é add_requirement/edit_task).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Título curto." },
        objective: { type: "string", description: "Objetivo em 1-2 frases." },
        requirements: { type: "array", items: { type: "string" }, description: "Requisitos curtos e VERIFICÁVEIS." },
        deliverables: { type: "array", items: { type: "string" } },
        same_epic: { type: "boolean", default: true },
      },
      required: ["title", "objective"],
    },
  },
  {
    name: "open_pr",
    description:
      "Abre o PR DESTA tarefa: confere o gate (todo requisito provado com evidência real + testes), commita o que estiver solto, faz push da branch e roda gh pr create. Com prova faltando ele RECUSA e diz o que falta — a não ser draft=true (rascunho). PR já aberto pra branch → devolve a URL dele. Use quando o humano pedir pra abrir o PR.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Título do PR (padrão: título da tarefa)." },
        body: { type: "string", description: "Descrição (o relatório de provas do Starfork é anexado depois)." },
        draft: { type: "boolean", default: false, description: "Abre como rascunho, sem exigir as provas." },
      },
    },
  },
  {
    name: "claim",
    description:
      "Reivindique um caminho antes de editá-lo, para não colidir com outros agentes. Retorna se você tem a posse (write) ou se cedeu a vez (read).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["read", "write"], default: "write" },
      },
      required: ["path"],
    },
  },
];

export async function callTool(ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const { store, task: TASK, agent: AGENT, role: ROLE, db: DB, orch } = ctx;
  const REPO = dirname(dirname(DB));
  const bus = (ctx.bus ??= new CoordinationBus(store));
  if (name === "ask_human") {
    const question = String(args?.question ?? "").trim();
    const options: string[] | undefined = Array.isArray(args?.options) ? args.options : undefined;
    if (!question) return { text: "pergunta vazia", isError: true };
    // PILOTO AUTOMÁTICO: não há humano — responde NA HORA mandando a IA decidir e registrar a suposição
    // (src/autopilot.ts liga CARDUME_AUTOPILOT=1; nada de notificação nem espera)
    if (process.env.CARDUME_AUTOPILOT === "1") {
      const id = store.addPending(TASK, AGENT, "question", question, options);
      store.answerPending(id, AUTOPILOT_ANSWER);
      store.addEvent(TASK, AGENT, "note", `perguntou (piloto automático, sem humano): ${question}`, undefined);
      store.addEvent(TASK, "Piloto automático", "note", `resposta automática: decida e registre a suposição em .cardume/artifacts/ASSUMPTIONS.md`, true);
      return { text: AUTOPILOT_ANSWER };
    }
    const id = store.addPending(TASK, AGENT, "question", question, options);
    store.addEvent(TASK, AGENT, "note", `perguntou ao humano: ${question}`, undefined);
    notify("Starfork", question, `${AGENT} precisa de você`);
    // Bloqueia até a UI responder (poll no SQLite).
    // CARDUME_ASK_TIMEOUT_MIN > 0 → janela de INATIVIDADE (usada no chat): sem
    // resposta em N min, encerra EDUCADAMENTE (não é erro). 0/ausente → espera
    // PRA SEMPRE (perguntas do pipeline aguardam o humano o tempo que for).
    const idleMin = Number(process.env.CARDUME_ASK_TIMEOUT_MIN || "0");
    const deadline = idleMin > 0 ? Date.now() + idleMin * 60 * 1000 : Number.POSITIVE_INFINITY;
    while (Date.now() < deadline) {
      const p = store.getPending(id);
      if (p && p.status === "answered") {
        store.addEvent(TASK, AGENT, "note", `humano respondeu: ${p.answer ?? ""}`, true);
        return { text: p.answer ?? "" };
      }
      await sleep(400);
    }
    // inatividade: limpa a pergunta na UI e manda o agente fechar com resumo
    store.answerPending(id, "(sem resposta — inatividade)");
    store.addEvent(TASK, AGENT, "note", `sem resposta do humano há ${idleMin}min — encerrando o turno com resumo`, true);
    return {
      text: `(O humano está inativo há ${idleMin} minutos. ENCERRE o turno AGORA de forma educada: resuma em poucas linhas o que foi feito e o que ficou pendente. NÃO invente uma resposta para a pergunta e NÃO tome a decisão que dependia dele.)`,
    };
  }

  if (name === "add_deliverable") {
    const item = String(args?.item ?? "").trim();
    if (!item) return { text: "entregável vazio", isError: true };
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    try {
      const spec = JSON.parse(task.spec_json);
      spec.deliverables = [...(spec.deliverables ?? []), item];
      store.updateSpec(TASK, JSON.stringify(spec));
      // TASK.yaml da worktree acompanha (o agente relê dali)
      try {
        const { taskToYaml } = await import("../util/yaml.ts");
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      } catch { /* worktree pode não existir */ }
      store.addEvent(TASK, AGENT, "note", `entregável novo registrado: ${item.slice(0, 120)}`, true);
      return { text: `entregável registrado: ${item}` };
    } catch (e) {
      return { text: `falha registrando entregável: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "add_requirement") {
    const item = String(args?.item ?? "").trim();
    if (!item) return { text: "requisito vazio", isError: true };
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    try {
      const spec = JSON.parse(task.spec_json);
      const norm = (x: string) => String(x).trim().toLowerCase().replace(/\s+/g, " ");
      if ((spec.requirements ?? []).some((r: string) => norm(r) === norm(item))) return { text: `requisito já está na checklist: ${item}` };
      spec.requirements = [...(spec.requirements ?? []), item];
      store.updateSpec(TASK, JSON.stringify(spec));
      try {
        const { taskToYaml } = await import("../util/yaml.ts");
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      } catch { /* worktree pode não existir */ }
      store.addEvent(TASK, AGENT, "note", `requisito adicionado: ${item.slice(0, 120)}`, true);
      return { text: `requisito registrado (${spec.requirements.length} na checklist): ${item}` };
    } catch (e) {
      return { text: `falha registrando requisito: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "map_requirement") {
    const req = String(args?.req ?? "").trim();
    if (!req) return { text: "req vazio — copie o texto exato do requisito do TASK.yaml", isError: true };
    if (!Array.isArray(args?.code)) return { text: "code precisa ser uma lista de { file, lines }", isError: true };
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    try {
      const { mergeReqMap, norm } = await import("../req-map.ts");
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(task.worktree, ".cardume", "artifacts"), file = join(dir, "requirements.json");
      const known = (() => { try { return ((JSON.parse(task.spec_json) as TaskSpec).requirements ?? []).map(String); } catch { return []; } })();
      // requisito que não existe NÃO entra no arquivo (viraria um "pending" eterno no portão das provas)
      if (known.length && !known.some((k) => norm(k) === norm(req))) return { text: `"${req.slice(0, 80)}" não é um requisito desta tarefa. Copie o texto exato de um destes: ${known.map((k) => `"${k}"`).join("; ")}`, isError: true };
      let raw: string | null = null;
      try { raw = await readFile(file, "utf8"); } catch { /* ainda não existe: começa vazio */ }
      let cur: unknown = [];
      if (raw != null && raw.trim()) {
        try { cur = JSON.parse(raw); } catch { return { text: "o .cardume/artifacts/requirements.json está com JSON inválido — corrija o arquivo antes (não sobrescrevi pra não apagar as provas)", isError: true }; }
      }
      const wrapped = !Array.isArray(cur) && cur && typeof cur === "object" && Array.isArray((cur as { list?: unknown }).list);
      const { list, entry } = mergeReqMap(wrapped ? (cur as { list: unknown }).list : cur, { req, did: args?.did, code: args.code, tests: args?.tests });
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(wrapped ? { ...(cur as object), list } : list, null, 2), "utf8");
      return { text: `mapa registrado: ${entry.code?.length ?? 0} trecho(s), ${entry.tests?.length ?? 0} teste(s) para "${req.slice(0, 80)}".` };
    } catch (e) {
      return { text: `falha registrando o mapa: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "set_issue") {
    const url = String(args?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return { text: "url de issue inválida (precisa começar com http/https)", isError: true };
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    try {
      const spec = JSON.parse(task.spec_json);
      spec.issueUrl = url;
      store.updateSpec(TASK, JSON.stringify(spec));
      // TASK.yaml da worktree acompanha (o agente relê dali e não recria)
      try {
        const { taskToYaml } = await import("../util/yaml.ts");
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      } catch { /* worktree pode não existir */ }
      store.addEvent(TASK, AGENT, "note", `issue registrada: ${url}`, true);
      return { text: `issue registrada e compartilhada com o time: ${url}` };
    } catch (e) {
      return { text: `falha registrando issue: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "check_done_when") {
    const id = String(args?.id ?? "").trim().toUpperCase();
    const evidence = String(args?.evidence ?? "").trim().slice(0, 300);
    if (ROLE && ROLE !== "reviewer") return { text: `só o papel revisor marca o "pronto quando" (você é ${ROLE}) — deixe a prova pra revisão`, isError: true };
    if (!/^D\d+$/.test(id)) return { text: "id inválido — use o id do item em epic.done_when (ex.: 'D2')", isError: true };
    if (evidence.length < 8) return { text: "evidência curta demais — diga o que você viu (teste, tela, comando)", isError: true };
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    try {
      const spec = JSON.parse(task.spec_json) as TaskSpec;
      if (!spec.epicId) return { text: "esta tarefa não pertence a um épico — nada a marcar", isError: true };
      const known = (spec.epicDoneWhen ?? []).map((d) => String(d).split(":")[0].trim().toUpperCase());
      if (!known.length) return { text: "esta tarefa não trouxe o \"pronto quando\" do épico (epic.done_when vazio) — nada a marcar por aqui", isError: true };
      if (!known.includes(id)) return { text: `o épico não tem o item ${id}; os itens são ${known.join(", ")}`, isError: true };
      const checks = (spec.epicChecks ?? []).filter((c) => c.id !== id);
      checks.push({ id, evidence, at: new Date().toISOString() });
      spec.epicChecks = checks;
      store.updateSpec(TASK, JSON.stringify(spec));
      try {
        const { taskToYaml } = await import("../util/yaml.ts");
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await writeFile(join(task.worktree, ".cardume", "TASK.yaml"), taskToYaml(spec), "utf8");
      } catch { /* worktree pode não existir */ }
      store.addEvent(TASK, AGENT, "note", `pronto quando ${id} — ${evidence}`, true);
      return { text: `${id} marcado como provado (${evidence}). O app espelha no épico do time.` };
    } catch (e) {
      return { text: `falha marcando o item: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "epic_tasks") {
    const me = store.getTask(TASK);
    let myEpic: string | undefined;
    try { myEpic = me ? (JSON.parse(me.spec_json) as TaskSpec).epicId : undefined; } catch { /* spec antiga */ }
    const cardumeDir = dirname(DB!);
    const e = resolveEpicTarget(typeof args?.epic_id === "string" ? args.epic_id : undefined, knownEpics(store, cardumeDir), myEpic);
    if (!e.ok) return { text: e.message, isError: true };
    const f = await ensureFreshContext(cardumeDir, e.id);
    return { text: epicTasksText(f.ctx, listEpicTasks(store, f.ctx, e.id), e.id, f.warn) };
  }

  if (name === "edit_task" || name === "edit_epic") {
    const me = store.getTask(TASK);
    let myEpic: string | undefined;
    try { myEpic = me ? (JSON.parse(me.spec_json) as TaskSpec).epicId : undefined; } catch { /* spec antiga */ }
    const by: EditAuthor = { agent: AGENT, taskId: TASK || undefined, taskTitle: me?.title, role: ROLE || undefined };
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const cardumeDir = dirname(DB!);
      let target = { id: "", cloud: false, warn: undefined as string | undefined };
      let epicTarget = "";
      if (name === "edit_task") {
        const t = await resolveEditTarget({ store, cardumeDir, query: String(args?.task_id ?? ""), epicId: myEpic });
        if (!t.ok) return { text: t.message, isError: true };
        target = { id: t.id, cloud: t.cloud, warn: t.warn };
      } else {
        const e = resolveEpicTarget(str(args?.epic_id), knownEpics(store, cardumeDir), myEpic);
        if (!e.ok) return { text: e.message, isError: true };
        epicTarget = e.id;
      }
      const r = name === "edit_task"
        ? editTask({
            store, cardumeDir, targetId: target.id, by, epicId: myEpic, knownCloud: target.cloud,
            input: {
              objective: str(args?.objective), title: str(args?.title), reqAdd: arr(args?.requirements_add),
              reqRemove: arr(args?.requirements_remove),
              deliverables: arr(args?.deliverables), delivAdd: arr(args?.deliverables_add), owns: arr(args?.owns), off: arr(args?.off), note: str(args?.note),
            },
          })
        : editEpic({
            store, cardumeDir, epicId: epicTarget, by,
            input: {
              description: str(args?.description), outcome: str(args?.outcome), doneWhenAdd: arr(args?.done_when_add),
              doneWhenRemove: arr(args?.done_when_remove), reqAdd: arr(args?.requirements_add), note: str(args?.note),
            },
          });
      return { text: r.message + (r.ok && target.warn ? ` (aviso: ${target.warn})` : ""), isError: !r.ok };
    } catch (e) {
      return { text: `falha editando: ${(e as Error).message}`, isError: true };
    }
  }

  if (name === "suggest_replies") {
    const { cleanSuggestions } = await import("../terminal-integrado.ts");
    const r = cleanSuggestions(args?.options);
    if (!r.ok) return { text: r.error, isError: true };
    if (!store.getTask(TASK)) return { text: "tarefa não encontrada", isError: true };
    store.addEvent(TASK, AGENT, "suggest", JSON.stringify(r.options), true, ROLE || undefined);
    return { text: `sugestões mostradas ao humano: ${r.options.join(" | ")}` };
  }

  if (name === "task_status") {
    const { taskStatus } = await import("../terminal-integrado.ts");
    return { text: (await taskStatus(await orch(), TASK)).text };
  }

  if (name === "set_status") {
    const { canSetStatus, taskStatus, STATUS_PT } = await import("../terminal-integrado.ts");
    const status = String(args?.status ?? "").trim();
    const note = String(args?.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const task = store.getTask(TASK);
    if (!task) return { text: "tarefa não encontrada", isError: true };
    const err = canSetStatus(task.status, status);
    if (err) return { text: err, isError: true };
    if (status === "review") store.releaseClaims(TASK);
    store.setStatus(TASK, status as never);
    store.addEvent(TASK, AGENT, "status", `${STATUS_PT[status] ?? status}${note ? ` — ${note}` : ""}`, true, ROLE || undefined);
    if (status === "needs-you") notify("Starfork", note || "o agente está esperando você", `${AGENT} precisa de você`);
    if (status !== "review") return { text: `status: ${STATUS_PT[status] ?? status}` };
    const st = await taskStatus(await orch(), TASK);
    return { text: `status: pronta pra revisão.\n${st.provado ? "Tudo provado ✓ — dá pra abrir o PR (open_pr)." : `Ainda falta para PROVADO:\n${st.faltaProvar.map((x) => `  - ${x}`).join("\n")}`}` };
  }

  if (name === "list_skills" || name === "use_skill") {
    const { listSkills, readSkill, skillsText } = await import("../terminal-integrado.ts");
    const wt = store.getTask(TASK)?.worktree;
    if (name === "list_skills") return { text: skillsText(listSkills(REPO, wt)) };
    const r = readSkill(String(args?.name ?? ""), REPO, wt);
    if (!r.ok) return { text: r.error, isError: true };
    store.addEvent(TASK, AGENT, "note", `usou a skill ${r.skill.name}`, true, ROLE || undefined);
    return { text: `# Skill ${r.skill.name} (${r.skill.origin})\nArquivos de apoio (se o texto citar): ${r.skill.dir}\n\n${r.body}` };
  }

  if (name === "create_task") {
    const { createChildTask } = await import("../terminal-integrado.ts");
    const r = await createChildTask(await orch(), TASK, {
      title: String(args?.title ?? ""), objective: typeof args?.objective === "string" ? args.objective : undefined,
      requirements: Array.isArray(args?.requirements) ? args.requirements : undefined, deliverables: Array.isArray(args?.deliverables) ? args.deliverables : undefined,
      same_epic: args?.same_epic !== false,
    }, AGENT);
    store.addEvent(TASK, AGENT, "note", `criou a tarefa "${r.title}" (${r.id})`, true, ROLE || undefined);
    return { text: `tarefa criada: ${r.id} — "${r.title}" · ${r.note}` };
  }

  if (name === "open_pr") {
    const o = await orch();
    const r = await o.openPr(TASK, { draft: args?.draft === true, title: typeof args?.title === "string" ? args.title : undefined, body: typeof args?.body === "string" ? args.body : undefined });
    if (r.ok) return { text: `PR${args?.draft === true ? " (rascunho)" : ""}: ${r.url}` };
    if (r.reasons?.length) return { text: `PR NÃO aberto — o gate das provas reprovou:\n${r.reasons.map((x) => `  - ${x}`).join("\n")}\nProve o que falta (requirements.json + evidência) ou, se o humano pediu, abra como rascunho (draft=true).`, isError: true };
    return { text: `falha ao abrir o PR: ${r.error ?? "erro desconhecido"}`, isError: true };
  }

  if (name === "claim") {
    const path = String(args?.path ?? "");
    const mode = args?.mode === "read" ? "read" : "write";
    if (!path) return { text: "path vazio", isError: true };
    const r = bus.claim(TASK, AGENT, path, mode);
    return {
      text: r.ok
        ? `posse concedida (${r.grantedMode}) de ${path}`
        : `${path} já é de ${r.conflictWith}; você ficou com ${r.grantedMode} — reutilize a mudança dele.`,
    };
  }

  return { text: `tool desconhecida: ${name}`, isError: true };
}
