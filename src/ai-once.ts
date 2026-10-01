import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { run } from "./util/run.ts";
import { claudeEnv, claudeErrText, resolveClaude } from "./engine/claude.ts";
import { loadLlmEnv, resolveCodex } from "./engine/codex.ts";

/**
 * IA AUXILIAR "de uma vez" do motor (destilador de memória, retro, resumo de commit) — o MESMO
 * roteamento do Rust (app/src-tauri/src/ai_once.rs): segue a IA padrão do usuário (`aiEngine`/`aiModel`
 * em ~/.constellation/settings.json, espelhado pelo app). Golden compartilhado: tests/fixtures/ai-once-golden/.
 *  - claude  → `claude -p <prompt> [--model <id>]` (argumentos de antes, sem ANTHROPIC_API_KEY);
 *  - codex   → `codex exec --json ... -` SÓ-LEITURA, prompt no STDIN, só a OPENAI_API_KEY do cofre no env;
 *              texto = último agent_message;
 *  - gateway → HTTP chat/completions OpenAI-compatível com aiModel (se for do gateway) ou ALT_AI_MODEL.
 * Escolhido indisponível → primeiro disponível (claude, codex, gateway); nenhum → erro humano.
 */
export type AiEngineKind = "claude" | "codex" | "gateway";
export type AiTier = "rapido" | "capaz";
export interface AiAvail { claude: boolean; codex: boolean; gateway: boolean }

export const NO_ENGINE_MSG =
  "Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), ou configure um gateway em Configurações → Gateway próprio.";
export const CODEX_TIMEOUT_MSG = "O Codex não respondeu a tempo — tente de novo.";
export const CODEX_MISSING_MSG = "O Codex não está instalado neste computador — npm install -g @openai/codex (veja Mais › Ambiente).";
export const GATEWAY_CUT_MSG = "a resposta do gateway foi cortada (limite de tokens) — peça algo menor ou aumente o limite no gateway.";

const ORDER: AiEngineKind[] = ["claude", "codex", "gateway"];

export function engineOf(pref: string): AiEngineKind | null {
  const n = String(pref ?? "").trim().toLowerCase();
  if (n.startsWith("codex")) return "codex";
  if (n.startsWith("gateway") || n.startsWith("logcomex")) return "gateway";
  if (n.startsWith("claude")) return "claude";
  return null;
}

/** A regra ÚNICA: preferido se disponível; senão o primeiro disponível (claude, codex, gateway). Preguiçosa. */
export function pickWith(pref: string, has: (e: AiEngineKind) => boolean): AiEngineKind | null {
  const p = engineOf(pref);
  if (p && has(p)) return p;
  return ORDER.find((e) => has(e)) ?? null;
}
export function pickEngine(pref: string, av: AiAvail): AiEngineKind | null {
  return pickWith(pref, (e) => av[e]);
}

/** IA padrão espelhada pelo app (settings.json). Sem valor → claude (comportamento de antes). */
export function readAiPrefs(file = join(homedir(), ".constellation", "settings.json")): { engine: string; model: string } {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) ?? {};
    return { engine: String(raw.aiEngine ?? "").trim() || "claude", model: String(raw.aiModel ?? "").trim() };
  } catch {
    return { engine: "claude", model: "" };
  }
}

const safeModel = (m: string) => (/^[A-Za-z0-9\-_.:/[\]]{1,80}$/.test(m.trim()) ? m.trim() : undefined);
/** `aiModel` só vale pro motor que o usuário escolheu (no fallback ele é de OUTRO motor) — nunca no Claude. */
export function userModelFor(pref: string, eng: AiEngineKind, aiModel?: string): string | undefined {
  if (eng === "claude" || engineOf(pref) !== eng || !aiModel) return undefined;
  return safeModel(aiModel);
}

/** Binário existe? Caminho → arquivo; nome solto → procura no PATH. */
export function binExists(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return (process.env.PATH || "").split(delimiter).filter(Boolean).some((d) => exts.some((x) => existsSync(join(d, bin + x))));
}

export interface GatewayCfg { base: string; key: string; model: string }
export function gatewayCfg(env: Record<string, string> = loadLlmEnv()): GatewayCfg | null {
  const g = (k: string) => String(env[k] ?? "").trim();
  const key = g("ALT_AI_KEY") || g("LGCX_API_KEY");
  if (!key) return null;
  const base = (g("ALT_AI_BASE_URL") || "https://llm.logcomex.ai/v1").replace(/\/+$/, "");
  const model = g("ALT_AI_MODEL") || g("ALT_AI_MODELS").split(",").map((s) => s.trim()).find(Boolean) || (/logcomex/i.test(base) ? "logcomex-v2" : "");
  if (!model) return null;
  return { base, key, model };
}

// disponibilidade por motor com cache de 30s (as sondagens não rodam a cada chamada)
const availCache = new Map<AiEngineKind, { v: boolean; at: number }>();
export function clearAvailCache(): void { availCache.clear(); }
export function engineAvail(e: AiEngineKind): boolean {
  const c = availCache.get(e);
  if (c && Date.now() - c.at < 30_000) return c.v;
  const v = e === "claude" ? binExists(resolveClaude()) : e === "codex" ? binExists(resolveCodex()) : !!gatewayCfg();
  availCache.set(e, { v, at: Date.now() });
  return v;
}

export function claudeArgs(prompt: string, model?: string): string[] {
  return model ? ["-p", prompt, "--model", model] : ["-p", prompt];
}

// modelos que o Codex desta conta RECUSOU (ex.: gpt-5-codex com login ChatGPT): as próximas já vão sem -m
const codexRefused = new Set<string>();
/** (modelo, esforço baixo?): aiModel vale nos dois níveis; sem ele capaz → gpt-5-codex, rápido → padrão. */
export function codexPlan(tier: AiTier, userModel?: string): { model?: string; low: boolean } {
  const m = userModel || (tier === "capaz" ? "gpt-5-codex" : undefined);
  return { model: m && !codexRefused.has(m) ? m : undefined, low: tier === "rapido" };
}

/** Codex auxiliar: SEMPRE só-leitura, sem aprovação, prompt pelo STDIN (`-`). */
export function codexArgs(model?: string, low = false): string[] {
  const a = ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
  if (low) a.push("-c", 'model_reasoning_effort="low"');
  if (model) a.push("-m", model);
  a.push("-");
  return a;
}

function unwrapJsonMsg(m: string): string {
  const s = String(m ?? "").trim();
  try {
    const o = JSON.parse(s);
    const inner = o?.error?.message ?? o?.message ?? o?.detail;
    if (typeof inner === "string") return inner.trim();
  } catch { /* não é JSON */ }
  return s;
}

export function codexFriendlyError(msg: string): string {
  const l = msg.toLowerCase();
  const short = msg.slice(0, 300);
  if (/401|unauthorized|api key|not logged|login/.test(l)) return `O Codex está sem login/chave — rode \`codex login\` num terminal ou configure a chave OpenAI em Conta → Chaves de modelo.\n\n(${short})`;
  if (/429|rate limit|quota|usage limit/.test(l)) return `O Codex está sem cota/limite no momento — espere um pouco e tente de novo.\n\n(${short})`;
  if (/stream disconnected|network|timed out|connection/.test(l)) return `O Codex não conseguiu falar com a OpenAI — cheque a internet/VPN e tente de novo.\n\n(${short})`;
  return `O Codex falhou: ${short}`;
}

/** Recusa de MODELO pra esta conta — olha a mensagem CRUA do provedor (nunca o texto amigável do app). */
export const codexModelRefused = (raw: string) => /model is not supported|not supported when using codex with a chatgpt account/i.test(raw);

/** JSONL do `codex exec --json` → texto do ÚLTIMO agent_message e o erro CRU do turno. */
export function codexOutcome(stdout: string): { text?: string; raw?: string } {
  let last = "", fatal = "", warn = "";
  for (const line of String(stdout ?? "").split("\n")) {
    let o: any;
    try { o = JSON.parse(line.trim()); } catch { continue; }
    const t = String(o?.type ?? "");
    const it = String(o?.item?.type ?? "");
    if (it === "agent_message") {
      const s = String(o.item.text ?? "").trim();
      if (s) last = s;
    } else if (t === "turn.failed" || t === "error") {
      const m = unwrapJsonMsg(o?.error?.message ?? o?.message ?? (typeof o?.error === "string" ? o.error : ""));
      if (m) fatal = m;
    } else if (it === "error" && o.item.message) {
      warn = String(o.item.message).trim();
    }
  }
  if (last) return { text: last };
  const raw = fatal || warn;
  return raw ? { raw } : {};
}
/** Mesma leitura com o erro já humano. */
export function parseCodexJsonl(stdout: string): { text?: string; error?: string } {
  const r = codexOutcome(stdout);
  if (r.text) return { text: r.text };
  return { error: r.raw ? codexFriendlyError(r.raw) : "O Codex terminou sem resposta — tente de novo." };
}

export function gatewayPayload(model: string, prompt: string): string {
  return JSON.stringify({ model, max_tokens: 16000, stream: false, messages: [{ role: "user", content: prompt }] });
}

/** `content` pode vir em partes ([{text}]); finish_reason "length" = cortada → erro claro. */
export function parseGateway(body: string): { text?: string; error?: string } {
  let v: any;
  try { v = JSON.parse(String(body ?? "").trim()); } catch {
    const s = String(body ?? "").trim().slice(0, 160);
    return { error: s ? `O gateway respondeu algo inesperado (não é JSON): ${s}` : "O gateway não respondeu — cheque a URL em Configurações → Gateway próprio." };
  }
  const ch = v?.choices?.[0];
  const c = ch?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("") : undefined;
  if (text !== undefined) {
    if (ch?.finish_reason === "length") return { error: GATEWAY_CUT_MSG };
    return text.trim() ? { text: text.trim() } : { error: "O gateway devolveu uma resposta vazia — tente de novo." };
  }
  const err: string = typeof v?.error?.message === "string" ? v.error.message : typeof v?.error === "string" ? v.error : typeof v?.detail === "string" ? v.detail : "";
  if (/401|unauthorized|authentication|invalid.*key/i.test(err)) return { error: `O gateway recusou a chave — confira em Configurações → Gateway próprio.\n\n(${err})` };
  if (err) return { error: `O gateway recusou: ${err}` };
  return { error: `Sem resposta do gateway (${String(body).slice(0, 120)})` };
}

export interface AiOnceOpts {
  tier: AiTier;
  /** o `--model` que a chamada usava antes no claude (undefined = sem flag) */
  claudeModel?: string;
  cwd?: string;
  timeout: number;
}
/** Ganchos de teste: disponibilidade e binário do codex forçados. */
export interface AiOnceDeps { avail?: Partial<AiAvail>; codexBin?: string }

/** Roda com `input` no stdin até `ms`; estourou → mata e marca timedOut. */
function runStdin(bin: string, args: string[], input: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; ms: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnErr?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    const done = (r: { code: number | null; spawnErr?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* já morreu */ } }, Math.max(1, o.ms));
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ code: null, spawnErr: e as NodeJS.ErrnoException }));
    child.on("close", (code) => done({ code }));
    child.stdin.on("error", () => { /* processo saiu antes de ler tudo */ });
    child.stdin.end(input);
  });
}

class CodexFail extends Error {
  raw: string;
  constructor(raw: string, friendly: string) { super(friendly); this.raw = raw; }
}

/** Uma execução do codex. Só a OPENAI_API_KEY do cofre entra no env (o codex lê diffs não confiáveis). */
async function codexExec(bin: string, prompt: string, cwd: string | undefined, model: string | undefined, low: boolean, deadline: number): Promise<string> {
  const left = deadline - Date.now();
  if (left <= 0) throw new CodexFail("timeout", CODEX_TIMEOUT_MSG);
  const llm = loadLlmEnv();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(llm)) delete env[k]; // chaves da conta que o processo herdou ficam de fora…
  if (llm.OPENAI_API_KEY) env.OPENAI_API_KEY = llm.OPENAI_API_KEY; // …menos a da OpenAI
  // codex do npm é `#!/usr/bin/env node` — PATH com a pasta dele e a do node em uso
  const dirs = [dirname(process.execPath), ...(bin.includes("/") || bin.includes("\\") ? [dirname(bin)] : [])];
  const cur = (env.PATH || "").split(delimiter).filter(Boolean);
  env.PATH = [...dirs.filter((d) => !cur.includes(d)), ...cur].join(delimiter);
  const r = await runStdin(bin, codexArgs(model, low), prompt, { cwd: cwd || tmpdir(), env, ms: left });
  if (r.spawnErr) {
    if (r.spawnErr.code === "ENOENT") throw new CodexFail(r.spawnErr.message, CODEX_MISSING_MSG);
    throw new CodexFail(r.spawnErr.message, `Não consegui rodar o Codex: ${r.spawnErr.message}`);
  }
  if (r.timedOut) throw new CodexFail("timeout", CODEX_TIMEOUT_MSG);
  const out = codexOutcome(r.stdout);
  if (out.text) return out.text;
  if (out.raw) throw new CodexFail(out.raw, codexFriendlyError(out.raw));
  const err = r.stderr.trim().slice(0, 400);
  throw new CodexFail(err, err ? codexFriendlyError(err) : "O Codex terminou sem resposta — tente de novo.");
}

/** Codex com retry de modelo recusado: usa o tempo que SOBROU e lembra a recusa no processo. */
export async function codexRun(bin: string, prompt: string, o: AiOnceOpts, userModel?: string): Promise<string> {
  const deadline = Date.now() + Math.max(o.timeout, 120_000);
  const { model, low } = codexPlan(o.tier, userModel);
  try {
    return await codexExec(bin, prompt, o.cwd, model, low, deadline);
  } catch (err) {
    if (model && err instanceof CodexFail && codexModelRefused(err.raw)) {
      codexRefused.add(model);
      return await codexExec(bin, prompt, o.cwd, undefined, low, deadline).catch((e) => { throw new Error((e as Error).message); });
    }
    throw new Error((err as Error).message);
  }
}

export async function gatewayCall(g: GatewayCfg, prompt: string, timeout: number): Promise<string> {
  let body = "";
  try {
    const res = await fetch(`${g.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g.key}`, "Content-Type": "application/json" },
      body: gatewayPayload(g.model, prompt),
      signal: AbortSignal.timeout(timeout),
    });
    body = await res.text();
  } catch (err) {
    throw new Error(`Não consegui falar com o gateway (${g.base}) — cheque a URL e a internet/VPN. (${(err as Error).message})`);
  }
  const r = parseGateway(body);
  if (r.text) return r.text;
  throw new Error(r.error);
}

/** O ponto único. Lança Error com mensagem humana (nunca JSON cru). */
export async function aiOnce(prompt: string, o: AiOnceOpts, deps: AiOnceDeps = {}): Promise<string> {
  const prefs = readAiPrefs();
  const has = (e: AiEngineKind) => (deps.avail && deps.avail[e] !== undefined ? !!deps.avail[e] : engineAvail(e));
  const engine = pickWith(prefs.engine, has);
  if (!engine) throw new Error(NO_ENGINE_MSG);
  const userModel = userModelFor(prefs.engine, engine, prefs.model);
  if (engine === "claude") {
    try {
      const { stdout } = await run(resolveClaude(), claudeArgs(prompt, o.claudeModel), { cwd: o.cwd, env: claudeEnv(), timeout: o.timeout });
      return stdout.trim();
    } catch (err) {
      const e = err as Error & { stderr?: string };
      throw new Error(e.stderr?.trim() ? e.stderr.trim().slice(0, 400) : claudeErrText(err));
    }
  }
  if (engine === "codex") return codexRun(deps.codexBin ?? resolveCodex(), prompt, o, userModel);
  const g = gatewayCfg();
  if (!g) throw new Error("Configure o gateway (URL, chave e modelo) em Configurações → Gateway próprio.");
  return gatewayCall(userModel ? { ...g, model: userModel } : g, prompt, Math.max(o.timeout, 90_000));
}
