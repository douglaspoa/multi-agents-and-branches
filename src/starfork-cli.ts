// `starfork …` — o comando do SHELL do terminal integrado (o sh em <worktree>/.cardume/term/bin/starfork chama o
// motor com `starfork <sub> …`). Serve QUALQUER IA (até a que não fala MCP) e a pessoa que digita no shell:
//   ia-prep <ia> [--modelo m] [--resume] [--quieto] [--msg-file p]  — lançamento da IA como script de sh (o shim roda; ver terminal.ts)
//   _ia-exit <ia> [--falha]                                — a IA saiu: term_session.cli = '' (--falha: nem subiu)
//   status · sugerir · etapa · skills · skill · tarefa · epico (novo|vincular|desvincular|status|lista) · epicos · pr ·
//   requisito · entregavel · perguntar · mapa · ajuda
// Os comandos de tarefa são as MESMAS ferramentas do MCP (src/mcp/tools.ts › callTool) com o contexto do ambiente
// (CARDUME_DB/CARDUME_TASK/CARDUME_AGENT/CARDUME_ROLE, que o terminal exporta). Saída em texto; erro → código 1.
import { dirname } from "node:path";
import { callTool, ctxFromEnv } from "./mcp/tools.ts";
import { SHELL_COMMANDS } from "./terminal-integrado.ts";
import { changeRequestText, resolveExtraAgent } from "./revisao-alteracao.ts";
import { askContextText } from "./ask-style.ts";
import { AI_LABEL, AiMissingError, iaExit, iaPrep, isTermAi, TERM_AIS } from "./terminal.ts";

export interface Io { out: (s: string) => void; err: (s: string) => void }
const stdio: Io = { out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"), err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n") };

/** Flags sem valor. As outras levam o próximo argumento (ou `--x=valor`); repetir acumula (--requisito a --requisito b). */
const BOOL = new Set(["resume", "quieto", "rascunho", "fora-do-epico", "falha", "help"]);
export interface SfArgs { pos: string[]; flags: Record<string, string[]> }
export function parseSf(argv: string[]): SfArgs {
  const a: SfArgs = { pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { a.pos.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=");
      const k = (eq > 0 ? t.slice(2, eq) : t.slice(2)).toLowerCase();
      const v = eq > 0 ? t.slice(eq + 1) : BOOL.has(k) ? "true" : argv[i + 1] !== undefined ? argv[++i] : "";
      (a.flags[k] ??= []).push(v);
    } else a.pos.push(t);
  }
  return a;
}
const one = (a: SfArgs, ...keys: string[]) => { for (const k of keys) { const v = a.flags[k]; if (v?.length) return v[v.length - 1]; } return undefined; };
const many = (a: SfArgs, ...keys: string[]) => keys.flatMap((k) => a.flags[k] ?? []).map((x) => x.trim()).filter(Boolean);
const has = (a: SfArgs, k: string) => (a.flags[k] ?? []).some((v) => v !== "false");

/** etapa em pt-BR ou o status cru → o status do set_status. */
export function etapaStatus(x: string): string {
  const n = x.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (["review", "revisao", "revisar", "pronta", "provar"].includes(n)) return "review";
  if (["needs-you", "esperando", "voce", "humano", "parada"].includes(n)) return "needs-you";
  if (["running", "construindo", "construir", "rodando"].includes(n)) return "running";
  return x.trim();
}

export function helpText(): string {
  return `starfork — o Starfork no terminal desta tarefa\n\n` +
    `  starfork ia <${TERM_AIS.join("|")}> [--modelo <modelo>] [--resume]\n` +
    `      abre a IA aqui (integrada: hooks, MCP, instruções). Ao sair dela, o shell volta.\n` +
    SHELL_COMMANDS.map((c) => `  ${c.cmd}\n      ${c.desc}`).join("\n") +
    `\n  starfork ajuda\n`;
}

/** Ferramenta do MCP → texto e código de saída. */
async function tool(io: Io, name: string, args: Record<string, unknown>): Promise<number> {
  let ctx: ReturnType<typeof ctxFromEnv>;
  try { ctx = ctxFromEnv(); } catch { io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_DB/CARDUME_TASK)."); return 1; }
  if (!ctx.task) { ctx.close(); io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_TASK)."); return 1; }
  try {
    const r = await callTool(ctx, name, args);
    (r.isError ? io.err : io.out)(r.text);
    return r.isError ? 1 : 0;
  } catch (e) {
    io.err(`starfork: ${(e as Error)?.message ?? e}`);
    return 1;
  } finally { ctx.close(); }
}

/** O catálogo do projeto (Meu time) a partir do banco do terminal — pra `starfork etapa <agente do time>`. */
async function projectCatalog(): Promise<{ id: string; name: string; role: string }[]> {
  const db = process.env.CARDUME_DB ?? "";
  if (!db) return [];
  try { const { loadConfig } = await import("./config.ts"); return loadConfig(dirname(dirname(db))).agents; } catch { return []; }
}
/** Mensagem pro agente desta tarefa: IA aberta no terminal → imprime (ela lê); shell no prompt → grava em
 * .cardume/term/next-msg.txt e mostra a linha que abre a IA com ela (o mesmo caminho do app). */
async function toTermAi(io: Io, text: string, ctx: ReturnType<typeof ctxFromEnv>, task: string): Promise<number> {
  let cli = "";
  try { cli = String((ctx.store.db.prepare("SELECT cli FROM term_session WHERE task_id = ?").get(task) as { cli?: string } | undefined)?.cli ?? ""); } catch { /* sem terminal: shell */ }
  if (cli) { io.out(text); return 0; }
  const wt = ctx.store.getTask(task)?.worktree;
  if (!wt) { io.err("starfork: worktree da tarefa não encontrada"); return 1; }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(join(wt, ".cardume", "term"), { recursive: true });
  writeFileSync(join(wt, ".cardume", "term", "next-msg.txt"), text, "utf8");
  io.out(`Pedido gravado em .cardume/term/next-msg.txt. Abra a IA com ele:\n  starfork ia claude --resume --msg-file .cardume/term/next-msg.txt`);
  return 0;
}
/** `starfork etapa <agente> ["o que olhar"]` — a etapa extra começa (registro + SHA de antes) e a instrução vai pra IA. */
async function extraStageCli(io: Io, agent: string, note: string): Promise<number> {
  let ctx: ReturnType<typeof ctxFromEnv>;
  try { ctx = ctxFromEnv(); } catch { io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_DB/CARDUME_TASK)."); return 1; }
  try {
    if (!ctx.task) { io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_TASK)."); return 1; }
    const r = await callTool(ctx, "extra_stage", { agent, note });
    if (r.isError) { io.err(r.text); return 1; }
    return await toTermAi(io, r.text, ctx, ctx.task);
  } catch (e) { io.err(`starfork etapa: ${(e as Error)?.message ?? e}`); return 1; } finally { ctx.close(); }
}
/** `starfork alteracao "o que mudar" [--req 1,3]` — o MESMO texto do botão "Pedir alteração" (changeRequestText). */
async function changeCli(io: Io, text: string, req?: string): Promise<number> {
  let ctx: ReturnType<typeof ctxFromEnv>;
  try { ctx = ctxFromEnv(); } catch { io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_DB/CARDUME_TASK)."); return 1; }
  try {
    const t = ctx.task ? ctx.store.getTask(ctx.task) : undefined;
    if (!t) { io.err("starfork: fora do terminal de uma tarefa (falta CARDUME_TASK)."); return 1; }
    const reqs: string[] = (() => { try { return JSON.parse(t.spec_json).requirements ?? []; } catch { return []; } })();
    const idx = String(req ?? "").split(",").map((x) => parseInt(x, 10) - 1).filter((i) => i >= 0 && i < reqs.length);
    const msg = changeRequestText({ text, reqs: idx.map((i) => ({ i, text: reqs[i] })), from: "terminal" });
    if (!msg) { io.err('starfork alteracao: diga o que mudar — starfork alteracao "o botão some no celular"'); return 1; }
    ctx.store.addEvent(ctx.task, "Você", "note", `pedido de alteração: ${text.slice(0, 160)}`, true);
    return await toTermAi(io, msg, ctx, ctx.task);
  } catch (e) { io.err(`starfork alteracao: ${(e as Error)?.message ?? e}`); return 1; } finally { ctx.close(); }
}

export async function starforkCli(argv: string[], io: Io = stdio): Promise<number> {
  const [sub = "ajuda", ...rest] = argv;
  const a = parseSf(rest);
  const text = a.pos.join(" ").trim();
  switch (sub) {
    case "ia-prep": {
      const ai = String(a.pos[0] ?? "").toLowerCase();
      if (!isTermAi(ai)) { io.err(`starfork ia: diga qual IA — ${TERM_AIS.map((x) => `${x} (${AI_LABEL[x]})`).join(", ")}`); return 1; }
      const db = process.env.CARDUME_DB ?? "", task = process.env.CARDUME_TASK ?? "";
      if (!db || !task) { io.err("starfork ia: fora do terminal de uma tarefa (falta CARDUME_DB/CARDUME_TASK)."); return 1; }
      const { Orchestrator } = await import("./orchestrator.ts");
      const orch = new Orchestrator(dirname(dirname(db)));
      try {
        const { script, launch } = iaPrep(orch, task, ai, { resume: has(a, "resume"), quiet: has(a, "quieto"), msgFile: one(a, "msg-file"), model: one(a, "modelo", "model") });
        const model = launch.ai === "deepseek" ? launch.env.ANTHROPIC_MODEL?.replace(/\[1m\]$/, "") : one(a, "modelo", "model") ?? "";
        io.err(`\x1b[2m▸ Starfork: ${AI_LABEL[ai]}${model ? ` · ${model}` : ""}${launch.resumed ? " (retomando)" : ""} — ao sair, o shell volta (starfork ajuda)\x1b[0m`);
        io.out(script);
        return 0;
      } catch (e) {
        io.err(e instanceof AiMissingError ? `\n${(e as Error).message}\n` : `starfork ia: ${(e as Error)?.message ?? e}`);
        return 1;
      } finally { orch.close(); }
    }
    case "_ia-exit": {
      const db = process.env.CARDUME_DB ?? "", task = process.env.CARDUME_TASK ?? "";
      if (!db || !task) return 0;
      const { Store } = await import("./store.ts");
      const store = new Store(db);
      try {
        iaExit(store, task, String(a.pos[0] ?? ""), { failed: has(a, "falha") });
      } catch (e) { io.err(`starfork ${sub}: ${(e as Error)?.message ?? e}`); } finally { store.close(); }
      return 0;
    }
    case "ia":
      // o `ia` de verdade é do shim (o sh precisa ser o pai da IA); aqui só cai quem chamou o motor direto
      io.err("starfork ia: rode no terminal da tarefa (o comando `starfork` do shell) — ele abre a IA com o TTY.");
      return 1;
    case "status":
      return tool(io, "task_status", {});
    case "sugerir":
      return tool(io, "suggest_replies", { options: a.pos });
    case "etapa": {
      // `starfork etapa design` = chamar OUTRO agente (etapa extra da revisão); `starfork etapa review` = status (como sempre)
      const q = String(a.pos[0] ?? "");
      // palavra de status (review/revisar/construir/esperando…) continua sendo status; agente/papel (design, qa, aria…) vira etapa extra
      // palavra que não é status → agente (o do catálogo do projeto também: a tool resolve e, se não achar, lista os que existem)
      if (/^\+/.test(q) || (!["review", "needs-you", "running"].includes(etapaStatus(q)) && resolveExtraAgent(await projectCatalog(), q))) return extraStageCli(io, q.replace(/^\+/, ""), one(a, "nota", "note") ?? a.pos.slice(1).join(" "));
      return tool(io, "set_status", { status: etapaStatus(q), note: one(a, "nota", "note") ?? a.pos.slice(1).join(" ") });
    }
    case "alteracao":
    case "alteração":
      return changeCli(io, text, one(a, "req"));
    case "skills":
      return tool(io, "list_skills", {});
    case "skill":
      if (!text) return tool(io, "list_skills", {});
      return tool(io, "use_skill", { name: a.pos[0] });
    case "tarefa":
      return tool(io, "create_task", {
        title: text, objective: one(a, "objetivo", "objective") ?? text, requirements: many(a, "requisito", "requirement"),
        ...(many(a, "entregavel", "deliverable").length ? { deliverables: many(a, "entregavel", "deliverable") } : {}),
        same_epic: !has(a, "fora-do-epico"),
      });
    case "pr":
      return tool(io, "open_pr", { draft: has(a, "rascunho"), ...(one(a, "titulo", "title") ? { title: one(a, "titulo", "title") } : {}), ...(one(a, "corpo", "body") ? { body: one(a, "corpo", "body") } : {}) });
    case "requisito":
      return tool(io, "add_requirement", { item: text });
    case "entregavel":
    case "entregável":
      return tool(io, "add_deliverable", { item: text });
    case "perguntar": {
      const ctx = many(a, "contexto", "context"), opts = many(a, "opcao", "opção", "option");
      return tool(io, "ask_human", { question: text, ...(ctx.length ? { context: askContextText(ctx) } : {}), ...(opts.length ? { options: opts } : {}) });
    }
    case "mapa": {
      let args: Record<string, unknown>;
      try { args = JSON.parse(one(a, "json") ?? text); } catch { io.err("starfork mapa: passe o JSON do map_requirement em --json '{\"req\":\"…\",\"code\":[{\"file\":\"…\",\"lines\":\"1-9\"}]}'"); return 1; }
      return tool(io, "map_requirement", args);
    }
    case "epico":
    case "épico": {
      const [op = "", ...pos] = a.pos;
      const tarefas = many(a, "tarefas", "tarefa", "tasks").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
      if (op === "novo" || op === "new") return tool(io, "create_epic", {
        title: pos.join(" "), description: one(a, "descricao", "descrição", "description"), outcome: one(a, "outcome", "resultado"),
        done_when: many(a, "pronto", "done-when"), task_ids: tarefas,
        cards: many(a, "cartao", "cartão", "card"), assignee: one(a, "para", "responsavel", "responsável"),
      });
      if (op === "vincular" || op === "link") return tool(io, "link_tasks_to_epic", { epic: pos[0] ?? "", task_ids: [...pos.slice(1), ...tarefas] });
      if (op === "desvincular" || op === "unlink") return tool(io, "unlink_tasks_from_epic", { task_ids: [...pos, ...tarefas] });
      if (op === "status") return tool(io, "epic_request_status", pos[0] ? { request_id: pos[0] } : {});
      if (op === "lista" || op === "list" || !op) return tool(io, "list_epics", {});
      io.err(`starfork epico: use novo | vincular | desvincular | status | lista\n\n${helpText()}`);
      return 1;
    }
    case "epicos":
    case "épicos":
      return tool(io, "list_epics", {});
    case "ajuda":
    case "help":
    case "--help":
    case "-h":
      io.out(helpText());
      return 0;
    default:
      io.err(`starfork: comando desconhecido "${sub}"\n\n${helpText()}`);
      return 1;
  }
}
