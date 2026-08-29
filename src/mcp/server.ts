// Servidor MCP (stdio, JSON-RPC 2.0) hospedado pelo Cardume e injetado no
// Claude Code via --mcp-config. Expõe:
//   ask_human(question, options?) — pergunta ao humano; BLOQUEIA até a UI responder.
//   claim(path, mode)             — reivindica um caminho no barramento.
//
// Só escreve JSON-RPC no stdout; qualquer log vai pro stderr.
import { createInterface } from "node:readline";
import { Store } from "../store.ts";
import { CoordinationBus } from "../bus.ts";
import { notify } from "../util/notify.ts";

const DB = process.env.CARDUME_DB;
const TASK = process.env.CARDUME_TASK ?? "";
const AGENT = process.env.CARDUME_AGENT ?? "agente";

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
