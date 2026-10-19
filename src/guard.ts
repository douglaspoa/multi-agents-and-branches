/**
 * GUARDA DE SEGURANÇA NO DIFF (Frente 2 do plano de dores 2026).
 *
 * `protect.ts` impede o agente de LER `.env`/chaves; aqui é o outro lado: varre o que o agente ESCREVEU (só os arquivos
 * mudados na branch) antes de a entrega passar pelo portão.
 *  - gitleaks: segredo numa LINHA DO DIFF bloqueia a entrega (a política da org pode rebaixar pra aviso). O motivo leva
 *    arquivo e linha com o valor mascarado (4 primeiros caracteres + ••••) e diz ao agente o que fazer. Segredo que já
 *    estava na base vira só o aviso "segredo antigo no arquivo". Respeita o `.gitleaks.toml` e o `.gitleaksignore`.
 *  - semgrep (opcional, só se já estiver instalado): severidade alta numa linha do diff bloqueia; média/baixa vira item
 *    da Revisão. Regras de `p/owasp-top-ten` em cache local (~/.cardume/semgrep-rules, renovado a cada 7 dias),
 *    `--metrics=off`.
 *  - falso positivo: `.cardume/guard-ignore.json` (versionado) com { fingerprint, motivo, por, em, hmac }. SÓ vale a
 *    entrada assinada pelo APP: hmac = HMAC-SHA256(chave local ~/.cardume/guard.key, fingerprint), calculado no Rust
 *    (comando guard_dismiss). O agente escreve na worktree mas não tem como assinar pelo app — entrada sem hmac válido
 *    é ignorada e o achado continua contando.
 *  - fingerprint = arquivo:regra:hash(linha normalizada, com o segredo mascarado) — sobrevive a edições acima dela.
 *  - guarda indisponível (sem binário, hash ruim, timeout, sem rede): NÃO bloqueia, mas sempre aparece em `skipped`
 *    ("guarda desligada: <motivo>") — nunca passa calada.
 *  - O DOWNLOAD NUNCA ATRASA O PORTÃO: sem o gitleaks pronto, o portão sai na hora com "guarda desligada: preparando o
 *    gitleaks (1ª vez)" e o download segue num processo separado (versão e SHA256 FIXOS aqui). Nos testes, o download
 *    fica atrás de `deps.download` (injetável) — nada é baixado da internet.
 *  - Mesmo SHA + mesmos arquivos (e conteúdo) da última varredura da tarefa: reaproveita o resultado (cache em
 *    ~/.cardume/guard-cache, fora da worktree).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
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
/** Regras do semgrep baixadas uma vez (YAML do registro) e usadas por arquivo local. */
export const SEMGREP_RULES_URL = "https://semgrep.dev/c/p/owasp-top-ten";
export const SEMGREP_RULES_FILE = "owasp-top-ten.yml";
export const SEMGREP_RULES_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Teto por ferramenta. A meta é bem menos (< 15 s num diff de 20 arquivos). */
export const GUARD_TIMEOUT_MS = 60_000;
/** Arquivo versionado com os falsos positivos dispensados. */
export const GUARD_IGNORE_REL = ".cardume/guard-ignore.json";
/** Download que falhou: não tenta de novo antes disso (o portão diz o motivo). */
const RETRY_AFTER_MS = 3600_000;
/** Trava de download de outro processo mais velha que isso = processo morreu; pode tentar de novo. */
const LOCK_STALE_MS = 10 * 60_000;
/** Arquivo maior que isso não é varrido (bundle/minificado/binário grande): fica lento e não é código escrito. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Teto de arquivos por varredura (diff gigante não trava o portão). */
const MAX_FILES = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", ".cardume"]);
const CACHE_VERSION = 2;

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
  /** identidade estável pro "dispensar": arquivo:regra:hash da linha (sem o valor do segredo) */
  fingerprint: string;
  /** este achado reprova a entrega? */
  blocks: boolean;
  /** a linha NÃO está no diff da tarefa (já existia na base): só aviso */
  old?: boolean;
}
export interface GuardIgnore { fingerprint: string; motivo: string; por: string; em: string; hmac?: string }
export interface GuardPolicy { guard?: { secretsBlock?: boolean; codeHighBlock?: boolean } | null }
export interface GuardResult {
  /** motivos que REPROVAM o portão (vazio = a guarda não bloqueia) */
  reasons: string[];
  /** achados que contam (já sem os dispensados) */
  findings: GuardFinding[];
  /** "guarda desligada: <motivo>" — ferramenta que não rodou */
  skipped: string[];
  /** quantos achados foram dispensados (com assinatura válida do app) */
  ignored: number;
  /** dispensas no guard-ignore.json SEM assinatura válida do app (ignoradas) */
  unsigned?: number;
  /** reaproveitou a última varredura (mesmo SHA, arquivos e conteúdo) */
  cached?: boolean;
  at: number;
  ms: number;
}

export interface ToolRun { code: number; stdout: string; stderr: string; timedOut: boolean; error?: string }
export interface GuardDeps {
  /** baixa a URL para `dest`, NO PRÓPRIO PROCESSO (testes: servidor local / arquivo de mentira). Ausente = o download
   * real roda num processo separado (spawnPrepare), sem nunca segurar o portão. */
  download?: (url: string, dest: string) => Promise<void>;
  /** dispara o download em segundo plano (padrão: processo node destacado). Testes trocam pra ver que foi chamado. */
  spawnPrepare?: (args: PrepareArgs) => void;
  /** roda um binário (testes podem trocar) */
  exec?: (bin: string, args: string[], opts: { cwd?: string; timeout: number }) => Promise<ToolRun>;
  /** pasta do usuário (padrão HOME / os.homedir()) — daí saem ~/.cardume/{bin,semgrep-rules,guard-cache,guard.key} */
  home?: string;
  /** pasta dos binários baixados (padrão ~/.cardume/bin) */
  binDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** pastas além do PATH onde procurar (padrão: Homebrew, /usr/local/bin, ~/.local/bin; testes passam []) */
  extraDirs?: string[];
  /** troca os hashes fixos (só testes: arquivo de mentira com hash conhecido) */
  assets?: Record<string, { file: string; sha256: string }>;
  /** teto por ferramenta (padrão 60 s; testes usam menos) */
  timeoutMs?: number;
  now?: () => number;
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

// ---------------------------------------------------------------- caminhos

const homeOf = (deps: GuardDeps): string => deps.home ?? ((deps.env ?? process.env).HOME || homedir());
const cardumeDir = (deps: GuardDeps): string => join(homeOf(deps), ".cardume");
const binDirOf = (deps: GuardDeps): string => deps.binDir ?? join(cardumeDir(deps), "bin");
const rulesPathOf = (deps: GuardDeps): string => join(cardumeDir(deps), "semgrep-rules", SEMGREP_RULES_FILE);
/** Chave local do usuário pra assinar as dispensas — criada pelo app (Rust, guard_sign.rs) com permissão 600. */
export const guardKeyPath = (deps: GuardDeps = {}): string => join(cardumeDir(deps), "guard.key");
const nowOf = (deps: GuardDeps): number => (deps.now ? deps.now() : Date.now());

// ---------------------------------------------------------------- puras

/** Só os 4 primeiros caracteres e depois ••••. Valor curto (≤ 8) não mostra nada: 4 de 6 já entregaria a chave. */
export function maskSecret(secret: string): string {
  const s = String(secret ?? "").trim();
  return s.length > 8 ? s.slice(0, 4) + "••••" : "••••";
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Linha normalizada (o segredo vira •, espaço colapsado) — o que entra no hash da fingerprint. */
export function normLine(line: string, secret?: string): string {
  let s = String(line ?? "");
  if (secret && secret.length >= 4) s = s.split(secret).join("•");
  return s.replace(/\s+/g, " ").trim();
}
/** arquivo:regra:hash(linha) — independe do número da linha; nunca leva o valor do segredo. */
export const fingerprintOf = (file: string, rule: string, line: string, secret?: string): string =>
  `${file}:${rule}:${sha256(normLine(line, secret)).slice(0, 16)}`;

/** A assinatura do app: HMAC-SHA256(chave, fingerprint) em hex — ≡ guard_sign.rs (mesmo vetor nos testes dos dois). */
export function signFingerprint(key: string, fingerprint: string): string {
  return createHmac("sha256", Buffer.from(String(key).trim(), "utf8")).update(String(fingerprint)).digest("hex");
}
/** Chave local (null = o app ainda não dispensou nada nesta máquina → nenhuma dispensa vale). */
export function readGuardKey(deps: GuardDeps = {}): string | null {
  try { const k = readFileSync(guardKeyPath(deps), "utf8").trim(); return k.length >= 32 ? k : null; } catch { return null; }
}
const sameHex = (a: string, b: string): boolean => {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};
/** Separa as dispensas assinadas pelo app das que não valem (sem hmac, hmac errado, sem chave local). */
export function validIgnores(list: GuardIgnore[], key: string | null): { valid: GuardIgnore[]; unsigned: number } {
  const valid: GuardIgnore[] = [];
  let unsigned = 0;
  for (const x of list) {
    if (key && typeof x.hmac === "string" && sameHex(x.hmac.toLowerCase(), signFingerprint(key, x.fingerprint))) valid.push(x);
    else unsigned++;
  }
  return { valid, unsigned };
}

/** Lê o guard-ignore.json (lista ou { list }); lixo/ausente → []. Não confere assinatura (ver validIgnores). */
export function readIgnores(worktree: string): GuardIgnore[] {
  try {
    const raw = JSON.parse(readFileSync(join(worktree, GUARD_IGNORE_REL), "utf8"));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.list) ? raw.list : [];
    return list.filter((x: GuardIgnore) => x && typeof x.fingerprint === "string" && x.fingerprint.trim());
  } catch {
    return [];
  }
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
/** Caminho do relatório → relativo à raiz da cópia (o gitleaks real devolve absoluto quando a fonte é absoluta). */
export function relToRoot(p: string, root: string): string {
  let f = String(p ?? "");
  if (root && isAbsolute(f)) {
    const r = relative(root, f);
    f = r && !r.startsWith("..") ? r : f;
    if (isAbsolute(f)) {
      // /private/var ↔ /var no macOS: corta pelo último "/<raiz>/"
      const tail = root.split(sep).filter(Boolean).slice(-2).join("/");
      const i = f.split(sep).join("/").lastIndexOf("/" + tail + "/");
      f = i >= 0 ? f.split(sep).join("/").slice(i + tail.length + 2) : f.replace(/^[/\\]+/, "");
    }
  }
  return normRel(f).replace(/^\/+/, "");
}

/** Lê uma linha (1-based) de um arquivo da worktree — o que vai pro hash da fingerprint. */
type LineReader = (file: string, line: number) => string;
export function lineReader(worktree: string): LineReader {
  const cache = new Map<string, string[]>();
  return (file, line) => {
    let ls = cache.get(file);
    if (!ls) { try { ls = readFileSync(join(worktree, file), "utf8").split("\n"); } catch { ls = []; } cache.set(file, ls); }
    return ls[line - 1] ?? "";
  };
}

/** Relatório JSON do gitleaks → achados (caminho relativo, valor só mascarado, fingerprint sem número de linha). */
export function parseGitleaks(json: string, scanRoot: string, secretsBlock: boolean, readLine: LineReader = () => ""): GuardFinding[] {
  let arr: unknown;
  try { arr = JSON.parse(json || "[]"); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((r: Record<string, unknown>) => {
    const file = relToRoot(String(r.File ?? ""), scanRoot);
    const rule = String(r.RuleID ?? "segredo");
    const line = Number(r.StartLine) || 0;
    const secret = String(r.Secret ?? "");
    return {
      tool: "gitleaks" as const, kind: "segredo" as const, severity: "alta" as const, file, line, rule,
      message: String(r.Description ?? "segredo no código").slice(0, 160),
      masked: maskSecret(secret || String(r.Match ?? "")),
      fingerprint: fingerprintOf(file, rule, readLine(file, line) || String(r.Match ?? ""), secret),
      blocks: secretsBlock,
    };
  });
}

/** Saída `--json` do semgrep → achados. */
export function parseSemgrep(json: string, highBlocks: boolean, readLine: LineReader = () => ""): GuardFinding[] {
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
      fingerprint: fingerprintOf(file, rule, readLine(file, line) || String(r.extra?.lines ?? "")),
      blocks: highBlocks && severity === "alta",
    };
  });
}

/** Linhas tocadas pela tarefa: arquivo → linhas (worktree) ou "all" (arquivo novo). null = não deu pra saber (tudo conta). */
export type ChangedLines = Map<string, Set<number> | "all"> | null;
/** `git diff -U0` → arquivo → linhas adicionadas/alteradas (numeração do lado novo). */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  for (const l of String(diff ?? "").split("\n")) {
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).trim();
      if (p === "/dev/null") { cur = null; continue; }
      const f = p.replace(/^"?b\//, "").replace(/"$/, "");
      cur = out.get(f) ?? new Set<number>();
      out.set(f, cur);
      continue;
    }
    const m = cur && l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && cur) { const a = +m[1], n = m[2] === undefined ? 1 : +m[2]; for (let i = 0; i < n; i++) cur.add(a + i); }
  }
  return out;
}
/** O achado está numa linha que a tarefa tocou? */
export function inDiff(lines: ChangedLines, f: GuardFinding): boolean {
  if (!lines) return true;
  const s = lines.get(f.file);
  if (s === "all") return true;
  return !!s && s.has(f.line);
}
/** Achado fora do diff: não bloqueia e vira aviso "antigo". */
export function markOld(f: GuardFinding): GuardFinding {
  return { ...f, old: true, blocks: false, severity: "baixa", message: (f.kind === "segredo" ? "segredo antigo no arquivo (já estava na base): " : "código antigo (já estava na base): ") + f.message };
}

/** O motivo que volta pro agente (e aparece no portão). */
export function findingReason(f: GuardFinding): string {
  if (f.kind === "segredo") return `segredo no código em ${f.file}:${f.line} (${f.masked ?? "••••"}, ${f.rule}) — troque por variável de ambiente; nunca escreva o valor no código`;
  return `falha de segurança de severidade alta em ${f.file}:${f.line} (${f.rule}): ${f.message} — corrija o código (não basta esconder o aviso)`;
}

/** Junta tudo: tira os dispensados (já validados) e monta os motivos que reprovam. Pura. */
export function decide(all: GuardFinding[], ignores: GuardIgnore[], skipped: string[]): Pick<GuardResult, "reasons" | "findings" | "skipped" | "ignored"> {
  const ig = new Set(ignores.map((x) => x.fingerprint));
  const findings = all.filter((f) => !ig.has(f.fingerprint));
  return { reasons: findings.filter((f) => f.blocks).map(findingReason), findings, skipped, ignored: all.length - findings.length };
}

/** Uma linha de gente pro evento `guarda` (chat/cartões mostram o texto do último evento). */
export function guardSummary(r: Pick<GuardResult, "findings" | "skipped" | "ignored" | "unsigned">): string {
  const sec = r.findings.filter((f) => f.kind === "segredo" && !f.old);
  const old = r.findings.filter((f) => f.old);
  const code = r.findings.filter((f) => f.kind === "codigo" && !f.old);
  const parts: string[] = [];
  if (sec.length) parts.push(`${sec.length} segredo(s) ${sec.some((f) => f.blocks) ? "bloqueiam a entrega" : "(só aviso pela política da organização)"} — ${sec.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(", ")}`);
  if (code.length) {
    const hi = code.filter((f) => f.blocks).length;
    parts.push(`${code.length} achado(s) de código${hi ? ` (${hi} de severidade alta bloqueia${hi > 1 ? "m" : ""})` : ""}`);
  }
  if (old.length) parts.push(`${old.length} aviso(s) antigo(s) fora do diff`);
  if (!sec.length && !code.length && !old.length) parts.push("nada encontrado no diff");
  if (r.ignored) parts.push(`${r.ignored} dispensado(s)`);
  if (r.unsigned) parts.push(`${r.unsigned} dispensa(s) sem assinatura do app ignorada(s)`);
  for (const s of r.skipped) parts.push(s);
  return "guarda: " + parts.join(" · ");
}

// ---------------------------------------------------------------- binários e download (nunca no caminho do portão)

const exeName = (name: string, platform: string): string => (platform === "win32" ? name + ".exe" : name);
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** Procura no PATH e nas pastas comuns (app aberto pelo Finder herda PATH mínimo). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, extraDirs?: string[]): string | null {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  dirs.push(...(extraDirs ?? (platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(env.HOME || homedir(), ".local", "bin")])));
  for (const d of dirs) { const p = join(d, exeName(name, platform)); if (isFile(p)) return p; }
  return null;
}

/** O que o preparador (no processo ou destacado) precisa saber. kind "gitleaks": confere SHA256 e extrai; "rules": YAML. */
export interface PrepareArgs { kind: "gitleaks" | "rules"; url: string; sha256: string; file: string; destDir: string; exe: string }

/**
 * Script do preparador destacado (`node -e`): só módulos do node, roda fora do processo do portão. A trava (`.lock`,
 * criada com wx) impede dois downloads ao mesmo tempo entre processos; tudo é baixado numa pasta mkdtemp e só o
 * arquivo final entra com rename (ninguém vê binário pela metade); hash errado não instala nada e grava o motivo em
 * `.<kind>-erro.json` (o portão mostra e só tenta de novo depois de 1 h). Mesma regra de `prepareInProcess`.
 */
export const PREPARE_SCRIPT = `
const [kind, url, sha, file, destDir, exe] = process.argv.slice(1);
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const lock = path.join(destDir, "." + kind + ".lock"), errf = path.join(destDir, "." + kind + "-erro.json");
(async () => {
  try { fs.mkdirSync(destDir, { recursive: true }); fs.writeFileSync(lock, String(Date.now()), { flag: "wx" }); } catch { return; }
  let tmp = "";
  try {
    tmp = fs.mkdtempSync(path.join(destDir, ".baixando-"));
    const res = await fetch(url, { signal: AbortSignal.timeout(300000), redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (kind === "gitleaks") {
      if (got !== sha) throw new Error("o gitleaks baixado não confere com o hash fixado (esperado " + sha.slice(0, 12) + "…, veio " + got.slice(0, 12) + "…) — apaguei o arquivo");
      const arc = path.join(tmp, file);
      fs.writeFileSync(arc, buf);
      cp.execFileSync("tar", [file.endsWith(".zip") ? "-xf" : "-xzf", arc, "-C", tmp], { stdio: "ignore", timeout: 120000 });
      const bin = path.join(tmp, exe);
      if (!fs.existsSync(bin)) throw new Error("o pacote do gitleaks não tem o binário esperado");
      if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
      fs.renameSync(bin, path.join(destDir, exe));
    } else {
      const txt = buf.toString("utf8");
      if (!/^\\s*rules\\s*:/m.test(txt)) throw new Error("as regras do semgrep vieram num formato inesperado");
      const out = path.join(tmp, file);
      fs.writeFileSync(out, txt);
      fs.renameSync(out, path.join(destDir, file));
    }
    fs.rmSync(errf, { force: true });
  } catch (e) {
    try { fs.writeFileSync(errf, JSON.stringify({ at: Date.now(), why: String((e && e.message) || e).slice(0, 200) })); } catch {}
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
})();
`;

function spawnPrepareDetached(a: PrepareArgs): void {
  try {
    const cp = spawn(process.execPath, ["-e", PREPARE_SCRIPT, a.kind, a.url, a.sha256, a.file, a.destDir, a.exe], { detached: true, stdio: "ignore", windowsHide: true });
    cp.on("error", () => { /* sem node pra destacar: o próximo portão diz "preparando" de novo */ });
    cp.unref();
  } catch { /* idem */ }
}

/** Uma promessa por destino, por processo: duas tarefas no mesmo motor nunca baixam juntas. */
const preparing = new Map<string, Promise<void>>();

/** O mesmo do PREPARE_SCRIPT, no processo, com o download injetável (testes; ou quem quiser esperar o fim). */
async function prepareInProcess(a: PrepareArgs, download: (url: string, dest: string) => Promise<void>): Promise<void> {
  const lock = join(a.destDir, `.${a.kind}.lock`);
  const errf = join(a.destDir, `.${a.kind}-erro.json`);
  try { mkdirSync(a.destDir, { recursive: true }); writeFileSync(lock, String(Date.now()), { flag: "wx" }); } catch { return; }
  let tmp = "";
  try {
    tmp = mkdtempSync(join(a.destDir, ".baixando-"));
    const arc = join(tmp, a.file);
    await download(a.url, arc);
    if (a.kind === "gitleaks") {
      const got = sha256(readFileSync(arc));
      if (got !== a.sha256) throw new Error(`o gitleaks baixado não confere com o hash fixado (esperado ${a.sha256.slice(0, 12)}…, veio ${got.slice(0, 12)}…) — apaguei o arquivo`);
      await run("tar", [a.file.endsWith(".zip") ? "-xf" : "-xzf", arc, "-C", tmp], { timeout: 120_000 });
      const bin = join(tmp, a.exe);
      if (!isFile(bin)) throw new Error("o pacote do gitleaks não tem o binário esperado");
      if (process.platform !== "win32") chmodSync(bin, 0o755);
      renameSync(bin, join(a.destDir, a.exe));
    } else {
      if (!/^\s*rules\s*:/m.test(readFileSync(arc, "utf8"))) throw new Error("as regras do semgrep vieram num formato inesperado");
      renameSync(arc, join(a.destDir, a.file));
    }
    rmSync(errf, { force: true });
  } catch (e) {
    try { writeFileSync(errf, JSON.stringify({ at: Date.now(), why: String((e as Error)?.message ?? e).slice(0, 200) })); } catch { /* sem disco */ }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    rmSync(lock, { force: true });
  }
}

/** Erro recente do preparador (null = pode tentar). */
function recentError(destDir: string, kind: string, now: number): string | null {
  try {
    const e = JSON.parse(readFileSync(join(destDir, `.${kind}-erro.json`), "utf8"));
    return now - Number(e.at) < RETRY_AFTER_MS ? String(e.why || "erro desconhecido") : null;
  } catch { return null; }
}
/** Outro processo está baixando agora? (trava velha = processo morto: some) */
function lockBusy(destDir: string, kind: string, now: number): boolean {
  const p = join(destDir, `.${kind}.lock`);
  try {
    const at = Number(readFileSync(p, "utf8")) || statSync(p).mtimeMs;
    if (now - at < LOCK_STALE_MS) return true;
    rmSync(p, { force: true });
  } catch { /* sem trava */ }
  return false;
}

/** Dispara o preparo em segundo plano (memorizado por destino). Nunca espera. */
function kickPrepare(a: PrepareArgs, deps: GuardDeps): void {
  const key = `${a.kind}:${a.destDir}`;
  if (preparing.has(key)) return;
  if (deps.download) {
    const p = prepareInProcess(a, deps.download).finally(() => preparing.delete(key));
    preparing.set(key, p);
    return;
  }
  (deps.spawnPrepare ?? spawnPrepareDetached)(a);
  // processos destacados não avisam quando acabam: marca por 1 min pra não disparar a cada portão
  const p = new Promise<void>((res) => { const t = setTimeout(res, 60_000); t.unref(); }).finally(() => preparing.delete(key));
  preparing.set(key, p);
}

/** Espera o preparo em andamento NESTE processo (testes; e quem quiser pré-baixar e aguardar). */
export async function waitPrepared(): Promise<void> {
  await Promise.all([...preparing.values()]);
}

const downloadOff = (env: NodeJS.ProcessEnv, deps: GuardDeps): boolean => !deps.download && !deps.spawnPrepare && !!(env.STARFORK_GUARD_NO_DOWNLOAD || env.STARFORK_TEST_NO_AI);

/**
 * gitleaks SEM ESPERAR: GITLEAKS_BIN → ~/.cardume/bin/gitleaks → PATH. Sem nenhum: dispara o download em segundo
 * plano e devolve "preparando o gitleaks (1ª vez)" na hora; download que falhou há menos de 1 h → o motivo.
 */
export function gitleaksStatus(deps: GuardDeps = {}): { bin: string } | { off: string } {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (env.GITLEAKS_BIN) return isFile(env.GITLEAKS_BIN) ? { bin: env.GITLEAKS_BIN } : { off: `GITLEAKS_BIN aponta pra um arquivo que não existe (${env.GITLEAKS_BIN})` };
  const binDir = binDirOf(deps);
  const exe = exeName("gitleaks", platform);
  const local = join(binDir, exe);
  if (isFile(local)) return { bin: local };
  const onPath = findOnPath("gitleaks", env, platform, deps.extraDirs);
  if (onPath) return { bin: onPath };
  const asset = (deps.assets ?? GITLEAKS_ASSETS)[`${platform}-${arch}`];
  if (!asset) return { off: `gitleaks não instalado e não há download fixado pra ${platform}-${arch}` };
  if (downloadOff(env, deps)) return { off: "gitleaks não instalado (download desligado neste ambiente)" };
  const now = nowOf(deps);
  const err = recentError(binDir, "gitleaks", now);
  if (err) return { off: err };
  if (!lockBusy(binDir, "gitleaks", now)) kickPrepare({ kind: "gitleaks", url: gitleaksUrl(asset.file), sha256: asset.sha256, file: asset.file, destDir: binDir, exe }, deps);
  return { off: "preparando o gitleaks (1ª vez)" };
}

/** Pré-download em segundo plano (ao criar/iniciar tarefa ou subir o motor). Não espera, não lança. */
export function prepareGuardInBackground(deps: GuardDeps = {}): void {
  try { gitleaksStatus(deps); if (findSemgrep(deps.env ?? process.env, deps.platform ?? process.platform, deps.extraDirs)) semgrepRulesStatus(deps); } catch { /* melhor-esforço */ }
}

/** semgrep é opcional: SEMGREP_BIN → PATH. Nunca baixa. */
export function findSemgrep(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, extraDirs?: string[]): string | null {
  if (env.SEMGREP_BIN) return isFile(env.SEMGREP_BIN) ? env.SEMGREP_BIN : null;
  return findOnPath("semgrep", env, platform, extraDirs);
}

/** Regras locais do semgrep SEM ESPERAR: pronto → arquivo (renova em segundo plano se tiver mais de 7 dias). */
export function semgrepRulesStatus(deps: GuardDeps = {}): { rules: string; mtime: number } | { off: string } {
  const env = deps.env ?? process.env;
  const p = rulesPathOf(deps);
  const destDir = dirname(p);
  const now = nowOf(deps);
  const args: PrepareArgs = { kind: "rules", url: SEMGREP_RULES_URL, sha256: "", file: SEMGREP_RULES_FILE, destDir, exe: "" };
  let mtime = 0;
  try { mtime = statSync(p).mtimeMs; } catch { /* ainda não baixou */ }
  const canFetch = !downloadOff(env, deps);
  if (mtime) {
    if (canFetch && now - mtime > SEMGREP_RULES_MAX_AGE_MS && !recentError(destDir, "rules", now) && !lockBusy(destDir, "rules", now)) kickPrepare(args, deps);
    return { rules: p, mtime };
  }
  if (!canFetch) return { off: "regras do semgrep não baixadas (download desligado neste ambiente)" };
  const err = recentError(destDir, "rules", now);
  if (err) return { off: `não consegui baixar as regras do semgrep (${err})` };
  if (!lockBusy(destDir, "rules", now)) kickPrepare(args, deps);
  return { off: "preparando as regras do semgrep (1ª vez)" };
}

/** Mata o processo E os filhos (o semgrep deixa o semgrep-core órfão): grupo de processos / taskkill /T. */
export function killTree(pid: number, platform: string = process.platform): void {
  if (!pid) return;
  if (platform === "win32") { try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* já morreu */ } return; }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* já morreu */ } }
}

/** Roda num grupo de processos próprio; no timeout mata a árvore inteira. Nunca lança. */
export function execTree(bin: string, args: string[], opts: { cwd?: string; timeout: number }): Promise<ToolRun> {
  return new Promise((resolve) => {
    let out = "", err = "", timedOut = false, done = false;
    const finish = (r: ToolRun) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, error: String((e as Error)?.message ?? e) });
      return;
    }
    const cap = 64 * 1024 * 1024;
    child.stdout?.on("data", (d) => { if (out.length < cap) out += d; });
    child.stderr?.on("data", (d) => { if (err.length < cap) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid ?? 0);
      // neto segurando o pipe depois do kill: não espera mais que 2 s
      setTimeout(() => finish({ code: -1, stdout: out, stderr: err, timedOut: true }), 2000).unref();
    }, opts.timeout);
    child.on("error", (e) => finish({ code: -1, stdout: out, stderr: err, timedOut, error: String(e?.message ?? e) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout: out, stderr: err, timedOut }));
  });
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
  return [...out].sort();
}

/** Linhas que a tarefa tocou: diff do ponto de bifurcação até a worktree (commits + solto) + arquivos novos inteiros. */
export async function changedLines(worktree: string, base: string | undefined, files: string[]): Promise<ChangedLines> {
  if (!base) return null;
  let mb = "";
  for (const ref of [`origin/${base.replace(/^origin\//, "")}`, base]) {
    try { mb = (await run("git", ["-C", worktree, "merge-base", ref, "HEAD"])).stdout.trim(); if (mb) break; } catch { /* ref não existe */ }
  }
  if (!mb) return null;
  try {
    const d = await run("git", ["-C", worktree, "diff", "-U0", "--no-color", "--no-ext-diff", mb, "--", ...files]);
    const tracked = parseDiffLines(d.stdout);
    const untracked = new Set((await run("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "--", ...files])).stdout.split("\n").map((x) => x.trim()).filter(Boolean));
    const out: Map<string, Set<number> | "all"> = new Map();
    for (const f of files) out.set(f, untracked.has(f) ? "all" : tracked.get(f) ?? new Set<number>());
    return out;
  } catch {
    return null; // sem diff: tudo conta (o erro fica do lado de bloquear)
  }
}

async function runGitleaks(worktree: string, files: string[], bin: string, secretsBlock: boolean, deps: GuardDeps, readLine: LineReader): Promise<{ findings: GuardFinding[]; off?: string }> {
  const timeout = deps.timeoutMs ?? GUARD_TIMEOUT_MS;
  // cópia só dos arquivos mudados (caminhos relativos mantidos); roda DE DENTRO dela com --source . → caminhos relativos
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "starfork-guarda-"));
  try {
    const src = join(tmp, "src");
    for (const f of files) { const to = join(src, f); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(worktree, f), to); }
    const report = join(tmp, "relatorio.json");
    const args = ["detect", "--no-git", "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", report, "--source", "."];
    // configuração e ignores DO PROJETO (fingerprints do .gitleaksignore são relativos à raiz, igual aqui)
    if (isFile(join(worktree, ".gitleaks.toml"))) args.push("--config", join(worktree, ".gitleaks.toml"));
    if (isFile(join(worktree, ".gitleaksignore"))) args.push("--gitleaks-ignore-path", join(worktree, ".gitleaksignore"));
    const exec = deps.exec ?? execTree;
    const r = await exec(bin, args, { cwd: src, timeout });
    if (r.timedOut) return { findings: [], off: `guarda de segredos desligada: o gitleaks passou de ${Math.round(timeout / 1000)}s` };
    // 0 = nada; 1 = achou (padrão do --exit-code). Outro código = o gitleaks falhou.
    if (r.code !== 0 && r.code !== 1) return { findings: [], off: `guarda de segredos desligada: o gitleaks falhou (${(r.error || r.stderr || `código ${r.code}`).trim().slice(0, 140)})` };
    let json = "[]";
    try { json = readFileSync(report, "utf8"); } catch { if (r.code === 1) return { findings: [], off: "guarda de segredos desligada: o gitleaks não gerou o relatório" }; }
    return { findings: parseGitleaks(json, src, secretsBlock, readLine) };
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // o relatório tem o segredo em claro: nunca fica no disco
  }
}

async function runSemgrep(worktree: string, files: string[], bin: string, rules: string, highBlocks: boolean, deps: GuardDeps, readLine: LineReader): Promise<{ findings: GuardFinding[]; off?: string }> {
  const timeout = deps.timeoutMs ?? GUARD_TIMEOUT_MS;
  const exec = deps.exec ?? execTree;
  const r = await exec(bin, ["--config", rules, "--metrics=off", "--json", "--quiet", ...files], { cwd: worktree, timeout });
  if (r.timedOut) return { findings: [], off: `guarda de código desligada: o semgrep passou de ${Math.round(timeout / 1000)}s` };
  let parsed: { results?: unknown[]; errors?: Array<{ message?: string }> } | null = null;
  try { parsed = JSON.parse(r.stdout || "null"); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.results)) {
    const why = (r.error || r.stderr || (parsed?.errors?.[0]?.message ?? "") || `código ${r.code}`).trim();
    return { findings: [], off: `guarda de código indisponível: ${why.slice(0, 140)}` };
  }
  return { findings: parseSemgrep(r.stdout, highBlocks, readLine) };
}

// ---------------------------------------------------------------- cache da última varredura (fora da worktree)

const cachePathOf = (deps: GuardDeps, worktree: string): string => join(cardumeDir(deps), "guard-cache", sha256(worktree).slice(0, 24) + ".json");
function readCache(p: string, key: string): GuardResult | null {
  try { const c = JSON.parse(readFileSync(p, "utf8")); return c && c.key === key && c.result ? (c.result as GuardResult) : null; } catch { return null; }
}
function writeCache(p: string, key: string, result: GuardResult): void {
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ key, result })); } catch { /* cache é melhor-esforço */ }
}

/**
 * Roda a guarda nos arquivos mudados. Nunca lança e nunca espera download — erro inesperado, binário ainda baixando
 * ou ferramenta ausente vira "guarda desligada" em `skipped`. gitleaks e semgrep rodam em paralelo.
 */
export async function runGuard(input: GuardInput): Promise<GuardResult> {
  const t0 = Date.now();
  const deps = input.deps ?? {};
  const env = deps.env ?? process.env;
  const secretsBlock = input.policy?.guard?.secretsBlock !== false;
  const codeHighBlock = input.policy?.guard?.codeHighBlock !== false;
  let result: GuardResult;
  try {
    const files = scanTargets(input.worktree, input.files ?? []);
    if (!files.length) {
      result = { reasons: [], findings: [], skipped: [], ignored: 0, unsigned: 0, at: Date.now(), ms: Date.now() - t0 };
    } else {
      const gl = gitleaksStatus(deps);
      const sgBin = findSemgrep(env, deps.platform ?? process.platform, deps.extraDirs);
      const rules = sgBin ? semgrepRulesStatus(deps) : null;
      const skipped: string[] = [];
      if ("off" in gl) skipped.push(`guarda de segredos desligada: ${gl.off}`);
      if (!sgBin) skipped.push("guarda de código desligada (semgrep não instalado)");
      else if (rules && "off" in rules) skipped.push(`guarda de código desligada: ${rules.off}`);
      const ignoresRaw = readIgnores(input.worktree);
      const { valid, unsigned } = validIgnores(ignoresRaw, readGuardKey(deps));
      // mesma árvore (SHA + arquivos + conteúdo), mesmas ferramentas, regras, dispensas e política → mesmo resultado
      let head = "";
      try { head = (await run("git", ["-C", input.worktree, "rev-parse", "HEAD"])).stdout.trim(); } catch { /* sem git */ }
      const key = sha256(JSON.stringify({
        v: CACHE_VERSION, head, base: input.base ?? "",
        files: files.map((f) => { try { return [f, sha256(readFileSync(join(input.worktree, f)))]; } catch { return [f, ""]; } }),
        gl: "bin" in gl ? gl.bin : "", sg: sgBin ?? "", rules: rules && "rules" in rules ? rules.mtime : 0,
        ign: valid.map((x) => x.fingerprint).sort(), unsigned, secretsBlock, codeHighBlock,
        cfg: [".gitleaks.toml", ".gitleaksignore"].map((f) => { try { return sha256(readFileSync(join(input.worktree, f))); } catch { return ""; } }),
      }));
      const cachePath = cachePathOf(deps, input.worktree);
      const hit = readCache(cachePath, key);
      if (hit) {
        result = { ...hit, cached: true, at: Date.now(), ms: Date.now() - t0 };
      } else {
        const readLine = lineReader(input.worktree);
        const [lines, glr, sgr] = await Promise.all([
          changedLines(input.worktree, input.base, files),
          "bin" in gl ? runGitleaks(input.worktree, files, gl.bin, secretsBlock, deps, readLine) : Promise.resolve({ findings: [] as GuardFinding[], off: undefined }),
          sgBin && rules && "rules" in rules ? runSemgrep(input.worktree, files, sgBin, rules.rules, codeHighBlock, deps, readLine) : Promise.resolve({ findings: [] as GuardFinding[], off: undefined }),
        ]);
        if (glr.off) skipped.push(glr.off);
        if (sgr.off) skipped.push(sgr.off);
        const all = [...glr.findings, ...sgr.findings].map((f) => (inDiff(lines, f) ? f : markOld(f)));
        result = { ...decide(all, valid, skipped), unsigned, at: Date.now(), ms: Date.now() - t0 };
        // só guarda varredura COMPLETA: "preparando"/timeout tem que rodar de novo da próxima vez
        if (!skipped.length || skipped.every((s) => /semgrep não instalado/.test(s))) writeCache(cachePath, key, result);
      }
    }
  } catch (e) {
    result = { reasons: [], findings: [], skipped: [`guarda desligada: ${String((e as Error)?.message ?? e).slice(0, 140)}`], ignored: 0, unsigned: 0, at: Date.now(), ms: Date.now() - t0 };
  }
  try { input.onResult?.(result); } catch { /* gravar o evento é melhor-esforço */ }
  return result;
}
