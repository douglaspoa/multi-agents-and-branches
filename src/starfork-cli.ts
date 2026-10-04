// `starfork …` — o comando do SHELL do terminal integrado (o sh em <worktree>/.cardume/term/bin/starfork chama o
// motor com `starfork <sub> …`). Serve QUALQUER IA (até a que não fala MCP) e a pessoa que digita no shell:
//   ia-prep <ia> [--modelo m] [--resume] [--msg-file p]  — lançamento da IA como script de sh (o shim roda; ver terminal.ts)
//   _ia-start <ia> / _ia-exit <ia>                         — term_session.cli (qual IA está rodando no shell)
//   status · sugerir · etapa · skills · skill · tarefa · pr · requisito · entregavel · perguntar · mapa · ajuda
// Os comandos de tarefa são as MESMAS ferramentas do MCP (src/mcp/tools.ts › callTool) com o contexto do ambiente
// (CARDUME_DB/CARDUME_TASK/CARDUME_AGENT/CARDUME_ROLE, que o terminal exporta). Saída em texto; erro → código 1.
import { dirname } from "node:path";
import { callTool, ctxFromEnv } from "./mcp/tools.ts";
import { SHELL_COMMANDS } from "./terminal-integrado.ts";
import { AI_LABEL, AiMissingError, iaExit, iaPrep, isTermAi, TERM_AIS } from "./terminal.ts";

export interface Io { out: (s: string) => void; err: (s: string) => void }
const stdio: Io = { out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"), err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n") };

/** Flags sem valor. As outras levam o próximo argumento (ou `--x=valor`); repetir acumula (--requisito a --requisito b). */
const BOOL = new Set(["resume", "rascunho", "fora-do-epico", "iniciar", "help"]);
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
        const { script, launch } = iaPrep(orch, task, ai, { resume: has(a, "resume"), msgFile: one(a, "msg-file"), model: one(a, "modelo", "model") });
        const model = launch.ai === "deepseek" ? launch.env.ANTHROPIC_MODEL?.replace(/\[1m\]$/, "") : one(a, "modelo", "model") ?? "";
        io.err(`\x1b[2m▸ Starfork: ${AI_LABEL[ai]}${model ? ` · ${model}` : ""}${launch.resumed ? " (retomando)" : ""} — ao sair, o shell volta (starfork ajuda)\x1b[0m`);
        io.out(script);
        return 0;
      } catch (e) {
        io.err(e instanceof AiMissingError ? `\n${(e as Error).message}\n` : `starfork ia: ${(e as Error)?.message ?? e}`);
        return 1;
      } finally { orch.close(); }
    }
    case "_ia-start":
    case "_ia-exit": {
      const db = process.env.CARDUME_DB ?? "", task = process.env.CARDUME_TASK ?? "";
      if (!db || !task) return 0;
      const { Store } = await import("./store.ts");
      const store = new Store(db);
      try {
        if (sub === "_ia-exit") iaExit(store, task, String(a.pos[0] ?? ""));
        else store.termSetCli(task, isTermAi(a.pos[0]) ? a.pos[0] : "");
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
    case "etapa":
      return tool(io, "set_status", { status: etapaStatus(a.pos[0] ?? ""), note: one(a, "nota", "note") ?? a.pos.slice(1).join(" ") });
    case "skills":
      return tool(io, "list_skills", {});
    case "skill":
      if (!text) return tool(io, "list_skills", {});
      return tool(io, "use_skill", { name: a.pos[0] });
    case "tarefa":
      return tool(io, "create_task", {
        title: text, objective: one(a, "objetivo", "objective") ?? text, requirements: many(a, "requisito", "requirement"),
        ...(many(a, "entregavel", "deliverable").length ? { deliverables: many(a, "entregavel", "deliverable") } : {}),
        same_epic: !has(a, "fora-do-epico"), start: has(a, "iniciar"),
      });
    case "pr":
      return tool(io, "open_pr", { draft: has(a, "rascunho"), ...(one(a, "titulo", "title") ? { title: one(a, "titulo", "title") } : {}), ...(one(a, "corpo", "body") ? { body: one(a, "corpo", "body") } : {}) });
    case "requisito":
      return tool(io, "add_requirement", { item: text });
    case "entregavel":
    case "entregável":
      return tool(io, "add_deliverable", { item: text });
    case "perguntar":
      return tool(io, "ask_human", { question: text, ...(many(a, "opcao", "opção", "option").length ? { options: many(a, "opcao", "opção", "option") } : {}) });
    case "mapa": {
      let args: Record<string, unknown>;
      try { args = JSON.parse(one(a, "json") ?? text); } catch { io.err("starfork mapa: passe o JSON do map_requirement em --json '{\"req\":\"…\",\"code\":[{\"file\":\"…\",\"lines\":\"1-9\"}]}'"); return 1; }
      return tool(io, "map_requirement", args);
    }
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
