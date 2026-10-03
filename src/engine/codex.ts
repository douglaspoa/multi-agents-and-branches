import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexResolution, notFoundMsg, toolPath, type Resolution } from "./bin-resolve.ts";
import { adjustRuleOf, exitGraceMs, killProcess } from "./claude.ts";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";
import { mobileRule } from "../mobile.ts";

/**
 * Motor Codex CLI (OpenAI) — e, via provider custom, QUALQUER endpoint
 * OpenAI-compatível (ex.: o LLM hospedado da Logcomex em llm.logcomex.ai/v1).
 *
 * Diferenças honestas vs. o motor Claude (v1):
 *  - sem MCP do Starfork: ask_human/claim não existem — dúvidas viram
 *    .cardume/artifacts/QUESTIONS.md e o turno finaliza com status honesto;
 *    por isso o piloto automático (CARDUME_AUTOPILOT=1) não tem env pra repassar aqui: não há ask_human que
 *    possa travar esperando humano — a regra "não pergunte, decida" chega pelo contexto do barramento (bus.ts);
 *  - sem retomar sessão no meio (chat da tarefa reabre um turno fresco).
 */
export interface CodexProvider {
  id: string; // ex.: "logcomex"
  name: string; // rótulo humano
  baseUrl: string; // ex.: https://llm.logcomex.ai/v1
  envKey: string; // variável com a chave (vem do llm.env da CONTA)
}

/** Caminho do codex pelo RESOLVEDOR ÚNICO (bin-resolve.ts ≡ Rust resolve_tool); não achou → "codex" solto. */
export function resolveCodex(): string {
  return codexResolution().bin ?? "codex";
}

/** PATH pro processo do codex: a pasta dele e a de um node NA FRENTE (o codex do npm é `#!/usr/bin/env node`;
 * aberto pelo Finder o PATH é mínimo — "env: node: No such file or directory", caso do Paulo, 01/10). */
export function codexPath(bin: string, cur: string | undefined): string {
  return toolPath(bin, cur);
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

export const CODEX_INSTALL = "npm i -g @openai/codex";

/**
 * Falha ao INICIAR o codex → frase humana. ENOENT só vira "não encontrado" quando o resolvedor de fato não achou
 * nada (e aí lista onde procurou); achou e mesmo assim não iniciou = diz ONDE achou e o que faltou.
 */
export function codexSpawnError(err: NodeJS.ErrnoException, bin: string, r: Resolution): string {
  const tail = `\n\n(falha ao iniciar codex: ${err.message})`;
  if (!r.bin || !isFile(bin)) {
    return notFoundMsg("O Codex", CODEX_INSTALL, r, " — esta tarefa roda no Codex e o Starfork não troca de IA sozinho.") + tail;
  }
  if (err.code === "ENOENT")
    return `O Codex foi encontrado em ${bin}, mas não consegui iniciá-lo: o arquivo sumiu ou o interpretador dele (node) não existe mais. Reinstale com ${CODEX_INSTALL} e clique em "rodar de novo".` + tail;
  if (err.code === "EACCES")
    return `O Codex foi encontrado em ${bin}, mas sem permissão de execução. Rode \`chmod +x ${bin}\` (ou reinstale com ${CODEX_INSTALL}) e clique em "rodar de novo".` + tail;
  return `Não consegui iniciar o Codex (${bin}): ${err.message}. Confira em Mais › Ambiente e clique em "rodar de novo".` + tail;
}

export function loadLlmEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const p = join(homedir(), ".constellation", "llm.env");
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

export function buildPrompt(input: RunInput): string {
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
  const base = `${adjustRuleOf(input.spec)}Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}${refRule}${artifactRule}${reqRule}${askRule}${groundRule}`;
  const sys = input.systemContext ? `\n\nCONTEXTO DO BARRAMENTO:\n${input.systemContext}` : "";
  const mob = mobileRule({ cwd: input.cwd, role: input.role, spec: input.spec }); // PROVAS MOBILE (mesmo roteiro dos 3 motores)
  return (input.resume ? input.resume.instruction + groundRule + mob : (input.promptOverride ? input.promptOverride + groundRule + mob : base + mob + sys));
}

/**
 * Erro do Codex → frase HUMANA em português, com o que fazer. O texto cru vai junto entre parênteses (o
 * orquestrador reconhece limite/rede/sessão perdida por ele). Nunca sugere trocar de IA: a tarefa SEGUE no Codex.
 */
export function codexFriendlyError(raw: string): string {
  const m = String(raw ?? "").trim();
  const l = m.toLowerCase();
  const tail = m ? `\n\n(${m.slice(0, 400)})` : "";
  if (/usage limit|rate[ _-]?limit|too many requests|\b429\b|quota|limit reached|insufficient_quota/.test(l))
    return "O Codex bateu o limite de uso do seu plano/chave da OpenAI. Espere o limite resetar e mande a mensagem de novo — a tarefa continua no Codex." + tail;
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|not logged in|log ?in again|please (re-?)?log ?in|invalid api key|incorrect api key|authentication|refresh token|token (has )?expired/.test(l))
    return "O Codex não está logado (ou a chave da OpenAI é inválida/expirou). Abra um terminal, rode `codex login` (ou confira a chave em Configurações → Sua IA) e mande a mensagem de novo — a tarefa continua no Codex." + tail;
  if (/no saved session|thread not found|no rollout found|resume failed|session not found/.test(l))
    return "A sessão anterior do Codex não foi encontrada neste computador." + tail;
  if (/context (window|length)|maximum context|too long|out of tokens/.test(l))
    return "A conversa ficou longa demais pro Codex (limite de contexto)." + tail;
  if (/env: .?node.?: no such file|node: (command )?not found|command not found: node/.test(l))
    return "O Codex foi encontrado, mas precisa do Node.js pra rodar e não achei um node junto dele. Instale o Node (brew install node) ou reinstale o Codex com npm i -g @openai/codex e mande a mensagem de novo — a tarefa continua no Codex." + tail;
  if (/stream disconnected|reconnecting|error sending request|connection (reset|refused|closed|error)|network|timed? ?out|econnreset|enotfound|eai_again|dns/.test(l))
    return "Caiu a conexão do Codex com a OpenAI. Confira a internet e mande a mensagem de novo — a tarefa continua no Codex." + tail;
  return m ? `O Codex parou com um erro: ${m.slice(0, 400)}` : "O Codex parou com um erro sem detalhes.";
}

/** Reconexão/aviso transitório que o próprio Codex trata (ele tenta de novo sozinho)? */
const CODEX_TRANSIENT = /reconnecting|stream disconnected|retrying|falling back from websockets|waiting for network|waiting to retry/i;

/**
 * Mensagem de um erro NÃO terminal da linha (evento de topo `error` ou item `error`). O `codex exec --json`
 * emite `{"type":"error"}` também pra avisos que ele mesmo contorna ("Reconnecting... 1/5 (stream disconnected…)")
 * e o turno SEGUE e conclui. Só `turn.failed` (ou a saída ≠ 0) encerra o turno. "" = a linha não é erro.
 */
export function codexLineError(line: string): string {
  let o: Record<string, unknown>;
  try { o = JSON.parse(String(line ?? "").trim()); } catch { return ""; }
  if (!o || typeof o !== "object") return "";
  const t = String(o.type ?? "");
  const item = (o.item ?? null) as Record<string, unknown> | null;
  const errObj = o.error;
  const errMsg = errObj && typeof errObj === "object" ? String((errObj as { message?: unknown }).message ?? "") : typeof errObj === "string" ? errObj : "";
  if (t === "error") return String(o.message ?? errMsg ?? "") || "erro sem detalhes";
  if (item && String(item.type ?? "") === "error") return String(item.message ?? item.text ?? "") || "erro sem detalhes";
  return "";
}

/** Mapeia uma linha JSONL do `codex exec --json` em AgentEvents (defensivo entre versões). */
/** `seen`: ids de item já mostrados no turno (compartilhado entre as linhas de UM turno). */
export function mapCodexLine(line: string, seen: Set<string> = new Set()): AgentEvent[] {
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

  // `turn.failed` traz o motivo em error.message (limite, rede, chave inválida) — antes caía em
  // nenhum ramo e o turno morria só com "codex saiu com código 1", sem o porquê (e sem retry/espera)
  const errObj = (o as { error?: unknown }).error;
  const errMsg = errObj && typeof errObj === "object" ? String((errObj as { message?: unknown }).message ?? "") : typeof errObj === "string" ? errObj : "";
  if (/\.failed$/.test(t) && !/^item\./.test(t)) {
    // FIM do turno com falha (turn.failed): o único erro terminal vindo do stream
    evs.push({ type: "error", text: codexFriendlyError(errMsg || text || s), status: "error" });
  } else if (t === "error" || itemType === "error") {
    // aviso/erro NÃO terminal: o codex segue (ex.: "Reconnecting... 1/5"). Antes virava "error" e o turno era
    // dado como falho no meio — a conversa fechava e a tarefa ia pra erro com o codex ainda trabalhando.
    const msg = codexLineError(s);
    evs.push({ type: "note", ok: false, text: CODEX_TRANSIENT.test(msg) ? `Codex: conexão instável com a OpenAI — reconectando sozinho (${msg.slice(0, 160)})` : `Codex avisou: ${msg.slice(0, 300)}` });
  } else if (/command|exec|shell/i.test(itemType)) {
    const cmd = (item as { command?: unknown }).command;
    const shown = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? text ?? "");
    // o mesmo comando chega em item.started E item.completed: mostra uma vez só. Pelo id do item: comando
    // que só aparece no completed (sem started) também é mostrado; sem id, só no início.
    const id = typeof (item as { id?: unknown }).id === "string" ? String((item as { id?: unknown }).id) : "";
    const late = /completed|updated/i.test(t);
    const show = id ? !seen.has(id) : !late;
    if (id) seen.add(id);
    if (shown && show && !/end|completed|output/i.test(itemType)) evs.push({ type: "bash", text: shown.slice(0, 300) });
  } else if (/patch|file_change|apply/i.test(itemType)) {
    const changes = (item as { changes?: unknown }).changes;
    // `changes` vem como LISTA [{path, kind}] no codex 0.1xx (antes era objeto {caminho: …}) — com Object.keys a
    // tela mostrava "editando 0"
    const paths = Array.isArray(changes)
      ? changes.map((c) => String((c as { path?: unknown })?.path ?? "")).filter(Boolean).join(", ")
      : changes && typeof changes === "object" ? Object.keys(changes as object).join(", ") : text;
    // started + completed do MESMO item: mostra uma vez só (mesma regra dos comandos)
    const id = typeof (item as { id?: unknown }).id === "string" ? `edit:${String((item as { id?: unknown }).id)}` : "";
    const show = id ? !seen.has(id) : true;
    if (id) seen.add(id);
    if (show) evs.push({ type: "edit", text: (paths || "editando arquivos").slice(0, 300) });
  } else if (/reasoning|thinking/i.test(itemType)) {
    if (text) evs.push({ type: "think", text: text.slice(0, 400) });
  } else if (/agent_message|assistant/i.test(itemType)) {
    if (text) evs.push({ type: "note", text: text.slice(0, 1200) });
  } else if (/turn\.completed|task_complete|turn_complete/i.test(itemType)) {
    const usage = (o as { usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } }).usage ?? {};
    evs.push({
      type: "done",
      text: "codex finalizou",
      status: "review",
      cost: { usd: 0, inTok: usage.input_tokens ?? 0, outTok: usage.output_tokens ?? 0, cachedTok: usage.cached_input_tokens ?? 0 },
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
      // worktree isolada — mesmo trust do bypass do Claude. Via -c (e não --sandbox):
      // `codex exec resume` não aceita --sandbox, e o turno de continuação quebrava.
      "-c", 'sandbox_mode="danger-full-access"',
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

    const env: NodeJS.ProcessEnv = { ...process.env, ...loadLlmEnv() };
    const res = codexResolution();
    const bin = res.bin ?? "codex";
    env.PATH = codexPath(bin, env.PATH);
    const child = spawn(bin, args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], env });
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
    // mesmo ciclo de vida do motor Claude: done/erro terminal uma vez só, processo que não sai depois
    // do turno concluído é encerrado, neto segurando o stdout não prende o 'close'
    let exited = false;
    let sawDone = false;
    let sawError = false; // erro terminal (turn.failed) já emitido: o "saiu com código 1" genérico não o encobre
    let lastErr = ""; // último aviso de erro NÃO terminal: vira o motivo se o codex sair ≠ 0 sem turn.failed
    let stderrTail = ""; // fim do stderr: idem (ex.: "Error: Not logged in")
    const seen = new Set<string>();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(killTimer);
      clearTimeout(doneTimer);
      clearTimeout(closeTimer);
      done = true;
      wake();
    };
    const armDoneTimer = () => {
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => {
        if (exited) return;
        queue.push({ type: "note", text: "o codex concluiu o turno mas não fechou sozinho — processo encerrado" });
        killProcess(child, () => exited);
        finish();
      }, exitGraceMs());
    };
    const idleMin = 30;
    const resetIdle = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        queue.push({ type: "error", text: `inatividade de ${idleMin}min — codex encerrado`, status: "error" });
        killProcess(child, () => exited);
        finish();
      }, idleMin * 60 * 1000);
      if (sawDone && !exited) armDoneTimer();
    };
    resetIdle();

    rl.on("line", (line) => {
      resetIdle();
      const le = codexLineError(line);
      if (le) lastErr = le;
      for (const ev of mapCodexLine(line, seen)) {
        if (ev.type === "done" && !sawDone) { sawDone = true; armDoneTimer(); }
        if (ev.type === "error") sawError = true;
        queue.push(ev);
      }
      wake();
    });
    child.stderr.on("data", (d) => {
      resetIdle();
      // "Reading additional input from stdin..." é aviso do próprio codex exec (stdin fechado) — não é erro nem progresso
      const s = String(d).split("\n").filter((l) => !/^Reading (additional )?(input|prompt) from stdin/i.test(l.trim())).join("\n").trim();
      if (s) {
        stderrTail = (stderrTail + "\n" + s).slice(-600);
        queue.push({ type: "note", text: `stderr: ${s.slice(0, 200)}` });
      }
      wake();
    });
    const pushExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // `done` já ENTREGUE não fica na fila: sem o sawDone vinha um 2º "done" (ou um erro falso) no fim
      if (sawDone || done) return;
      if (code === 0) queue.push({ type: "done", text: "codex finalizou", status: "review", cost: { usd: 0, inTok: 0, outTok: 0 } });
      else if (!sawError) {
        // o motivo real (último aviso de erro / stderr) em português — o "código N" fica no fim (o orquestrador
        // reconhece sinal/inatividade por ele)
        const why = lastErr || stderrTail.trim().split("\n").slice(-3).join(" ");
        const head = why ? codexFriendlyError(why) : "O Codex encerrou sem concluir o turno.";
        queue.push({ type: "error", text: `${head}\n\n(codex saiu com código ${code ?? signal})`, status: "error" });
      }
    };
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(doneTimer);
      closeTimer = setTimeout(() => {
        if (done) return;
        try { rl.close(); child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* já fechados */ }
        pushExit(code, signal);
        finish();
      }, 3000);
    });
    child.on("close", (code, signal) => {
      pushExit(code, signal);
      finish();
    });
    child.on("error", (err) => {
      exited = true;
      queue.push({ type: "error", text: codexSpawnError(err as NodeJS.ErrnoException, bin, res), status: "error" });
      finish();
    });

    try {
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
    } finally {
      clearTimeout(killTimer);
      clearTimeout(doneTimer);
      clearTimeout(closeTimer);
      if (!exited) killProcess(child, () => exited); // turno abandonado → nada de codex órfão
    }
  }
}
