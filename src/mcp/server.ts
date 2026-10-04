// Servidor MCP (stdio, JSON-RPC 2.0) hospedado pelo Starfork e injetado no
// Claude Code via --mcp-config. Expõe:
//   ask_human(question, options?) — pergunta ao humano; BLOQUEIA até a UI responder.
//   claim(path, mode)             — reivindica um caminho no barramento.
//   add_deliverable · add_requirement · map_requirement · set_issue · check_done_when · edit_task · edit_epic · epic_tasks
//   TERMINAL INTEGRADO (lógica em src/terminal-integrado.ts):
//   suggest_replies(options)      — 2–4 respostas prováveis do humano → evento "suggest" (o app vira botões).
//   task_status()                 — requisitos × provas, entregáveis, artefatos, PR e o que falta pra provado/entregue.
//   set_status(status, note)      — review | needs-you | running (nunca em integrada/cancelada).
//   list_skills() / use_skill(name) — skills ativas/projeto/pessoais; use_skill devolve o SKILL.md (qualquer motor segue).
//   create_task(title, …)         — tarefa NOVA no mesmo projeto (rascunho; épico herdado).
//   open_pr(title?, body?, draft?) — gate das provas → commit, push, gh pr create (Orchestrator.openPr).
//
// As ferramentas (lista + lógica) moram em ./tools.ts — as MESMAS do `starfork …` no terminal integrado.
// Só escreve JSON-RPC no stdout; qualquer log vai pro stderr.
import { createInterface } from "node:readline";
import { callTool as runTool, ctxFromEnv, TOOLS } from "./tools.ts";

if (!process.env.CARDUME_DB) {
  process.stderr.write("cardume-mcp: falta CARDUME_DB\n");
  process.exit(1);
}
// a lógica das ferramentas mora em ./tools.ts (a mesma do `starfork …` do terminal integrado)
const ctx = ctxFromEnv();
const callTool = (name: string, args: any) => runTool(ctx, name, args);


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
    let res: { text: string; isError?: boolean };
    // nunca derruba o servidor: erro de tool vira texto isError pro agente
    try { res = await callTool(params?.name, params?.arguments ?? {}); }
    catch (e) { res = { text: `falha em ${params?.name}: ${(e as Error)?.message ?? e}`, isError: true }; }
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
  ctx.close();
  process.exit(0);
});
