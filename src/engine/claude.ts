import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ApprovalMode } from "../types.ts";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";

/**
 * Acha o binário do `claude` sem depender do PATH — que pode estar stale quando
 * o app é lançado via LaunchServices (LSEnvironment). Ordem: CARDUME_CLAUDE →
 * ao lado do node em uso (mesma pasta bin do nvm/homebrew) → "claude" no PATH.
 */
function resolveClaude(): string {
  if (process.env.CARDUME_CLAUDE) return process.env.CARDUME_CLAUDE;
  try {
    const near = join(dirname(process.execPath), "claude");
    if (existsSync(near)) return near;
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
    const roleInstr = ROLE_INSTR[input.role] ?? ROLE_INSTR.builder;
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
          : `- PROVA: comprove que a solução funciona. Se for algo visual/web, capture um screenshot e salve como ".cardume/artifacts/proof.png". Caso contrário, salve ".cardume/artifacts/proof.md" com a evidência (comandos executados, saída de testes, antes/depois).`
      );
      artifactRule =
        ` Ao final, produza também estes ARTEFATOS (crie a pasta .cardume/artifacts/ se não existir):\n${lines.join("\n")}`;
    }
    const refs = input.spec.refs ?? [];
    const refRule = refs.length
      ? ` Há documentos de REFERÊNCIA anexados em .cardume/refs/ (${refs.join(", ")}) — LEIA-OS primeiro como ponto de partida (podem ser specs, prints de bug, PDFs, imagens).`
      : "";
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
    const baseline =
      `${adjustRule}Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}${refRule}${planRule}${prRule}` +
      ` Você tem as tools mcp__cardume__ask_human (pergunte ao humano em caso de dúvida e aguarde) e` +
      ` mcp__cardume__claim (reivindique um caminho antes de editar fora do seu escopo).${askRule}${artifactRule}`;
    // Modo "resume": continua a sessão existente com uma instrução nova do humano.
    // promptOverride: turno fresco com um pedido específico (ex.: gerar entregável).
    const prompt = input.resume ? input.resume.instruction : (input.promptOverride ?? baseline);

    // Escreve o mcp.json que injeta o servidor MCP do Cardume neste run.
    const serverPath = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
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
              CARDUME_AGENT: input.agentName,
            },
          },
        },
      }),
      "utf8"
    );

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
      if (this.model) args.push("--model", this.model);
    }

    // stdin "ignore": evita o aviso "no stdin data received in 3s".
    const child = spawn(resolveClaude(), args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] });
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

    // Timeout de INATIVIDADE (não de relógio): reseta a cada sinal de vida do
    // agente. Assim um agente que trabalha muito (ou espera o humano responder)
    // não é morto — só encerra se ficar realmente parado por N minutos.
    const idleMin = 30;
    let killTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
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

    rl.on("line", (line) => {
      resetIdle();
      for (const ev of mapLine(line)) queue.push(ev);
      wake();
    });
    child.stderr.on("data", (d) => {
      resetIdle();
      const s = String(d).trim();
      if (s) queue.push({ type: "note", text: `stderr: ${s.slice(0, 140)}` });
      wake();
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (!queue.some((e) => e.type === "done")) {
        queue.push({
          type: code === 0 ? "note" : "error",
          text: code === 0 ? "claude finalizou" : `claude saiu com código ${code}`,
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
function mapLine(line: string): AgentEvent[] {
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
      else if (p.type === "text" && p.text?.trim()) out.push({ type: "think", text: p.text.trim().slice(0, 200) });
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
    return [
      {
        type: "done",
        text: (o.result ? String(o.result).slice(0, 120) : "concluído") + cost + denials,
        status: ok ? "review" : "error",
        ok,
        cost: { usd, inTok, outTok },
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
