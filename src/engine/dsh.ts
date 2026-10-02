import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitGraceMs, killProcess, mapTool } from "./claude.ts";
import { loadLlmEnv } from "./codex.ts";
import { protectEnabled, PROTECT_RULE } from "./protect.ts";
import type { AgentEngine, AgentEvent, RunInput } from "./types.ts";

/**
 * Motor DeepSeek Harness (`dsh`, MIT — github.com/deepseek-ai/deepseek-harness) — BETA (o dsh está em
 * developer preview). Pra quem não tem plano da Anthropic nem da OpenAI: só a DEEPSEEK_API_KEY da conta.
 *
 *   dsh --patch ~/.constellation/dsh/starfork.patch.yml --patch <wt>/.cardume/dsh.patch.yml \
 *       --profile headless --json [--session-id <id>]      (prompt no STDIN)
 *
 *  - starfork.patch.yml (fixo): upload do log de sessão pra DeepSeek DESLIGADO + telemetria OTel desligada.
 *    Nunca editamos o ~/.dsh do usuário — a config do Starfork vai só por --patch.
 *  - dsh.patch.yml (por turno, na worktree — como o mcp.json do Claude): modelo escolhido + MCP do Starfork
 *    (ask_human/claim/…) via stdio. Por turno porque tarefas em paralelo têm task/agente/banco diferentes.
 *  - Tarefa: DSH_PERMISSION_MODE=danger-full-access (mesmo nível do Codex nas tarefas); auxiliar: read-only.
 *  - Eventos JSONL do headless: session, status(step_end c/ usage, turn_end c/ reason), text, thinking,
 *    tool_call, tool_result, final, error. Exit 0 = turno concluído. Custo: só tokens (usd 0, como o Codex).
 */
export const DSH_INSTALL = "npm i -g @deepseek-ai/dsh";
export const DSH_MISSING_MSG = `O DeepSeek Harness (dsh) não está instalado neste computador — instale com ${DSH_INSTALL} (veja Mais › Ambiente).`;
export const DSH_KEY_MSG = "Falta a chave da DeepSeek (DEEPSEEK_API_KEY) — adicione em Configurações → Sua IA.";
export const DSH_TIMEOUT_MSG = "O DeepSeek não respondeu a tempo — tente de novo.";
export const dshNodeMsg = (v: string) =>
  `O DeepSeek Harness precisa do Node 22.19+ ou 24+ (o deste computador é ${v}) — atualize o Node (veja Mais › Ambiente).`;
/** Catálogo do dsh (llm-deepseek): rápido = flash; capaz = v4-pro. */
export const DSH_FAST_MODEL = "deepseek-flash";
export const DSH_CAPABLE_MODEL = "deepseek-v4-pro";

/** Versão mínima testada (os ids de plugin dos patches vêm dela — developer preview muda nomes). */
export const DSH_MIN_VERSION = "0.2.0-rc.2";

/** semver com pré-release ("0.2.0-rc.2"): <0, 0, >0. Mesma regra do Rust (ai_once::dsh_version_cmp). */
export function dshVersionCmp(a: string, b: string): number {
  const parse = (v: string) => {
    const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
/** Versão dentro da faixa suportada (≥ DSH_MIN_VERSION)? Versão ilegível = não sabemos → não bloqueia. */
export const dshVersionOk = (v: string) => dshVersionCmp(v, DSH_MIN_VERSION) >= 0;

/** Mesmo rótulo nos dois lados (TS/Rust/front): "deepseek…" ou "dsh" como palavra ("dsh-flash", "dsh:x"). */
export const isDshLabel = (s: string) => {
  const n = String(s ?? "").trim().toLowerCase();
  return n.startsWith("deepseek") || /^dsh\b/.test(n);
};

/**
 * CLI instalada com `npm i -g` (codex, dsh) — MESMA busca do Rust (ai_once::node_tool_bin): <ENV> (se existir) →
 * ao lado do node escolhido (CARDUME_NODE, depois o que roda o motor) → gerenciadores de node (nvm/fnm/asdf/mise/volta,
 * mais novo primeiro) → homebrew → /usr/local/bin → nome solto (PATH). No Windows: `<nome>.exe`/`<nome>.cmd`.
 */
export function nodeToolBin(envVar: string, name: string): string {
  const envBin = process.env[envVar];
  if (envBin && existsSync(envBin)) return envBin;
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  const beside = (node: string) => { for (const n of names) { const p = join(dirname(node), n); if (existsSync(p)) return p; } return ""; };
  for (const node of [process.env.CARDUME_NODE ?? "", process.execPath].filter(Boolean)) { const b = beside(node); if (b) return b; }
  const home = homedir();
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const cands: string[] = [];
  for (const [base, tail] of [
    [".nvm/versions/node", "bin"], [".local/share/fnm/node-versions", "installation/bin"], [".fnm/node-versions", "installation/bin"],
    [".asdf/installs/nodejs", "bin"], [".local/share/mise/installs/node", "bin"], [".volta/tools/image/node", "bin"],
  ]) {
    try { for (const e of readdirSync(join(home, base))) cands.push(join(home, base, e, tail, exe)); } catch { /* sem esse gerenciador */ }
  }
  cands.push(join(home, ".volta", "bin", exe), join(home, ".local", "bin", exe));
  cands.sort();
  for (const n of cands.reverse()) { const b = beside(n); if (b) return b; }
  for (const p of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) if (existsSync(p)) return p;
  return name;
}

/** Acha o `dsh` como se acha o `codex` (mesma busca do Rust). */
export function resolveDsh(): string {
  return nodeToolBin("CARDUME_DSH", "dsh");
}

/** Binário existe? Caminho → arquivo; nome solto → procura no PATH. */
export function dshBinExists(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return (process.env.PATH || "").split(delimiter).filter(Boolean).some((d) => exts.some((x) => existsSync(join(d, bin + x))));
}

/**
 * Como iniciar o dsh: no Windows o `npm i -g` instala um `dsh.cmd`, que o Node NÃO roda sem shell (EINVAL) —
 * vai via `cmd.exe /d /s /c "<bin> <args>"` com cada argumento entre aspas (caminhos com espaço).
 */
export function dshSpawnSpec(bin: string, args: string[]): { cmd: string; args: string[]; verbatim: boolean } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
    return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${[bin, ...args].map(q).join(" ")}"`], verbatim: true };
  }
  return { cmd: bin, args, verbatim: false };
}

/** Versão instalada (`dsh --version`, com o node escolhido no PATH). */
export function dshVersion(bin: string): string {
  try {
    const sp = dshSpawnSpec(bin, ["--version"]);
    const r = spawnSync(sp.cmd, sp.args, { env: dshEnv(bin, "", "read-only"), timeout: 8000, encoding: "utf8", windowsVerbatimArguments: sp.verbatim });
    return r.status === 0 ? String(r.stdout).trim().split("\n")[0] : "";
  } catch {
    return "";
  }
}

/** Modelo do DeepSeek: vazio ou alias/id do CLAUDE (o #ntModel oferece opus/sonnet/haiku) → o do nível. */
export function dshModelFor(model: string | undefined, tier: "rapido" | "capaz"): string {
  const m = String(model ?? "").trim();
  if (!m || /^(opus|sonnet|haiku|claude)/i.test(m)) return tier === "capaz" ? DSH_CAPABLE_MODEL : DSH_FAST_MODEL;
  return m;
}

/** O dsh pede Node ^22.19 ou ≥24 (o 23 não serve). */
export function dshNodeOk(version: string = process.versions.node): boolean {
  const [maj, min] = String(version).replace(/^v/, "").split(".").map((x) => Number(x) || 0);
  return maj >= 24 || (maj === 22 && min >= 19);
}

/** Chave da DeepSeek: a da CONTA (llm.env) primeiro; senão a do ambiente do processo. */
export function dshKey(llm: Record<string, string> = loadLlmEnv()): string {
  return String(llm.DEEPSEEK_API_KEY ?? "").trim() || String(process.env.DEEPSEEK_API_KEY ?? "").trim();
}

/**
 * Ambiente do dsh: as chaves da conta que o processo herdou ficam DE FORA (o agente lê código não confiável),
 * entra só a DEEPSEEK_API_KEY (no env, nunca no argv). PATH com a pasta do node escolhido pelo app NA FRENTE
 * (o dsh do npm é `#!/usr/bin/env node`) e a do binário. Telemetria OTel desligada.
 */
export function dshEnv(
  bin: string,
  key: string,
  mode: "danger-full-access" | "read-only",
  base: NodeJS.ProcessEnv = process.env,
  llm: Record<string, string> = loadLlmEnv()
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(llm)) delete env[k];
  // segredos HERDADOS (OPENAI/ANTHROPIC/LGCX…) não chegam no agente em danger-full-access — só a da DeepSeek
  for (const k of Object.keys(env)) if (dshEnvDrop(k)) delete env[k];
  delete env.DEEPSEEK_API_KEY;
  if (key) env.DEEPSEEK_API_KEY = key;
  env.DSH_PERMISSION_MODE = mode;
  env.DSH_TELEMETRY_MODE = "DISABLED";
  env.DSH_TELEMETRY_DISABLED = "1";
  // DSH_HOME PRÓPRIO do Starfork: nunca mexemos no ~/.dsh do usuário, e um modelo salvo lá (dsh web) não
  // sobrepõe a escolha feita no app. Sessões (pro --session-id) ficam aqui também.
  env.DSH_HOME = dshHome(base);
  // o node do PATH tem que ser o ESCOLHIDO pelo app: a pasta dele vai pra frente mesmo se já estava mais atrás
  const dirs = [dirname(process.execPath), ...(bin.includes("/") || bin.includes("\\") ? [dirname(bin)] : [])].filter((d, i, a) => a.indexOf(d) === i);
  const cur = (env.PATH || "").split(delimiter).filter(Boolean);
  env.PATH = [...dirs, ...cur.filter((d) => !dirs.includes(d))].join(delimiter);
  return env;
}

/** Variável que NÃO vai pro dsh (mesma regra do Rust ai_once::dsh_env_drop): *_API_KEY/*_TOKEN/*_SECRET e marcadores do Claude Code. */
export function dshEnvDrop(k: string): boolean {
  if (k === "DEEPSEEK_API_KEY") return false;
  return /(_API_KEY|_TOKEN|_SECRET)$/i.test(k) || /^CLAUDECODE/.test(k) || /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT)$/.test(k);
}

/** Pasta do dsh usada pelo Starfork (CARDUME_DSH_HOME só pra testes). */
export function dshHome(base: NodeJS.ProcessEnv = process.env): string {
  return String(base.CARDUME_DSH_HOME ?? "").trim() || join(homedir(), ".constellation", "dsh", "home");
}

/** Patch FIXO do Starfork: upload de log de sessão pra DeepSeek e OTel desligados (privacidade por padrão). */
export function basePatchYaml(): string {
  return [
    "# Starfork — gerado automaticamente a cada execução (não edite: o app reescreve).",
    "# Envio de logs de sessão pra DeepSeek DESLIGADO por padrão.",
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- id: session-telemetry-otel",
    "  disabled: true",
    "# título da sessão por IA = uma chamada extra ao modelo a cada turno (tokens à toa)",
    "- id: session-title-llm",
    "  disabled: true",
    "",
  ].join("\n");
}

export interface DshMcp {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * Patch POR TURNO: modelo + (tarefa) MCP do Starfork via stdio. Valores em JSON (subconjunto válido de YAML):
 * nada de `!!js`, aspas e quebras de linha escapadas — um caminho com espaço/aspas não vira código.
 */
export function runPatchYaml(o: { model: string; mcp?: DshMcp }): string {
  const lines = [
    "# Starfork — gerado (não edite).",
    "- id: agent-default-model",
    `  config: ${JSON.stringify({ provider: "deepseek-official", model: o.model })}`,
  ];
  if (o.mcp) {
    const cfg = {
      serverName: "cardume",
      transport: "stdio",
      command: o.mcp.command,
      args: o.mcp.args,
      env: o.mcp.env,
      cwd: o.mcp.cwd,
      // ask_human ESPERA o humano (minutos/horas): o padrão de 60s do dsh cortaria a pergunta
      toolCallTimeoutMs: 24 * 60 * 60 * 1000,
    };
    lines.push("- insert:", "    - id: starfork-mcp", "      name: '@deepseek-ai/dsh-mcp-client'", `      config: ${JSON.stringify(cfg)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Grava o patch fixo em ~/.constellation/dsh/starfork.patch.yml (0600) e devolve o caminho. Só reescreve se o
 * conteúdo mudou, via arquivo temporário + rename ATÔMICO: um dsh em paralelo nunca lê o arquivo vazio (e roda
 * COM upload de log/OTel ligados).
 */
export function writeBasePatch(): string {
  const dir = join(homedir(), ".constellation", "dsh");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "starfork.patch.yml");
  const want = basePatchYaml();
  let cur: string | null = null;
  try { cur = readFileSync(p, "utf8"); } catch { /* ainda não existe */ }
  if (cur === want) {
    try { chmodSync(p, 0o600); } catch { /* best-effort */ }
    return p;
  }
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, want, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, p);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* já renomeado */ }
  }
  return p;
}

/** Overlay extra opcional (CARDUME_DSH_PATCH, ex.: provider OpenAI-compatível próprio ou o servidor falso dos testes) — por último, vence. */
export function extraPatch(): string[] {
  const p = String(process.env.CARDUME_DSH_PATCH ?? "").trim();
  return p && existsSync(p) ? [p] : [];
}

/** argv do dsh — a chave NUNCA vai aqui; o prompt vai pelo STDIN. */
export function dshArgs(patches: string[], sessionId?: string): string[] {
  const a: string[] = [];
  for (const p of patches) a.push("--patch", p);
  a.push("--profile", "headless", "--json");
  if (sessionId) a.push("--session-id", sessionId);
  return a;
}

/** Caminho do servidor MCP do Starfork (mesma regra do ClaudeEngine: dev .ts ao lado do fonte; app empacotado .mjs). */
export function starforkMcpServerPath(): string {
  if (process.env.CARDUME_MCP && existsSync(process.env.CARDUME_MCP)) return process.env.CARDUME_MCP;
  for (const rel of ["../mcp/server.ts", "../mcp/server.mjs"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
}

export function starforkMcp(input: RunInput): DshMcp {
  return {
    command: process.execPath,
    args: [...process.execArgv.filter((a) => a === "--experimental-sqlite"), "--disable-warning=ExperimentalWarning", starforkMcpServerPath()],
    env: {
      CARDUME_DB: input.dbFile,
      CARDUME_TASK: input.spec.id,
      CARDUME_ROLE: String(input.role ?? ""),
      CARDUME_AGENT: input.agentName,
      CARDUME_ASK_TIMEOUT_MIN: String(input.askTimeoutMin ?? 0),
      // piloto automático: o ask_human responde sozinho (sem humano) — igual ao Claude (engine/claude.ts). Sem
      // isto o DeepSeek ficava esperando um humano que não existe (CARDUME_ASK_TIMEOUT_MIN=0 = pra sempre).
      ...(process.env.CARDUME_AUTOPILOT === "1" ? { CARDUME_AUTOPILOT: "1" } : {}),
    },
    cwd: input.cwd,
  };
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
const ASK_RULE =
  " Você tem as tools mcp__cardume__ask_human (pergunte ao humano em caso de dúvida e AGUARDE a resposta) e mcp__cardume__claim (reivindique um caminho antes de editar fora do seu escopo). Se não entendeu algo ou NÃO CONSEGUIR cumprir um requisito, pergunte via mcp__cardume__ask_human — nunca invente nem entregue silenciosamente sem um requisito.";
const GROUND_RULE =
  " EXECUTE ANTES DE AFIRMAR: rode o projeto/testes de verdade nesta worktree (envs semeadas — veja .cardume/AMBIENTE.md) antes de qualquer conclusão; leitura de código não é verificação. Scripts descartáveis em .cardume/tmp/ (fora do diff). NUNCA abra Pull Request por conta própria.";

export function buildDshPrompt(input: RunInput): string {
  const protect = protectEnabled() ? PROTECT_RULE : "";
  if (input.resume) return input.resume.instruction + (input.skillsRule ?? "") + GROUND_RULE + protect;
  if (input.promptOverride) return input.promptOverride + ASK_RULE + GROUND_RULE + protect;
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
  const base = `Leia .cardume/TASK.yaml e execute a tarefa. ${roleInstr}${refRule}${artifactRule}${reqRule}${ASK_RULE}${GROUND_RULE}${protect}`;
  // o headless não tem "append system prompt": o contexto do barramento vai no próprio pedido (como no Codex)
  return base + (input.systemContext ? `\n\nCONTEXTO DO BARRAMENTO:\n${input.systemContext}` : "");
}

/** Estado de UM turno (compartilhado entre as linhas). */
export interface DshTurnState {
  inTok: number;
  outTok: number;
  /** turn_end com motivo ≠ completed (ou evento error) — o `final` que vem depois não é "concluído". */
  failed: boolean;
  /** texto do `final` (lossless) — a resposta do turno. */
  final?: string;
  /** callIds de ask_human ainda sem tool_result: esperando o humano (não é inatividade). */
  openAsks: Set<string>;
}
export const newDshState = (): DshTurnState => ({ inTok: 0, outTok: 0, failed: false, openAsks: new Set() });

/** Regras de erro ÚNICAS (as mesmas regex no Rust ai_once::dsh_friendly_error; golden em tests/fixtures/ai-once-golden/dsh.json). */
export const DSH_ERR_KEY = /missing_credential|\b401\b|unauthorized|api[ _-]?key|authentication/i;
export const DSH_ERR_QUOTA = /\b429\b|\b402\b|rate[ _-]?limit|quota|insufficient[ _-]?balance/i;
export const DSH_ERR_NET = /network|timed out|econn|fetch failed|\bconnection\b/i;

/** "session X does not exist" / gravada em outra pasta → texto que o orquestrador reconhece (sessão nova + aviso). */
export function dshErrText(msg: string): string {
  const m = String(msg ?? "").trim();
  const sid = m.match(/session "([^"]*)" (does not exist|was recorded in|recorded no working directory)/);
  if (sid) return `session ${sid[1]} not found — a sessão anterior do DeepSeek não pode ser retomada (${m.slice(0, 200)})`;
  if (DSH_ERR_KEY.test(m) || /DEEPSEEK_API_KEY/.test(m)) return `${DSH_KEY_MSG.replace(/\.$/, "")} ou confira se ela é válida. (${m.slice(0, 200)})`;
  return m.slice(0, 400);
}

/** Uma linha JSONL do `dsh --profile headless --json` → AgentEvents. O `done` só sai no `final` de um turno concluído. */
export function mapDshLine(line: string, st: DshTurnState = newDshState()): AgentEvent[] {
  const s = line.trim();
  if (!s) return [];
  let o: Record<string, any>;
  try {
    o = JSON.parse(s);
  } catch {
    return [{ type: "note", text: s.slice(0, 300) }];
  }
  const t = String(o?.type ?? "");
  if (t === "session") {
    const id = typeof o.sessionId === "string" ? o.sessionId : "";
    return id ? [{ type: "session", text: id }] : [];
  }
  if (t === "status") {
    const phase = String(o.phase ?? "");
    if (phase === "step_end" && o.usage && typeof o.usage === "object") {
      st.inTok += Number(o.usage.inputTokens) || 0;
      st.outTok += Number(o.usage.outputTokens) || 0;
      return [];
    }
    if (phase === "turn_end") {
      const r = o.reason && typeof o.reason === "object" ? o.reason : { kind: String(o.reason ?? "") };
      const kind = String(r.kind ?? "");
      if (!kind || kind === "completed") return [];
      st.failed = true;
      if (kind === "error") {
        const e = r.error && typeof r.error === "object" ? r.error : {};
        const msg = [e.code, e.message].filter(Boolean).join(": ") || "o DeepSeek terminou o turno com erro";
        return [{ type: "error", text: dshErrText(msg), status: "error" }];
      }
      if (kind === "max-tokens") return [{ type: "error", text: "o DeepSeek parou no token limit de saída (max-tokens)", status: "error" }];
      return [{ type: "error", text: `turno do DeepSeek encerrado (${kind})`, status: "error" }];
    }
    return [];
  }
  if (t === "thinking") return o.text ? [{ type: "think", text: String(o.text).slice(0, 400) }] : [];
  if (t === "text") return String(o.text ?? "").trim() ? [{ type: "note", text: String(o.text).trim().slice(0, 1200) }] : [];
  if (t === "tool_call") {
    const input = o.input && typeof o.input === "object" ? o.input : {};
    if (/ask_human/i.test(String(o.tool ?? ""))) st.openAsks.add(String(o.callId ?? ""));
    return [mapTool(String(o.tool ?? ""), input)];
  }
  if (t === "tool_result") {
    st.openAsks.delete(String(o.callId ?? ""));
    if (o.status !== "error") return [];
    return [{ type: "note", text: `ferramenta falhou: ${String(o.result ?? "").slice(0, 200)}` }];
  }
  if (t === "error") {
    st.failed = true;
    return [{ type: "error", text: dshErrText(String(o.message ?? "erro do DeepSeek")), status: "error" }];
  }
  if (t === "final") {
    st.final = String(o.text ?? "");
    if (st.failed) return [];
    return [{
      type: "done",
      text: st.final.trim() ? st.final.trim().slice(0, 4000) : "deepseek finalizou",
      status: "review",
      cost: { usd: 0, inTok: st.inTok, outTok: st.outTok },
    }];
  }
  return [];
}

export class DshEngine implements AgentEngine {
  id = "deepseek";
  displayName = "DeepSeek (beta)";
  private model: string;
  private bin?: string;
  private idleMs: number;

  /** `bin`/`idleMs`: ganchos de teste (binário forçado, mesmo que não exista; limite de inatividade). */
  constructor(opts: { model?: string; bin?: string; idleMs?: number } = {}) {
    // tarefa sem modelo escolhido (ou com alias do Claude vindo do #ntModel) → o "capaz" do catálogo
    this.model = dshModelFor(opts.model, "capaz");
    this.bin = opts.bin;
    this.idleMs = opts.idleMs ?? 30 * 60 * 1000;
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const t0 = Date.now();
    yield { type: "status", text: `iniciando ${this.displayName} (${this.model})`, status: "running" };
    // mesma ordem do dshAvail/dsh_status: binário → node → chave (e nada é gravado antes)
    const bin = this.bin ?? resolveDsh();
    if (!dshBinExists(bin)) {
      yield { type: "error", text: DSH_MISSING_MSG, status: "error" };
      return;
    }
    if (!dshNodeOk()) {
      yield { type: "error", text: dshNodeMsg(process.versions.node), status: "error" };
      return;
    }
    const llm = loadLlmEnv();
    const key = dshKey(llm);
    if (!key) {
      yield { type: "error", text: DSH_KEY_MSG, status: "error" };
      return;
    }
    let patches: string[];
    try {
      const runPatch = join(input.cwd, ".cardume", "dsh.patch.yml");
      mkdirSync(dirname(runPatch), { recursive: true });
      writeFileSync(runPatch, runPatchYaml({ model: this.model, mcp: starforkMcp(input) }), { encoding: "utf8", mode: 0o600 });
      patches = [writeBasePatch(), runPatch, ...extraPatch()];
    } catch (err) {
      yield { type: "error", text: `não consegui preparar a configuração do DeepSeek: ${(err as Error).message}`, status: "error" };
      return;
    }
    const sid = input.resume?.sessionId || "";
    const env = dshEnv(bin, key, "danger-full-access", process.env, llm);
    const sp = dshSpawnSpec(bin, dshArgs(patches, sid || undefined));
    const child = spawn(sp.cmd, sp.args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], env, windowsVerbatimArguments: sp.verbatim });
    child.stdin.on("error", () => { /* saiu antes de ler o prompt — o 'close' conta a história */ });
    child.stdin.end(buildDshPrompt(input));
    const rl = createInterface({ input: child.stdout });

    const queue: AgentEvent[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
    const st = newDshState();
    let exited = false;
    let sawDone = false;
    let sawError = false;
    let lastStderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { clearTimeout(killTimer); clearTimeout(doneTimer); clearTimeout(closeTimer); done = true; wake(); };
    const armDoneTimer = () => {
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => {
        if (exited) return;
        queue.push({ type: "note", text: "o DeepSeek concluiu o turno mas não fechou sozinho — processo encerrado" });
        killProcess(child, () => exited);
        finish();
      }, exitGraceMs());
    };
    const idleMs = this.idleMs;
    const resetIdle = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        // esperando o humano (ask_human sem resposta) NÃO é inatividade — o MCP espera até 24h
        if (st.openAsks.size > 0) { resetIdle(); return; }
        queue.push({ type: "error", text: `inatividade de ${Math.round(idleMs / 60000)}min — DeepSeek encerrado`, status: "error" });
        killProcess(child, () => exited);
        finish();
      }, idleMs);
      if ((sawDone || st.final !== undefined) && !exited) armDoneTimer();
    };
    resetIdle();

    rl.on("line", (line) => {
      resetIdle();
      for (const ev of mapDshLine(line, st)) {
        if (ev.type === "done") { if (sawDone) continue; sawDone = true; armDoneTimer(); }
        if (ev.type === "error") sawError = true;
        queue.push(ev);
      }
      if (st.final !== undefined && !sawDone) armDoneTimer(); // final de turno falho: só falta o processo sair
      wake();
    });
    child.stderr.on("data", (d) => {
      resetIdle();
      const s = String(d).trim();
      if (!s) return;
      lastStderr = s.slice(-400);
      // as linhas "dsh: <código>: <msg>" repetem o erro que o --json já mandou; o resto vira nota
      if (!/^dsh: /m.test(s)) queue.push({ type: "note", text: `stderr: ${s.slice(0, 200)}` });
      wake();
    });
    const pushExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (sawDone || done) return;
      if (code === 0 && !st.failed) queue.push({ type: "done", text: "deepseek finalizou", status: "review", cost: { usd: 0, inTok: st.inTok, outTok: st.outTok } });
      else if (!sawError) {
        const why = lastStderr.replace(/^dsh: /, "").trim();
        queue.push({ type: "error", text: why ? dshErrText(why) : `dsh saiu com código ${code ?? signal}`, status: "error" });
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
    child.on("close", (code, signal) => { pushExit(code, signal); finish(); });
    child.on("error", (err) => {
      exited = true;
      const e = err as NodeJS.ErrnoException;
      queue.push({ type: "error", text: e.code === "ENOENT" ? DSH_MISSING_MSG : `falha ao iniciar o dsh: ${e.message}`, status: "error" });
      sawError = true;
      finish();
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) { await new Promise<void>((r) => { notify = r; }); continue; }
        const ev = queue.shift()!;
        if (ev.cost && !ev.cost.ms) ev.cost.ms = Date.now() - t0;
        yield ev;
      }
    } finally {
      clearTimeout(killTimer);
      clearTimeout(doneTimer);
      clearTimeout(closeTimer);
      if (!exited) killProcess(child, () => exited);
    }
  }
}
