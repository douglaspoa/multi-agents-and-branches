import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { run } from "./util/run.ts";
import { claudeEnv, claudeErrText, resolveClaude } from "./engine/claude.ts";
import { loadLlmEnv, resolveCodex } from "./engine/codex.ts";
import {
  DSH_ERR_KEY, DSH_ERR_NET, DSH_ERR_QUOTA, DSH_KEY_MSG, DSH_MIN_VERSION, DSH_MISSING_MSG, DSH_TIMEOUT_MSG, dshArgs, dshBinExists, dshEnv, dshKey,
  dshModelFor, dshNodeOk, dshNodeMsg, dshSpawnSpec, dshVersion, dshVersionOk, isDshLabel,
  extraPatch, resolveDsh, runPatchYaml, writeBasePatch,
} from "./engine/dsh.ts";
import { claudeEnvelope, claudeModelOf, claudeNumbers, recordUsage, type UsageSource } from "./usage-ledger.ts";

/**
 * IA AUXILIAR "de uma vez" do motor (destilador de memória, retro, resumo de commit) — o MESMO
 * roteamento do Rust (app/src-tauri/src/ai_once.rs): segue a IA padrão do usuário (`aiEngine`/`aiModel`
 * em ~/.constellation/settings.json, espelhado pelo app). Golden compartilhado: tests/fixtures/ai-once-golden/.
 *  - claude  → `claude -p <prompt> [--model <id>]` (argumentos de antes, sem ANTHROPIC_API_KEY);
 *  - codex   → `codex exec --json ... -` SÓ-LEITURA, prompt no STDIN, só a OPENAI_API_KEY do cofre no env;
 *              texto = último agent_message;
 *  - gateway → HTTP chat/completions OpenAI-compatível com aiModel (se for do gateway) ou ALT_AI_MODEL.
 *  - deepseek (beta) → `dsh --patch … --profile headless --json` SÓ-LEITURA, prompt no STDIN, só a DEEPSEEK_API_KEY
 *              no env; texto = evento `final` (deepseek-flash no rápido, deepseek-v4-pro no capaz, ou o aiModel).
 * Escolhido indisponível → primeiro disponível (claude, codex, gateway); nenhum → erro humano. O DeepSeek (beta, terceiro)
 * NUNCA entra como fallback automático: só roda quando é a IA escolhida (aiEngine=deepseek).
 */
export type AiEngineKind = "claude" | "codex" | "gateway" | "deepseek";
export type AiTier = "rapido" | "capaz";
export interface AiAvail { claude: boolean; codex: boolean; gateway: boolean; deepseek?: boolean }

export const NO_ENGINE_MSG =
  "Nenhuma IA disponível neste computador — instale o Claude Code (npm install -g @anthropic-ai/claude-code) ou o Codex (npm install -g @openai/codex), configure um gateway em Configurações → Gateway próprio, ou use o DeepSeek Harness (beta: npm i -g @deepseek-ai/dsh + DEEPSEEK_API_KEY em Configurações → Sua IA).";
export const CODEX_TIMEOUT_MSG = "O Codex não respondeu a tempo — tente de novo.";
export const CODEX_MISSING_MSG = "O Codex não está instalado neste computador — npm install -g @openai/codex (veja Mais › Ambiente).";
export const GATEWAY_CUT_MSG = "a resposta do gateway foi cortada (limite de tokens) — peça algo menor ou aumente o limite no gateway.";

const ORDER: AiEngineKind[] = ["claude", "codex", "gateway"]; // sem deepseek: beta não é fallback silencioso

export function engineOf(pref: string): AiEngineKind | null {
  const n = String(pref ?? "").trim().toLowerCase();
  if (n.startsWith("codex")) return "codex";
  if (isDshLabel(n)) return "deepseek";
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
  return pickWith(pref, (e) => !!av[e]);
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
  const v = e === "claude" ? binExists(resolveClaude()) : e === "codex" ? binExists(resolveCodex()) : e === "deepseek" ? dshAvail().ok : !!gatewayCfg();
  availCache.set(e, { v, at: Date.now() });
  return v;
}

/** Tokens/custo vistos numa chamada (somam as tentativas — o retry do Codex também cobra) + o modelo USADO. */
export interface UsageAcc { inTok: number; cachedTok: number; outTok: number; usd: number; model?: string }
const newAcc = (): UsageAcc => ({ inTok: 0, cachedTok: 0, outTok: 0, usd: 0 });

/** Erros do Claude headless → ação concreta. MESMAS regras e textos do Rust `claude_friendly_error` (lib.rs). */
export function claudeFriendlyError(msg: string): string {
  const l = String(msg ?? "").toLowerCase();
  if (l.includes("oauth") || l.includes("authenticate") || l.includes("401") || l.includes("not logged in") || l.includes("invalid api key"))
    return `Login do Claude Code expirou — abra um terminal, rode \`claude\` e digite /login (ou \`claude auth login\`), depois tente de novo aqui.\n\n(${msg})`;
  if (l.includes("rate limit") || l.includes("429") || l.includes("usage limit") || l.includes("overloaded"))
    return `O Claude está sem cota/limite no momento — espere um pouco e tente de novo.\n\n(${msg})`;
  if (l.includes("no conversation found") || (l.includes("session") && l.includes("not found")))
    return `A sessão da conversa expirou no Claude — clique em '+ novo' pra recomeçar.\n\n(${msg})`;
  return msg;
}
export const CLAUDE_NO_ANSWER = "O Claude Code terminou sem resposta — tente de novo.";

/** Saída de `claude -p --output-format json` → o MESMO texto que o `-p` puro devolvia (`result`), custo/tokens no
 * acumulador (≡ Rust claude_once_text). Envelope = ÚLTIMA linha que começa com `{`; erro nele → mensagem humana;
 * envelope sem `result` ou JSON que não é o envelope → erro humano (nunca o JSON cru como resposta). Texto puro
 * (claude antigo, falso de teste) passa como veio. */
export function claudeOnceText(stdout: string, acc?: UsageAcc): string {
  const t = String(stdout ?? "").trim();
  const o = claudeEnvelope(t);
  if (!o) {
    if (t.split("\n").some((l) => l.trimStart().startsWith("{"))) throw new Error(`${CLAUDE_NO_ANSWER} (resposta inesperada do Claude Code)`);
    return t;
  }
  const n = claudeNumbers(o);
  if (acc) {
    acc.inTok += n.inTok; acc.cachedTok += n.cachedTok; acc.outTok += n.outTok; acc.usd += n.usd;
    acc.model = claudeModelOf(o) ?? acc.model;
  }
  const r = typeof o.result === "string" ? o.result.trim() : undefined;
  if (o.is_error) throw new Error(r ? claudeFriendlyError(r) : "O Claude Code devolveu um erro sem mensagem.");
  if (r === undefined) throw new Error(CLAUDE_NO_ANSWER);
  return r;
}
/** Tokens de um JSONL do Codex (`turn.completed`, cache em `cached_input_tokens`) ou do dsh (`status` step_end). */
export function jsonlTokens(stdout: string, dsh: boolean): { inTok: number; cachedTok: number; outTok: number } {
  let i = 0, c = 0, o = 0;
  for (const line of String(stdout ?? "").split("\n")) {
    let v: any;
    try { v = JSON.parse(line.trim()); } catch { continue; }
    if (!dsh && v?.type === "turn.completed") { i += Number(v.usage?.input_tokens) || 0; c += Number(v.usage?.cached_input_tokens) || 0; o += Number(v.usage?.output_tokens) || 0; }
    if (dsh && v?.type === "status" && v.phase === "step_end") {
      const u = v.usage ?? {};
      i += Number(u.inputTokens) || 0; o += Number(u.outputTokens) || 0;
      c += Number(u.cachedInputTokens ?? u.cacheReadTokens ?? u.cachedTokens) || 0; // nome ainda não documentado pelo dsh (≡ Rust)
    }
  }
  return { inTok: i, cachedTok: c, outTok: o };
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
  if (/401|unauthorized|api key|not logged|login/.test(l)) return `O Codex está sem login/chave — rode \`codex login\` num terminal ou configure a chave OpenAI em Configurações → Sua IA.\n\n(${short})`;
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

// ---------- DeepSeek Harness (beta) ----------

/**
 * Pronto pra uso? binário → node compatível → chave (mesma ordem do Rust dsh_status e do DshEngine.run).
 * `why` = o que falta (mensagem humana). `warn` = versão fora da faixa testada (≥ DSH_MIN_VERSION) — não bloqueia.
 */
export function dshAvail(bin = resolveDsh()): { ok: boolean; why?: string; warn?: string } {
  if (!dshBinExists(bin)) return { ok: false, why: DSH_MISSING_MSG };
  if (!dshNodeOk()) return { ok: false, why: dshNodeMsg(process.versions.node) };
  if (!dshKey()) return { ok: false, why: DSH_KEY_MSG };
  const v = dshVersion(bin);
  return v && !dshVersionOk(v) ? { ok: true, warn: `dsh ${v} é anterior à versão testada (${DSH_MIN_VERSION}) — atualize: npm i -g @deepseek-ai/dsh@latest` } : { ok: true };
}

/** aiModel do usuário vale nos dois níveis (alias do Claude não vale); sem ele: capaz → deepseek-v4-pro, rápido → deepseek-flash. */
export function dshPlan(tier: AiTier, userModel?: string): string {
  return dshModelFor(userModel, tier);
}

/** JSONL do `dsh --json` → texto do `final` (se o turno CONCLUIU) e o erro CRU (evento error / turn_end com erro). */
export function dshOutcome(stdout: string): { text?: string; raw?: string } {
  let final: string | undefined, err = "";
  for (const line of String(stdout ?? "").split("\n")) {
    let o: any;
    try { o = JSON.parse(line.trim()); } catch { continue; }
    const t = String(o?.type ?? "");
    if (t === "final") final = String(o.text ?? "");
    else if (t === "error") err = unwrapJsonMsg(String(o.message ?? "")) || err || "erro";
    else if (t === "status" && o.phase === "turn_end") {
      const kind = String(o?.reason?.kind ?? "");
      if (kind && kind !== "completed") {
        const e = o.reason.error ?? {};
        err = [e.code, unwrapJsonMsg(String(e.message ?? ""))].filter(Boolean).join(": ") || `turno ${kind}`;
      }
    }
  }
  if (!err && final !== undefined && final.trim()) return { text: final.trim() };
  return err ? { raw: err } : {};
}

/** Mesma leitura com o erro já humano (golden compartilhado com o Rust). */
export function parseDshJsonl(stdout: string): { text?: string; error?: string } {
  const r = dshOutcome(stdout);
  if (r.text) return { text: r.text };
  return { error: r.raw ? dshFriendlyError(r.raw) : "O DeepSeek terminou sem resposta — tente de novo." };
}

export function dshFriendlyError(msg: string): string {
  const l = msg.toLowerCase();
  const short = msg.slice(0, 300);
  if (DSH_ERR_KEY.test(l)) return `${DSH_KEY_MSG.replace(/\.$/, "")} e confira se ela é válida.\n\n(${short})`;
  if (DSH_ERR_QUOTA.test(l)) return `O DeepSeek está sem saldo/limite no momento — confira a conta na DeepSeek e tente de novo.\n\n(${short})`;
  if (DSH_ERR_NET.test(l)) return `O DeepSeek não conseguiu falar com a API — cheque a internet/VPN e tente de novo.\n\n(${short})`;
  return `O DeepSeek falhou: ${short}`;
}

let dshSeq = 0;
/** Uma chamada auxiliar no dsh: SÓ-LEITURA, prompt no STDIN, só a DEEPSEEK_API_KEY no env (nunca no argv). */
export async function dshRun(bin: string, prompt: string, o: AiOnceOpts, userModel?: string, acc?: UsageAcc): Promise<string> {
  // binário → node → chave (mesma ordem do dshAvail/DshEngine.run); nada é gravado antes
  if (!dshBinExists(bin)) throw new Error(DSH_MISSING_MSG);
  if (!dshNodeOk()) throw new Error(dshNodeMsg(process.versions.node));
  const llm = loadLlmEnv();
  const key = dshKey(llm);
  if (!key) throw new Error(DSH_KEY_MSG);
  const base = writeBasePatch();
  const runPatch = join(dirname(base), `aux-${process.pid}-${++dshSeq}.patch.yml`);
  writeFileSync(runPatch, runPatchYaml({ model: dshPlan(o.tier, userModel) }), { encoding: "utf8", mode: 0o600 });
  try {
    const sp = dshSpawnSpec(bin, dshArgs([base, runPatch, ...extraPatch()]));
    const r = await runStdin(sp.cmd, sp.args, prompt, {
      cwd: o.cwd || tmpdir(), env: dshEnv(bin, key, "read-only", process.env, llm), ms: Math.max(o.timeout, 120_000), verbatim: sp.verbatim,
    });
    if (r.spawnErr) throw new Error(r.spawnErr.code === "ENOENT" ? DSH_MISSING_MSG : `Não consegui rodar o DeepSeek Harness: ${r.spawnErr.message}`);
    if (r.timedOut) throw new Error(DSH_TIMEOUT_MSG);
    if (acc) { const t = jsonlTokens(r.stdout, true); acc.inTok += t.inTok; acc.cachedTok += t.cachedTok; acc.outTok += t.outTok; acc.model = dshPlan(o.tier, userModel); }
    const out = dshOutcome(r.stdout);
    if (out.text) return out.text;
    if (out.raw) throw new Error(dshFriendlyError(out.raw));
    const err = r.stderr.replace(/^dsh: /gm, "").trim().slice(0, 400);
    throw new Error(err ? dshFriendlyError(err) : "O DeepSeek terminou sem resposta — tente de novo.");
  } finally {
    try { rmSync(runPatch, { force: true }); } catch { /* best-effort */ }
  }
}

export interface AiOnceOpts {
  tier: AiTier;
  /** o `--model` que a chamada usava antes no claude (undefined = sem flag) */
  claudeModel?: string;
  cwd?: string;
  timeout: number;
  /** livro de uso (aba Uso): origem + projeto/tarefa. Sem isto conta como "outros". */
  usage?: { source: UsageSource; project?: string; taskId?: string };
}
/** Ganchos de teste: disponibilidade e binário do codex forçados. */
export interface AiOnceDeps { avail?: Partial<AiAvail>; codexBin?: string; dshBin?: string }

/** Roda com `input` no stdin até `ms`; estourou → mata e marca timedOut. */
function runStdin(bin: string, args: string[], input: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; ms: number; verbatim?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnErr?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsVerbatimArguments: !!o.verbatim });
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
async function codexExec(bin: string, prompt: string, cwd: string | undefined, model: string | undefined, low: boolean, deadline: number, acc?: UsageAcc): Promise<string> {
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
  if (acc) { const t = jsonlTokens(r.stdout, false); acc.inTok += t.inTok; acc.cachedTok += t.cachedTok; acc.outTok += t.outTok; acc.model = model; }
  const out = codexOutcome(r.stdout);
  if (out.text) return out.text;
  if (out.raw) throw new CodexFail(out.raw, codexFriendlyError(out.raw));
  const err = r.stderr.trim().slice(0, 400);
  throw new CodexFail(err, err ? codexFriendlyError(err) : "O Codex terminou sem resposta — tente de novo.");
}

/** Codex com retry de modelo recusado: usa o tempo que SOBROU e lembra a recusa no processo. */
export async function codexRun(bin: string, prompt: string, o: AiOnceOpts, userModel?: string, acc?: UsageAcc): Promise<string> {
  const deadline = Date.now() + Math.max(o.timeout, 120_000);
  const { model, low } = codexPlan(o.tier, userModel);
  try {
    return await codexExec(bin, prompt, o.cwd, model, low, deadline, acc);
  } catch (err) {
    if (model && err instanceof CodexFail && codexModelRefused(err.raw)) {
      codexRefused.add(model);
      return await codexExec(bin, prompt, o.cwd, undefined, low, deadline, acc).catch((e) => { throw new Error((e as Error).message); });
    }
    throw new Error((err as Error).message);
  }
}

export async function gatewayCall(g: GatewayCfg, prompt: string, timeout: number, acc?: UsageAcc): Promise<string> {
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
  if (acc) {
    acc.model = g.model;
    try {
      const u = JSON.parse(body.trim())?.usage ?? {};
      acc.inTok += Number(u.prompt_tokens) || 0; acc.cachedTok += Number(u.prompt_tokens_details?.cached_tokens) || 0; acc.outTok += Number(u.completion_tokens) || 0;
    } catch { /* sem usage */ }
  }
  const r = parseGateway(body);
  if (r.text) return r.text;
  throw new Error(r.error);
}

/** O ponto único. Lança Error com mensagem humana (nunca JSON cru). Grava UMA linha no livro de uso (melhor-esforço). */
export async function aiOnce(prompt: string, o: AiOnceOpts, deps: AiOnceDeps = {}): Promise<string> {
  const prefs = readAiPrefs();
  const has = (e: AiEngineKind) => (deps.avail && deps.avail[e] !== undefined ? !!deps.avail[e] : engineAvail(e));
  const engine = pickWith(prefs.engine, has);
  if (!engine) throw new Error(NO_ENGINE_MSG);
  const userModel = userModelFor(prefs.engine, engine, prefs.model);
  const acc = newAcc();
  const t0 = Date.now();
  // modelo planejado DESTE motor (nunca o do Claude numa linha de outro motor); o acumulador traz o USADO de verdade
  // (Codex sem -m depois da recusa = padrão do Codex; Claude = o de maior custo no modelUsage)
  const planned = engine === "claude" ? o.claudeModel : engine === "codex" ? codexPlan(o.tier, userModel).model : engine === "deepseek" ? dshPlan(o.tier, userModel) : (userModel || gatewayCfg()?.model);
  const log = (ok: boolean) => recordUsage({
    source: o.usage?.source ?? "outros", project: o.usage?.project, taskId: o.usage?.taskId, engine,
    model: engine === "claude" ? (o.claudeModel ?? acc.model) : ("model" in acc ? acc.model : planned),
    inTok: acc.inTok, cachedTok: acc.cachedTok, outTok: acc.outTok, usd: acc.usd, ms: Date.now() - t0, ok,
  });
  try {
    const out = await runEngine(engine, prompt, o, deps, userModel, acc);
    log(true);
    return out;
  } catch (err) {
    log(false);
    throw err;
  }
}

async function runEngine(engine: AiEngineKind, prompt: string, o: AiOnceOpts, deps: AiOnceDeps, userModel: string | undefined, acc: UsageAcc): Promise<string> {
  if (engine === "claude") {
    let stdout = "";
    try {
      // --output-format json: custo informado pelo Claude (livro de uso); o texto devolvido segue o `result`, igual ao -p puro
      ({ stdout } = await run(resolveClaude(), [...claudeArgs(prompt, o.claudeModel), "--output-format", "json"], { cwd: o.cwd, env: claudeEnv(), timeout: o.timeout }));
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      if (e.stderr?.trim()) throw new Error(e.stderr.trim().slice(0, 400));
      // erro dentro do JSON (login expirado, limite…): exit 1 com stderr vazio
      if (e.stdout?.trim()) claudeOnceText(e.stdout, acc);
      throw new Error(claudeErrText(err));
    }
    return claudeOnceText(stdout, acc);
  }
  if (engine === "codex") return codexRun(deps.codexBin ?? resolveCodex(), prompt, o, userModel, acc);
  if (engine === "deepseek") return dshRun(deps.dshBin ?? resolveDsh(), prompt, o, userModel, acc);
  const g = gatewayCfg();
  if (!g) throw new Error("Configure o gateway (URL, chave e modelo) em Configurações → Gateway próprio.");
  return gatewayCall(userModel ? { ...g, model: userModel } : g, prompt, Math.max(o.timeout, 90_000), acc);
}
