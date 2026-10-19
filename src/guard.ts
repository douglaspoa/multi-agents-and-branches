/**
 * GUARDA DE SEGURANÇA NO DIFF (Frente 2 do plano de dores 2026).
 *
 * `protect.ts` impede o agente de LER `.env`/chaves; aqui é o outro lado: varre o que o agente ESCREVEU (só os arquivos
 * mudados na branch) antes de a entrega passar pelo portão.
 *  - gitleaks: segredo no diff BLOQUEIA a entrega (a política da org pode rebaixar pra aviso). O motivo leva arquivo e
 *    linha com o valor mascarado (4 primeiros caracteres + ••••) e diz ao agente o que fazer.
 *  - semgrep (opcional, só se já estiver instalado): severidade alta bloqueia; média/baixa vira item da Revisão.
 *  - falso positivo: `.cardume/guard-ignore.json` (versionado) com { fingerprint, motivo, por, em }.
 *  - guarda indisponível (sem binário, hash ruim, timeout, sem rede): NÃO bloqueia, mas sempre aparece em `skipped`
 *    ("guarda desligada: <motivo>") — nunca passa calada.
 *
 * O gitleaks é baixado sob demanda para ~/.cardume/bin, da release oficial com versão e SHA256 FIXOS aqui. O download
 * fica atrás de `deps.download` (injetável): os testes nunca baixam nada.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { run } from "./util/run.ts";

// ---------------------------------------------------------------- versão e hashes fixados

/** Versão FIXA do gitleaks baixado sob demanda (release oficial gitleaks/gitleaks, publicada em 21/03/2026). */
export const GITLEAKS_VERSION = "8.30.1";
/**
 * SHA256 de cada arquivo da release, copiados do `gitleaks_8.30.1_checksums.txt` oficial
 * (https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt).
 * Chave = `${process.platform}-${process.arch}`.
 */
export const GITLEAKS_ASSETS: Record<string, { file: string; sha256: string }> = {
  "darwin-arm64": { file: "gitleaks_8.30.1_darwin_arm64.tar.gz", sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" },
  "darwin-x64": { file: "gitleaks_8.30.1_darwin_x64.tar.gz", sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" },
  "linux-x64": { file: "gitleaks_8.30.1_linux_x64.tar.gz", sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" },
  "win32-x64": { file: "gitleaks_8.30.1_windows_x64.zip", sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e" },
};
export const gitleaksUrl = (file: string): string => `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${file}`;

/** Teto por ferramenta. A meta é bem menos (< 15 s num diff de 20 arquivos). */
export const GUARD_TIMEOUT_MS = 60_000;
/** Arquivo versionado com os falsos positivos dispensados. */
export const GUARD_IGNORE_REL = ".cardume/guard-ignore.json";
/** Arquivo maior que isso não é varrido (bundle/minificado/binário grande): fica lento e não é código escrito. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Teto de arquivos por varredura (diff gigante não trava o portão). */
const MAX_FILES = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", ".cardume"]);

// ---------------------------------------------------------------- tipos

export type GuardSeverity = "alta" | "media" | "baixa";
export interface GuardFinding {
  tool: "gitleaks" | "semgrep";
  /** segredo (gitleaks) ou código (semgrep) */
  kind: "segredo" | "codigo";
  severity: GuardSeverity;
  file: string;
  line: number;
  /** regra que achou (RuleID do gitleaks / check_id do semgrep) */
  rule: string;
  /** frase curta do que é — NUNCA o valor do segredo */
  message: string;
  /** segredo: 4 primeiros caracteres + •••• */
  masked?: string;
  /** identidade estável pro "dispensar" (arquivo:regra:linha, igual ao do gitleaks) */
  fingerprint: string;
  /** este achado reprova a entrega? */
  blocks: boolean;
}
export interface GuardIgnore { fingerprint: string; motivo: string; por: string; em: string }
export interface GuardPolicy { guard?: { secretsBlock?: boolean; codeHighBlock?: boolean } | null }
export interface GuardResult {
  /** motivos que REPROVAM o portão (vazio = a guarda não bloqueia) */
  reasons: string[];
  /** achados que contam (já sem os dispensados) */
  findings: GuardFinding[];
  /** "guarda desligada: <motivo>" — ferramenta que não rodou */
  skipped: string[];
  /** quantos achados foram dispensados pelo guard-ignore.json */
  ignored: number;
  at: number;
  ms: number;
}

export interface ToolRun { code: number; stdout: string; stderr: string; timedOut: boolean; error?: string }
export interface GuardDeps {
  /** baixa a URL para `dest` (o hash é conferido DEPOIS, aqui). Ausente = download real (fetch). */
  download?: (url: string, dest: string) => Promise<void>;
  /** roda um binário (testes podem trocar) */
  exec?: (bin: string, args: string[], opts: { cwd?: string; timeout: number }) => Promise<ToolRun>;
  /** pasta dos binários baixados (padrão ~/.cardume/bin) */
  binDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** pastas além do PATH onde procurar (padrão: Homebrew, /usr/local/bin, ~/.local/bin; testes passam []) */
  extraDirs?: string[];
  /** troca os hashes fixos (só testes: arquivo de mentira com hash conhecido) */
  assets?: Record<string, { file: string; sha256: string }>;
}
export interface GuardInput {
  worktree: string;
  base?: string;
  files: string[];
  policy?: GuardPolicy | null;
  /** chamado com o resultado (o orquestrador grava o evento e a spec) */
  onResult?: (r: GuardResult) => void;
  deps?: GuardDeps;
}

// ---------------------------------------------------------------- puras

/** Só os 4 primeiros caracteres e depois ••••. Valor curto (≤ 8) não mostra nada: 4 de 6 já entregaria a chave. */
export function maskSecret(secret: string): string {
  const s = String(secret ?? "").trim();
  return s.length > 8 ? s.slice(0, 4) + "••••" : "••••";
}

export const fingerprintOf = (file: string, rule: string, line: number): string => `${file}:${rule}:${line}`;

/** Lê o guard-ignore.json (lista ou { list }); lixo/ausente → []. */
export function readIgnores(worktree: string): GuardIgnore[] {
  try {
    const raw = JSON.parse(readFileSync(join(worktree, GUARD_IGNORE_REL), "utf8"));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.list) ? raw.list : [];
    return list.filter((x: GuardIgnore) => x && typeof x.fingerprint === "string" && x.fingerprint.trim());
  } catch {
    return [];
  }
}

/** Acrescenta (ou atualiza) um dispensado — pura; o front tem a mesma regra (63-revisao-pr: gdAddIgnore). */
export function addIgnore(list: GuardIgnore[], entry: GuardIgnore): GuardIgnore[] {
  const out = (Array.isArray(list) ? list : []).filter((x) => x && x.fingerprint !== entry.fingerprint);
  out.push({ fingerprint: entry.fingerprint, motivo: String(entry.motivo || "").trim(), por: String(entry.por || "").trim() || "Você", em: entry.em || new Date().toISOString() });
  return out;
}

/** Severidade do semgrep → alta/média/baixa (ERROR/HIGH/CRITICAL = alta; WARNING/MEDIUM = média; resto = baixa). */
export function semgrepSeverity(sev: unknown, meta?: Record<string, unknown>): GuardSeverity {
  const s = String(sev ?? "").toUpperCase();
  const impact = String((meta && (meta.impact ?? meta.severity)) ?? "").toUpperCase();
  if (s === "ERROR" || s === "HIGH" || s === "CRITICAL" || impact === "HIGH" || impact === "CRITICAL") return "alta";
  if (s === "WARNING" || s === "MEDIUM") return "media";
  return "baixa";
}

const normRel = (p: string): string => p.split(sep).join("/").replace(/^\.\//, "");

/** Relatório JSON do gitleaks → achados (o caminho volta relativo à worktree; o valor só mascarado). */
export function parseGitleaks(json: string, scanRoot: string, secretsBlock: boolean): GuardFinding[] {
  let arr: unknown;
  try { arr = JSON.parse(json || "[]"); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((r: Record<string, unknown>) => {
    const abs = String(r.File ?? "");
    let file = normRel(abs.startsWith(scanRoot) ? relative(scanRoot, abs) : abs);
    if (file.startsWith("/")) file = file.slice(1);
    const rule = String(r.RuleID ?? "segredo");
    const line = Number(r.StartLine) || 0;
    return {
      tool: "gitleaks" as const, kind: "segredo" as const, severity: "alta" as const, file, line, rule,
      message: String(r.Description ?? "segredo no código").slice(0, 160),
      masked: maskSecret(String(r.Secret ?? r.Match ?? "")),
      fingerprint: fingerprintOf(file, rule, line),
      blocks: secretsBlock,
    };
  });
}

/** Saída `--json` do semgrep → achados. */
export function parseSemgrep(json: string, highBlocks: boolean): GuardFinding[] {
  let o: { results?: Array<Record<string, any>> };
  try { o = JSON.parse(json || "{}"); } catch { return []; }
  return (Array.isArray(o.results) ? o.results : []).map((r) => {
    const file = normRel(String(r.path ?? ""));
    const rule = String(r.check_id ?? "semgrep");
    const line = Number(r.start?.line) || 0;
    const severity = semgrepSeverity(r.extra?.severity, r.extra?.metadata);
    return {
      tool: "semgrep" as const, kind: "codigo" as const, severity, file, line, rule,
      message: String(r.extra?.message ?? rule).replace(/\s+/g, " ").trim().slice(0, 200),
      fingerprint: fingerprintOf(file, rule, line),
      blocks: highBlocks && severity === "alta",
    };
  });
}

/** O motivo que volta pro agente (e aparece no portão). */
export function findingReason(f: GuardFinding): string {
  if (f.kind === "segredo") return `segredo no código em ${f.file}:${f.line} (${f.masked ?? "••••"}, ${f.rule}) — troque por variável de ambiente; nunca escreva o valor no código`;
  return `falha de segurança de severidade alta em ${f.file}:${f.line} (${f.rule}): ${f.message} — corrija o código (não basta esconder o aviso)`;
}

/** Junta tudo: tira os dispensados e monta os motivos que reprovam. Pura. */
export function decide(all: GuardFinding[], ignores: GuardIgnore[], skipped: string[]): Pick<GuardResult, "reasons" | "findings" | "skipped" | "ignored"> {
  const ig = new Set(ignores.map((x) => x.fingerprint));
  const findings = all.filter((f) => !ig.has(f.fingerprint));
  return { reasons: findings.filter((f) => f.blocks).map(findingReason), findings, skipped, ignored: all.length - findings.length };
}

/** Uma linha de gente pro evento `guarda` (chat/cartões mostram o texto do último evento). */
export function guardSummary(r: Pick<GuardResult, "findings" | "skipped" | "ignored">): string {
  const sec = r.findings.filter((f) => f.kind === "segredo");
  const code = r.findings.filter((f) => f.kind === "codigo");
  const parts: string[] = [];
  if (sec.length) parts.push(`${sec.length} segredo(s) ${sec.some((f) => f.blocks) ? "bloqueiam a entrega" : "(só aviso pela política da organização)"} — ${sec.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(", ")}`);
  if (code.length) {
    const hi = code.filter((f) => f.blocks).length;
    parts.push(`${code.length} achado(s) de código${hi ? ` (${hi} de severidade alta bloqueia${hi > 1 ? "m" : ""})` : ""}`);
  }
  if (!sec.length && !code.length) parts.push("nada encontrado no diff");
  if (r.ignored) parts.push(`${r.ignored} dispensado(s)`);
  for (const s of r.skipped) parts.push(s);
  return "guarda: " + parts.join(" · ");
}

// ---------------------------------------------------------------- binários

const exeName = (name: string, platform: string): string => (platform === "win32" ? name + ".exe" : name);
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** Procura no PATH e nas pastas comuns (app aberto pelo Finder herda PATH mínimo). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, extraDirs?: string[]): string | null {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  dirs.push(...(extraDirs ?? (platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(env.HOME || homedir(), ".local", "bin")])));
  for (const d of dirs) { const p = join(d, exeName(name, platform)); if (isFile(p)) return p; }
  return null;
}

const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

async function realDownload(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(GUARD_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * gitleaks: GITLEAKS_BIN → ~/.cardume/bin/gitleaks → PATH → download sob demanda (hash conferido).
 * Nunca lança: `{ bin }` ou `{ off: "<motivo>" }`.
 */
export async function ensureGitleaks(deps: GuardDeps = {}): Promise<{ bin: string } | { off: string }> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (env.GITLEAKS_BIN) return isFile(env.GITLEAKS_BIN) ? { bin: env.GITLEAKS_BIN } : { off: `GITLEAKS_BIN aponta pra um arquivo que não existe (${env.GITLEAKS_BIN})` };
  const binDir = deps.binDir ?? join(env.HOME || homedir(), ".cardume", "bin");
  const local = join(binDir, exeName("gitleaks", platform));
  if (isFile(local)) return { bin: local };
  const onPath = findOnPath("gitleaks", env, platform, deps.extraDirs);
  if (onPath) return { bin: onPath };
  const asset = (deps.assets ?? GITLEAKS_ASSETS)[`${platform}-${arch}`];
  if (!asset) return { off: `gitleaks não instalado e não há download fixado pra ${platform}-${arch}` };
  // testes nunca baixam: sem downloader injetado, o modo de teste desliga o download real
  if (!deps.download && (env.STARFORK_GUARD_NO_DOWNLOAD || env.STARFORK_TEST_NO_AI)) return { off: "gitleaks não instalado (download desligado neste ambiente)" };
  const download = deps.download ?? realDownload;
  let archive = "";
  let stage = "";
  try {
    mkdirSync(binDir, { recursive: true });
    archive = join(binDir, `.baixando-${process.pid}-${asset.file}`);
    await download(gitleaksUrl(asset.file), archive);
    const got = sha256File(archive);
    if (got !== asset.sha256) {
      rmSync(archive, { force: true });
      return { off: `o gitleaks baixado não confere com o hash fixado (esperado ${asset.sha256.slice(0, 12)}…, veio ${got.slice(0, 12)}…) — apaguei o arquivo` };
    }
    stage = mkdtempSync(join(binDir, ".extrair-"));
    await run("tar", [asset.file.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", stage], { timeout: GUARD_TIMEOUT_MS });
    const extracted = join(stage, exeName("gitleaks", platform));
    if (!isFile(extracted)) return { off: "o pacote do gitleaks não tem o binário esperado" };
    if (platform !== "win32") chmodSync(extracted, 0o755);
    renameSync(extracted, local);
    return { bin: local };
  } catch (e) {
    return { off: `não consegui baixar o gitleaks (${String((e as Error)?.message ?? e).slice(0, 120)})` };
  } finally {
    if (archive) rmSync(archive, { force: true });
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

/** semgrep é opcional: SEMGREP_BIN → PATH. Nunca baixa. */
export function findSemgrep(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, extraDirs?: string[]): string | null {
  if (env.SEMGREP_BIN) return isFile(env.SEMGREP_BIN) ? env.SEMGREP_BIN : null;
  return findOnPath("semgrep", env, platform, extraDirs);
}

async function realExec(bin: string, args: string[], opts: { cwd?: string; timeout: number }): Promise<ToolRun> {
  try {
    const r = await run(bin, args, { cwd: opts.cwd, timeout: opts.timeout });
    return { code: 0, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  } catch (e) {
    const err = e as Error & { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; signal?: string };
    const code = typeof err.code === "number" ? err.code : -1;
    return { code, stdout: err.stdout ?? "", stderr: err.stderr ?? "", timedOut: !!err.killed || err.signal === "SIGTERM", error: code === -1 ? String(err.message ?? err) : undefined };
  }
}

// ---------------------------------------------------------------- execução

/** Arquivos que valem varrer: existem, são arquivos, não são da pasta do Starfork nem enormes. */
export function scanTargets(worktree: string, files: string[]): string[] {
  const out = new Set<string>();
  const add = (f: string, depth: number): void => {
    if (!f || f === ".cardume" || f.startsWith(".cardume/") || f.split("/").includes("..") || out.size >= MAX_FILES) return;
    try {
      const s = statSync(join(worktree, f));
      if (s.isFile()) { if (s.size <= MAX_FILE_BYTES) out.add(f); return; }
      // pasta nova inteira: o `git status --porcelain` mostra só "?? pasta/" — entra arquivo por arquivo
      if (s.isDirectory() && depth < 12) for (const e of readdirSync(join(worktree, f))) if (!SKIP_DIRS.has(e)) add(f + "/" + e, depth + 1);
    } catch { /* apagado */ }
  };
  for (const f0 of files) add(normRel(String(f0 || "").trim().replace(/^"|"$/g, "")).replace(/\/+$/, ""), 0);
  return [...out];
}

async function runGitleaks(worktree: string, files: string[], secretsBlock: boolean, deps: GuardDeps): Promise<{ findings: GuardFinding[]; off?: string }> {
  const g = await ensureGitleaks(deps);
  if ("off" in g) return { findings: [], off: `guarda de segredos desligada: ${g.off}` };
  // cópia só dos arquivos mudados (caminhos relativos mantidos): o gitleaks varre a pasta inteira
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "starfork-guarda-"));
  try {
    const src = join(tmp, "src");
    for (const f of files) { const to = join(src, f); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(worktree, f), to); }
    const report = join(tmp, "relatorio.json");
    const exec = deps.exec ?? realExec;
    const r = await exec(g.bin, ["detect", "--no-git", "--no-banner", "--report-format", "json", "--report-path", report, "--source", src], { cwd: tmp, timeout: GUARD_TIMEOUT_MS });
    if (r.timedOut) return { findings: [], off: `guarda de segredos desligada: o gitleaks passou de ${GUARD_TIMEOUT_MS / 1000}s` };
    // 0 = nada; 1 = achou (padrão do --exit-code). Outro código = o gitleaks falhou.
    if (r.code !== 0 && r.code !== 1) return { findings: [], off: `guarda de segredos desligada: o gitleaks falhou (${(r.error || r.stderr || `código ${r.code}`).trim().slice(0, 140)})` };
    let json = "[]";
    try { json = readFileSync(report, "utf8"); } catch { if (r.code === 1) return { findings: [], off: "guarda de segredos desligada: o gitleaks não gerou o relatório" }; }
    return { findings: parseGitleaks(json, src, secretsBlock) };
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // o relatório tem o segredo em claro: nunca fica no disco
  }
}

async function runSemgrep(worktree: string, files: string[], highBlocks: boolean, deps: GuardDeps): Promise<{ findings: GuardFinding[]; off?: string }> {
  const bin = findSemgrep(deps.env ?? process.env, deps.platform ?? process.platform, deps.extraDirs);
  if (!bin) return { findings: [], off: "guarda de código desligada (semgrep não instalado)" };
  const exec = deps.exec ?? realExec;
  const r = await exec(bin, ["--config", "p/owasp-top-ten", "--json", "--quiet", ...files], { cwd: worktree, timeout: GUARD_TIMEOUT_MS });
  if (r.timedOut) return { findings: [], off: `guarda de código desligada: o semgrep passou de ${GUARD_TIMEOUT_MS / 1000}s` };
  let parsed: { results?: unknown[]; errors?: Array<{ message?: string }> } | null = null;
  try { parsed = JSON.parse(r.stdout || "null"); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.results)) {
    const why = (r.error || r.stderr || (parsed?.errors?.[0]?.message ?? "") || `código ${r.code}`).trim();
    const net = /network|connection|resolve|timed? ?out|ssl|certificate|registry|fetch|download/i.test(why);
    return { findings: [], off: `guarda de código indisponível${net ? " (sem rede pra baixar as regras)" : ""}: ${why.slice(0, 140)}` };
  }
  return { findings: parseSemgrep(r.stdout, highBlocks) };
}

/** O guard-ignore.json precisa ir junto na branch, mas `.cardume/` está no exclude do git: rastreia à força. */
async function trackIgnoreFile(worktree: string): Promise<void> {
  if (!existsSync(join(worktree, GUARD_IGNORE_REL))) return;
  try { await run("git", ["-C", worktree, "ls-files", "--error-unmatch", GUARD_IGNORE_REL]); return; } catch { /* não rastreado */ }
  try { await run("git", ["-C", worktree, "add", "-f", GUARD_IGNORE_REL]); } catch { /* sem git: fica só local */ }
}

/**
 * Roda a guarda nos arquivos mudados. Nunca lança — erro inesperado vira "guarda desligada" em `skipped`.
 * gitleaks e semgrep rodam em paralelo.
 */
export async function runGuard(input: GuardInput): Promise<GuardResult> {
  const t0 = Date.now();
  const deps = input.deps ?? {};
  const secretsBlock = input.policy?.guard?.secretsBlock !== false;
  const codeHighBlock = input.policy?.guard?.codeHighBlock !== false;
  let result: GuardResult;
  try {
    const files = scanTargets(input.worktree, input.files ?? []);
    if (!files.length) {
      result = { reasons: [], findings: [], skipped: [], ignored: 0, at: Date.now(), ms: Date.now() - t0 };
    } else {
      const [gl, sg] = await Promise.all([
        runGitleaks(input.worktree, files, secretsBlock, deps),
        runSemgrep(input.worktree, files, codeHighBlock, deps),
      ]);
      const skipped = [gl.off, sg.off].filter((x): x is string => !!x);
      await trackIgnoreFile(input.worktree);
      result = { ...decide([...gl.findings, ...sg.findings], readIgnores(input.worktree), skipped), at: Date.now(), ms: Date.now() - t0 };
    }
  } catch (e) {
    result = { reasons: [], findings: [], skipped: [`guarda desligada: ${String((e as Error)?.message ?? e).slice(0, 140)}`], ignored: 0, at: Date.now(), ms: Date.now() - t0 };
  }
  try { input.onResult?.(result); } catch { /* gravar o evento é melhor-esforço */ }
  return result;
}
