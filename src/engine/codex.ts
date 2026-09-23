import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";

/**
 * Motor Codex CLI (OpenAI) — e, via provider custom, QUALQUER endpoint
 * OpenAI-compatível (ex.: o LLM hospedado da Logcomex em llm.logcomex.ai/v1).
 *
 * Diferenças honestas vs. o motor Claude (v1):
 *  - sem MCP do Cardume: ask_human/claim não existem — dúvidas viram
 *    .cardume/artifacts/QUESTIONS.md e o turno finaliza com status honesto;
 *  - sem retomar sessão no meio (chat da tarefa reabre um turno fresco).
 */
export interface CodexProvider {
  id: string; // ex.: "logcomex"
  name: string; // rótulo humano
  baseUrl: string; // ex.: https://llm.logcomex.ai/v1
  envKey: string; // variável com a chave (vem do llm.env da CONTA)
}

function resolveCodex(): string {
  const envBin = process.env.CARDUME_CODEX;
  if (envBin && existsSync(envBin)) return envBin;
  // ao lado do node que roda o motor (nvm incluso — mesmo padrão do claude)
  const beside = join(dirname(process.execPath), "codex");
  if (existsSync(beside)) return beside;
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) if (existsSync(p)) return p;
  return "codex";
}

/** Chaves de modelo da CONTA (sincronizadas pelo app) → env do processo filho. */
function loadLlmEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const p = join(process.env.HOME ?? "", ".constellation", "llm.env");
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.trim().match(/^([A-Z][A-Z0-9_]{2,63})=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* sem arquivo = sem chaves extras */
  }
  return out;
}

const ROLE_INSTR: Record<string, string> = {
  planner: "Seu papel é PLANNER: leia o TASK.yaml e escreva .cardume/PLAN.md com o plano em passos. Não implemente.",
  reviewer: "Seu papel é REVIEWER: leia o diff da branch (git diff) e resuma o que foi feito e como testar.",
  designer: "Seu papel é DESIGNER: defina a UX/UI antes do código. Escreva .cardume/DESIGN.md.",
  tester: "Seu papel é TESTER: escreva e rode testes cobrindo o caminho principal e casos de borda.",
  docs: "Seu papel é DOCS: escreva documentação concisa com exemplos de uso.",
  investigator: "Seu papel é INVESTIGADOR: ache a CAUSA RAIZ com evidência — NÃO implemente a correção.",
  builder: "Seu papel é BUILDER: implemente a tarefa descrita.",
};

function buildPrompt(input: RunInput): string {
  const roleInstr = ROLE_INSTR[input.role] ?? ROLE_INSTR.builder;
  const arts = input.spec.artifacts ?? [];
  const artifactRule = arts.length && input.role !== "planner"
    ? ` Produza os ARTEFATOS em .cardume/artifacts/: ${arts
        .map((a) => (a.kind === "doc" ? a.name : a.kind === "tests" ? "tests.md (comandos + saída REAL da suíte)" : "proof.png/proof.md (evidência REAL na UI/ambiente — nunca mock)"))
        .join(", ")}.`
    : "";
  const reqs = input.spec.requirements ?? [];
  const reqRule = reqs.length && input.role !== "planner"
    ? ` Ao final escreva .cardume/artifacts/requirements.json: [{"req":"<texto EXATO do requisito>","status":"done"|"blocked","evidence":["arquivos que comprovam"],"note":"..."}] — requisito sem evidência real não é done.`
    : "";
  const refs = input.spec.refs ?? [];
  const refRule = refs.length ? ` Leia primeiro as referências em .cardume/refs/ (${refs.join(", ")}).` : "";
  const askRule =
    " Este motor NÃO tem canal de pergunta ao humano: se algo ESSENCIAL estiver ambíguo ou impossível, registre a dúvida em .cardume/artifacts/QUESTIONS.md, marque o requisito como blocked no requirements.json e finalize honestamente — NUNCA invente nem entregue silenciosamente sem um requisito.";
  const groundRule =
    " EXECUTE ANTES DE AFIRMAR: rode o projeto/testes de verdade nesta worktree (envs semeadas — veja .cardume/AMBIENTE.md) antes de qualquer conclusão; leitura de código não é verificação. Scripts descartáveis em .cardume/tmp/ (fora do diff).";
  const base = `Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}${refRule}${artifactRule}${reqRule}${askRule}${groundRule}`;
  const sys = input.systemContext ? `\n\nCONTEXTO DO BARRAMENTO:\n${input.systemContext}` : "";
  return (input.resume ? input.resume.instruction + groundRule : (input.promptOverride ? input.promptOverride + groundRule : base + sys));
}

/** Mapeia uma linha JSONL do `codex exec --json` em AgentEvents (defensivo entre versões). */
function mapCodexLine(line: string): AgentEvent[] {
  const s = line.trim();
  if (!s) return [];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(s);
  } catch {
    return [{ type: "note", text: s.slice(0, 300) }];
  }
  const evs: AgentEvent[] = [];
  const t = String((o as { type?: unknown }).type ?? "");
  const item = (o as { item?: Record<string, unknown> }).item ?? o;
  const itemType = String((item as { type?: unknown }).type ?? t);
  const text = String(
    (item as { text?: unknown }).text ?? (item as { message?: unknown }).message ?? (o as { message?: unknown }).message ?? ""
  );
  const sid = (o as { session_id?: unknown }).session_id ?? (o as { thread_id?: unknown }).thread_id;
  if (typeof sid === "string" && sid) evs.push({ type: "session", text: sid });

  if (/error/i.test(itemType)) {
    evs.push({ type: "error", text: (text || s).slice(0, 400), status: "error" });
  } else if (/command|exec|shell/i.test(itemType)) {
    const cmd = (item as { command?: unknown }).command;
    const shown = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? text ?? "");
    if (shown && !/end|completed|output/i.test(itemType)) evs.push({ type: "bash", text: shown.slice(0, 300) });
  } else if (/patch|file_change|apply/i.test(itemType)) {
    const changes = (item as { changes?: unknown }).changes;
    const paths = changes && typeof changes === "object" ? Object.keys(changes as object).join(", ") : text;
    evs.push({ type: "edit", text: (paths || "editando arquivos").slice(0, 300) });
  } else if (/reasoning|thinking/i.test(itemType)) {
    if (text) evs.push({ type: "think", text: text.slice(0, 400) });
  } else if (/agent_message|assistant/i.test(itemType)) {
    if (text) evs.push({ type: "note", text: text.slice(0, 1200) });
  } else if (/turn\.completed|task_complete|turn_complete/i.test(itemType)) {
    const usage = (o as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
    evs.push({
      type: "done",
      text: "codex finalizou",
      status: "review",
      cost: { usd: 0, inTok: usage.input_tokens ?? 0, outTok: usage.output_tokens ?? 0 },
    });
  }
  return evs;
}

export class CodexEngine implements AgentEngine {
  id = "codex";
  displayName = "Codex";
  private model?: string;
  private provider?: CodexProvider;

  constructor(opts: { model?: string; provider?: CodexProvider } = {}) {
    this.model = opts.model;
    this.provider = opts.provider;
    if (opts.provider) this.displayName = opts.provider.name;
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const t0 = Date.now(); // o codex não informa duração — medimos o relógio do turno
    const prompt = buildPrompt(input);
    const args: string[] = ["exec"];
    if (input.resume?.sessionId) args.push("resume", input.resume.sessionId);
    args.push(
      "--json",
      "--skip-git-repo-check",
      "--sandbox", "danger-full-access", // worktree isolada — mesmo trust do bypass do Claude
      "-c", 'approval_policy="never"'
    );
    if (this.provider) {
      const p = this.provider;
      args.push(
        "-c", `model_providers.${p.id}.name="${p.name}"`,
        "-c", `model_providers.${p.id}.base_url="${p.baseUrl}"`,
        "-c", `model_providers.${p.id}.env_key="${p.envKey}"`,
        "-c", `model_provider="${p.id}"`
      );
    }
    if (this.model) args.push("-m", this.model);
    args.push(prompt);

    const env = { ...process.env, ...loadLlmEnv() };
    const child = spawn(resolveCodex(), args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], env });
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
    const idleMin = 30;
    let killTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        queue.push({ type: "error", text: `inatividade de ${idleMin}min — codex encerrado`, status: "error" });
        try { child.kill("SIGTERM"); } catch { /* já morreu */ }
        done = true;
        wake();
      }, idleMin * 60 * 1000);
    };
    resetIdle();

    rl.on("line", (line) => {
      resetIdle();
      for (const ev of mapCodexLine(line)) queue.push(ev);
      wake();
    });
    child.stderr.on("data", (d) => {
      resetIdle();
      const s = String(d).trim();
      if (s) queue.push({ type: "note", text: `stderr: ${s.slice(0, 200)}` });
      wake();
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (!queue.some((e) => e.type === "done")) {
        queue.push({
          type: code === 0 ? "done" : "error",
          text: code === 0 ? "codex finalizou" : `codex saiu com código ${code}`,
          status: code === 0 ? "review" : "error",
          ...(code === 0 ? { cost: { usd: 0, inTok: 0, outTok: 0 } } : {}),
        });
      }
      done = true;
      wake();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      queue.push({
        type: "error",
        text: `falha ao iniciar codex: ${err.message} — instale com: npm i -g @openai/codex`,
        status: "error",
      });
      done = true;
      wake();
    });

    yield { type: "status", text: `iniciando ${this.displayName}${this.model ? ` (${this.model})` : ""}`, status: "running" };

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { notify = r; });
        continue;
      }
      const ev = queue.shift()!;
      if (ev.cost && !ev.cost.ms) ev.cost.ms = Date.now() - t0;
      yield ev;
    }
  }
}
