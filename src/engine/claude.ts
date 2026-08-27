import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";

/**
 * Motor REAL — roda o Claude Code em modo headless dentro da worktree.
 * Isto é Claude Code (sua assinatura), NÃO a API /messages.
 *
 *   claude -p "<prompt>" \
 *     --output-format stream-json --verbose \
 *     --append-system-prompt "<estado do barramento>" \
 *     [--model <model>]
 *
 * Lê o stream NDJSON do stdout e o traduz para AgentEvent. O mapeamento é
 * best-effort e pode precisar de ajuste conforme a versão do Claude Code
 * (rode `claude --help` / `--output-format stream-json` para conferir o schema).
 */
export class ClaudeEngine implements AgentEngine {
  id = "claude";
  displayName = "Claude Code";
  private model?: string;

  constructor(opts: { model?: string } = {}) {
    this.model = opts.model;
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const roleInstr =
      input.role === "planner"
        ? "Seu papel é PLANNER: leia o TASK.yaml e escreva .cardume/PLAN.md com o plano em passos. Não implemente."
        : input.role === "reviewer"
        ? "Seu papel é REVIEWER: leia o diff da branch (git diff) e escreva um resumo do que foi feito, funções criadas e para que servem, e como testar."
        : "Seu papel é BUILDER: implemente a tarefa. Antes de editar arquivos fora do seu escopo, use claim(path).";
    const prompt = `Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}`;
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (input.systemContext) args.push("--append-system-prompt", input.systemContext);
    if (this.model) args.push("--model", this.model);

    const child = spawn("claude", args, { cwd: input.cwd });
    const rl = createInterface({ input: child.stdout });

    const queue: AgentEvent[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };

    rl.on("line", (line) => {
      const ev = mapLine(line);
      if (ev) queue.push(ev);
      wake();
    });
    child.stderr.on("data", (d) => {
      queue.push({ type: "note", text: `stderr: ${String(d).trim().slice(0, 120)}` });
      wake();
    });
    child.on("close", (code) => {
      queue.push({
        type: "done",
        text: code === 0 ? "claude finalizou" : `claude saiu com código ${code}`,
        status: code === 0 ? "review" : "error",
        ok: code === 0,
      });
      done = true;
      wake();
    });
    child.on("error", (err) => {
      queue.push({ type: "error", text: `falha ao iniciar claude: ${err.message}`, status: "error" });
      done = true;
      wake();
    });

    yield { type: "status", text: "iniciando claude -p (headless)", status: "running" };

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

/** Traduz uma linha NDJSON do stream-json do Claude Code em AgentEvent. */
function mapLine(line: string): AgentEvent | null {
  const t = line.trim();
  if (!t) return null;
  let obj: any;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }

  // Mensagem do assistente pode conter texto e/ou tool_use.
  if (obj.type === "assistant" && obj.message?.content) {
    for (const part of obj.message.content) {
      if (part.type === "tool_use") {
        return mapTool(part.name, part.input);
      }
      if (part.type === "text" && part.text?.trim()) {
        return { type: "think", text: part.text.trim().slice(0, 160) };
      }
    }
    return null;
  }

  if (obj.type === "result") {
    return { type: "note", text: "resultado recebido" };
  }
  return null;
}

function mapTool(name: string | undefined, inp: any): AgentEvent {
  const n = (name ?? "").toLowerCase();
  if (n === "claim") return { type: "claim", text: String(inp?.path ?? ""), path: inp?.path, mode: inp?.mode ?? "write" };
  if (n.includes("edit") || n.includes("str_replace")) return { type: "edit", text: fileOf(inp), ok: true };
  if (n.includes("write") || n.includes("create")) return { type: "write", text: fileOf(inp), ok: true };
  if (n.includes("read")) return { type: "read", text: fileOf(inp) };
  if (n.includes("bash") || n.includes("shell")) return { type: "bash", text: String(inp?.command ?? "").slice(0, 120) };
  return { type: "note", text: `${name}` };
}

function fileOf(inp: any): string {
  return String(inp?.file_path ?? inp?.path ?? inp?.filename ?? "").replace(/^.*\/(?=[^/]+$)/, (m) => m);
}
