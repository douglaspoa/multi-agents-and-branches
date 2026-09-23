// Servidor MCP (stdio, JSON-RPC 2.0) hospedado pelo Cardume e injetado no
// Claude Code via --mcp-config. Expõe:
//   ask_human(question, options?) — pergunta ao humano; BLOQUEIA até a UI responder.
//   claim(path, mode)             — reivindica um caminho no barramento.
//
// Só escreve JSON-RPC no stdout; qualquer log vai pro stderr.
import type { TaskSpec } from "../types.ts";
import { createInterface } from "node:readline";
import { Store } from "../store.ts";
import { CoordinationBus } from "../bus.ts";
import { notify } from "../util/notify.ts";

const DB = process.env.CARDUME_DB;
const TASK = process.env.CARDUME_TASK ?? "";
const AGENT = process.env.CARDUME_AGENT ?? "agente";
const ROLE = process.env.CARDUME_ROLE ?? ""; // builder | planner | reviewer | … (vazio em motor antigo)

if (!DB) {
  process.stderr.write("cardume-mcp: falta CARDUME_DB\n");
  process.exit(1);
}

const store = new Store(DB);
const bus = new CoordinationBus(store);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TOOLS = [
  {
    name: "ask_human",
    description:
      "Pergunte ao humano quando houver ambiguidade sobre requisitos ou uma decisão que precise de aprovação. BLOQUEIA até o humano responder na UI do Cardume. Use apenas quando realmente necessário.",
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

async function callTool(name: string, args: any): Promise<{ text: string; isError?: boolean }> {
  if (name === "ask_human") {
    const question = String(args?.question ?? "").trim();
    const options: string[] | undefined = Array.isArray(args?.options) ? args.options : undefined;
    if (!question) return { text: "pergunta vazia", isError: true };
    const id = store.addPending(TASK, AGENT, "question", question, options);
    store.addEvent(TASK, AGENT, "note", `perguntou ao humano: ${question}`, undefined);
    notify("Cardume", question, `${AGENT} precisa de você`);
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
      store.addEvent(TASK, AGENT, "note", `📦 entregável novo registrado: ${item.slice(0, 120)}`, true);
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
      store.addEvent(TASK, AGENT, "note", `🔗 issue registrada: ${url}`, true);
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
      store.addEvent(TASK, AGENT, "note", `☑ pronto quando ${id} — ${evidence}`, true);
      return { text: `${id} marcado como provado (${evidence}). O app espelha no épico do time.` };
    } catch (e) {
      return { text: `falha marcando o item: ${(e as Error).message}`, isError: true };
    }
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

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const t = line.trim();
  if (!t) return;
  let req: any;
  try {
    req = JSON.parse(t);
  } catch {
    return;
  }
  const { id, method, params } = req;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cardume", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return; // notificações não têm resposta
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const res = await callTool(params?.name, params?.arguments ?? {});
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: res.text }], isError: !!res.isError },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `método não suportado: ${method}` } });
  }
});

// Quando o Claude Code encerra (fim do turno ou timeout do engine), o stdin
// fecha — encerramos o servidor para não vazar o processo poll de ask_human.
rl.on("close", () => {
  try { store.close(); } catch { /* ok */ }
  process.exit(0);
});
