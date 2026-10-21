// PORTÃO RÁPIDO (onda 1.1 do plano dores-2026): a verificação não pode ficar lenta nem chata.
//
//   readTestCfg(repo)            → .cardume/checks.json › testMode/testFast/testTimeoutSec/fullSuiteOver
//   effectiveTestMode(cfg, org)  → a política da organização (agentes.testMode) vence o projeto
//   detectCi(dir)                → o repo tem CI (GitHub Actions com push/pull_request, GitLab, CircleCI)?
//   affectedPlan(dir, runner, changed, o) → só os testes AFETADOS pelo diff (vitest related, jest
//                                  --findRelatedTests, go por pacote, cargo -p, pytest por módulo) — ou a suíte inteira
//                                  com o motivo (diff mexeu em config/lockfile, passou de N arquivos, runner sem modo
//                                  afetado, nada correspondente)
//   recordDuration / suggestAffected → histórico da duração da suíte INTEIRA por repo e a sugestão (uma vez por
//                                  projeto) de rodar só os afetados quando ela passa de 2 min duas vezes
//
// Tudo puro, menos o que lê/grava arquivo (readTestCfg, recordDuration, readDurations).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Runner } from "./test-runner.ts";

export type TestMode = "auto" | "sempre" | "afetados" | "so-no-pr" | "desligado";
export const TEST_MODES: TestMode[] = ["auto", "sempre", "afetados", "so-no-pr", "desligado"];
export interface TestCfg {
  testMode: TestMode;
  /** comando que substitui o do runner no modo afetado/auto (ex.: "npm run test:unit") */
  testFast?: string;
  testTimeoutSec?: number;
  /** diff com mais arquivos que isso roda a suíte inteira (padrão 40) */
  fullSuiteOver: number;
  /** a pessoa já respondeu a sugestão de "só os afetados" neste projeto */
  testModeAsked?: boolean;
}
export const FULL_SUITE_OVER = 40;

export const asMode = (v: unknown): TestMode | null => (TEST_MODES as unknown[]).includes(v) ? (v as TestMode) : null;

/** Lê a configuração de testes do projeto (lixo/ausente → padrão: auto, 40 arquivos). */
export function parseTestCfg(raw: unknown): TestCfg {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fast = typeof o.testFast === "string" && o.testFast.trim() ? o.testFast.trim() : undefined;
  const t = Number(o.testTimeoutSec), over = Number(o.fullSuiteOver);
  return {
    testMode: asMode(o.testMode) ?? "auto",
    ...(fast ? { testFast: fast } : {}),
    ...(Number.isFinite(t) && t > 0 ? { testTimeoutSec: t } : {}),
    fullSuiteOver: Number.isFinite(over) && over > 0 ? Math.round(over) : FULL_SUITE_OVER,
    ...(o.testModeAsked === true ? { testModeAsked: true } : {}),
  };
}
export function readTestCfg(repo: string): TestCfg {
  try { return parseTestCfg(JSON.parse(readFileSync(join(repo, ".cardume", "checks.json"), "utf8"))); } catch { return parseTestCfg(null); }
}

/** O modo que vale: o da organização vence o do projeto. */
export function effectiveTestMode(cfg: TestCfg, org?: TestMode | null): { mode: TestMode; byOrg: boolean } {
  return org ? { mode: org, byOrg: true } : { mode: cfg.testMode, byOrg: false };
}

/** Passo de CI com cara de TESTE (deploy/lint não contam). */
export const CI_TEST_STEP_RE = /\b(npm (run )?test|pnpm (run )?test|yarn (run )?test|bun (run )?test|npx (vitest|jest)|vitest|jest|pytest|python3? -m pytest|tox|nox|cargo (nextest|test)|go test|make test|swift test|xcodebuild test|gradle(w)? test|mvn test)\b/;
/**
 * O repo tem CI que RODA A SUÍTE? GitHub Actions com gatilho push/pull_request E um passo de teste; .gitlab-ci.yml ou
 * CircleCI com um passo de teste. Workflow só de deploy ou lint não conta (a suíte inteira ficaria sem ninguém rodar).
 */
export function detectCi(dir: string): boolean {
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  for (const f of [join(dir, ".gitlab-ci.yml"), join(dir, ".circleci", "config.yml")]) if (CI_TEST_STEP_RE.test(read(f))) return true;
  const wf = join(dir, ".github", "workflows");
  let files: string[] = [];
  try { files = readdirSync(wf).filter((f) => /\.ya?ml$/i.test(f)); } catch { return false; }
  return files.some((f) => {
    const y = read(join(wf, f));
    return /^\s*(on\s*:.*\b(push|pull_request)\b|-?\s*(push|pull_request)\s*:?\s*$)/m.test(y) && CI_TEST_STEP_RE.test(y);
  });
}

/** Mudança nisso pode quebrar QUALQUER teste: roda a suíte inteira. */
export const FULL_TRIGGER_RE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|vitest\.config\.[\w.]+|vitest\.workspace\.[\w.]+|vitest\.setup\.[\w.]+|vite\.config\.[\w.]+|jest\.config\.[\w.]+|jest\.setup\.[\w.]+|setupTests\.[\w.]+|babel\.config\.[\w.]+|\.babelrc[\w.]*|\.env[\w.-]*|tsconfig[\w.-]*\.json|pyproject\.toml|setup\.cfg|setup\.py|pytest\.ini|tox\.ini|conftest\.py|requirements[\w.-]*\.txt|poetry\.lock|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Package\.swift)$/;
/** Arquivo que não é código nem doc — dado de teste (.json, .snap, .env, fixtures, .yml…): mudar isso pode quebrar
 * teste que nenhum grafo de import enxerga. Roda a suíte inteira. */
const CODE_RE = /\.((m|c)?[jt]sx?|vue|svelte|css|scss|sass|less|go|rs|py|pyi|swift)$/i;
const DOC_RE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS)(\.\w+)?$/i;
const FIXTURE_DIR_RE = /(^|\/)(fixtures?|__fixtures__|__snapshots__|testdata|test-data|snapshots)\//i;
/** Nome que pode ir como argumento sem surpresa em nenhum shell (o Windows passa pelo cmd): o resto roda a inteira. */
const SAFE_NAME_RE = /^[\p{L}\p{N}_./@+ -]+$/u;

export interface AffectedPlan {
  /** "afetados" = só o que o diff toca; "inteira" = a suíte toda (com o porquê) */
  scope: "afetados" | "inteira";
  runner: Runner | null;
  why?: string;
  /** assinatura do plano (o cache por versão só vale pro MESMO plano) */
  sig: string;
}

type JsTool = "vitest" | "jest" | null;
/** vitest/jest pelo package.json (dependências ou o script test). Script genérico (node --test, mocha) = null. */
export function jsTestTool(pkg: unknown): JsTool {
  const p = pkg && typeof pkg === "object" ? (pkg as Record<string, Record<string, string> | undefined>) : {};
  const test = String((p.scripts as Record<string, string> | undefined)?.test ?? "");
  if (/\bvitest\b/.test(test)) return "vitest";
  if (/\bjest\b/.test(test)) return "jest";
  if (test && /\b(node\s+--test|mocha|ava|tap|uvu)\b/.test(test)) return null;
  const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) } as Record<string, string>;
  if (!test || /^(npm|pnpm|yarn)\s+run\b/.test(test)) {
    if (deps.vitest) return "vitest";
    if (deps.jest) return "jest";
  }
  return null;
}
const execFor = (r: Runner): [string, string[]] =>
  r.kind === "pnpm" ? ["pnpm", ["exec"]] : r.kind === "yarn" ? ["yarn", []] : r.kind === "bun" ? ["bunx", []] : ["npx", ["--no-install"]];

const CODE_JS = /\.(m|c)?[jt]sx?$|\.(vue|svelte)$/;
const exists = (dir: string, f: string) => existsSync(join(dir, f));
const shellRunner = (cmd: string, kind: Runner["kind"], label: string): Runner =>
  process.platform === "win32" ? { kind, cmd: "cmd", args: ["/d", "/s", "/c", cmd], label } : { kind, cmd: "sh", args: ["-c", cmd], label };

/**
 * Só os testes AFETADOS pelo diff, ou a suíte inteira com o motivo. `full:true` força a inteira (modo sempre, sem CI…).
 * `testFast` (checks.json) substitui o comando no modo afetado.
 */
export function affectedPlan(dir: string, runner: Runner | null, changed: string[], o: { full?: boolean; fullWhy?: string; testFast?: string; fullSuiteOver?: number } = {}): AffectedPlan {
  const files = [...new Set(changed.map((f) => f.replace(/\\/g, "/")).filter((f) => f && !f.startsWith(".cardume/")))].sort();
  const full = (why: string): AffectedPlan => ({ scope: "inteira", runner, why, sig: `inteira:${runner?.label ?? ""}:${runner?.args.join(" ") ?? ""}` });
  if (!runner) return full("sem suíte detectada");
  if (o.full) return full(o.fullWhy ?? "suíte inteira");
  const trig = files.find((f) => FULL_TRIGGER_RE.test(f));
  if (trig) return full(`o diff mexe em ${trig}`);
  const over = o.fullSuiteOver ?? FULL_SUITE_OVER;
  if (files.length > over) return full(`o diff tem ${files.length} arquivos (mais de ${over})`);
  if (!files.length) return full("sem diff legível");
  // arquivo apagado ou renomeado: quem importava ele não aparece no grafo — roda tudo
  const gone = files.find((f) => !exists(dir, f));
  if (gone) return full(`o diff apaga ou renomeia ${gone}`);
  const data = files.find((f) => !DOC_RE.test(f) && (!CODE_RE.test(f) || FIXTURE_DIR_RE.test(f)));
  if (data) return full(`o diff mexe em ${data} (dado/configuração, não código)`);
  const odd = files.find((f) => !SAFE_NAME_RE.test(f));
  if (odd) return full(`nome de arquivo com caractere especial: ${odd}`);
  if (o.testFast) {
    const r = shellRunner(o.testFast, runner.kind, o.testFast);
    return { scope: "afetados", runner: r, sig: `fast:${o.testFast}` };
  }
  const live = files.filter((f) => exists(dir, f));
  const done = (r: Runner): AffectedPlan => ({ scope: "afetados", runner: r, sig: `afetados:${r.cmd} ${r.args.join(" ")}` });
  if (["npm", "pnpm", "yarn", "bun"].includes(runner.kind)) {
    let pkg: unknown = null;
    try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { /* sem package.json legível */ }
    const tool = jsTestTool(pkg);
    if (!tool) return full("o script de teste não tem modo de testes afetados (configure testFast)");
    const js = live.filter((f) => CODE_JS.test(f));
    if (!js.length) return full("o diff não tem arquivo JS/TS");
    const [cmd, pre] = execFor(runner);
    return done(tool === "vitest"
      ? { kind: runner.kind, cmd, args: [...pre, "vitest", "related", ...js, "--run", "--passWithNoTests"], label: "vitest related" }
      : { kind: runner.kind, cmd, args: [...pre, "jest", "--ci", "--passWithNoTests", "--findRelatedTests", ...js], label: "jest --findRelatedTests" });
  }
  if (runner.kind === "go") {
    // os pacotes que DEPENDEM do mudado também quebram (go list -deps reverso) — mapear isso aqui ficaria caro e frágil:
    // go roda ./... inteiro (a suíte do go costuma ser rápida e tem cache próprio)
    return full("go: os pacotes que dependem do mudado não são mapeados — roda ./... inteiro");
  }
  if (runner.kind === "cargo") {
    const crates = new Set<string>();
    for (const f of files.filter((x) => x.endsWith(".rs"))) {
      const c = crateOf(dir, f);
      if (!c) return full(`não achei o crate de ${f}`);
      if (!/^[A-Za-z0-9_-]+$/.test(c)) return full(`nome de crate inesperado: ${c}`);
      crates.add(c);
    }
    if (!crates.size) return full("o diff não tem arquivo .rs");
    return done({ kind: "cargo", cmd: "cargo", args: ["test", ...[...crates].sort().flatMap((c) => ["-p", c])], label: "cargo test -p" });
  }
  if (runner.kind === "pytest") {
    const py = live.filter((f) => f.endsWith(".py"));
    const tests = pytestTargets(dir, py);
    // correspondência confiável: TODO módulo mudado tem o test_<módulo>.py dele (senão roda tudo)
    const sem = py.find((f) => { const b = posix.basename(f); return !/^test_.*\.py$|_test\.py$/.test(b) && b !== "__init__.py" && !tests.some((t) => [`test_${b}`, b.replace(/\.py$/, "_test.py")].includes(posix.basename(t))); });
    if (sem) return full(`nenhum teste corresponde a ${sem}`);
    if (!tests.length) return full("nenhum teste corresponde aos módulos mudados");
    return done({ kind: "pytest", cmd: runner.cmd, args: ["-m", "pytest", "-q", ...tests], label: "pytest (testes dos módulos mudados)" });
  }
  return full(`${runner.label} não tem modo de testes afetados`);
}

/** O crate (`[package] name`) do Cargo.toml mais perto do arquivo. null = só workspace sem pacote. */
function crateOf(dir: string, file: string): string | null {
  let d = posix.dirname(file);
  for (;;) {
    const toml = join(dir, d === "." ? "" : d, "Cargo.toml");
    if (existsSync(toml)) {
      const m = readFileSync(toml, "utf8").match(/\[package\][^[]*?\bname\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    if (d === "." || d === "") return null;
    d = posix.dirname(d);
  }
}

/** tests/**\/test_<módulo>.py (e test_<módulo>.py ao lado) dos módulos mudados; arquivo de teste mudado entra direto. */
export function pytestTargets(dir: string, pyFiles: string[]): string[] {
  const all: string[] = [];
  const walk = (rel: string, depth: number) => {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 5 && !/^(\.|node_modules$|venv$|__pycache__$|build$|dist$)/.test(e.name)) walk(r, depth + 1); }
      else if (/^test_.*\.py$|_test\.py$/.test(e.name)) all.push(r);
    }
  };
  walk("", 0);
  const out = new Set<string>();
  for (const f of pyFiles) {
    const base = posix.basename(f);
    if (/^test_.*\.py$|_test\.py$/.test(base)) { out.add(f); continue; }
    const mod = base.replace(/\.py$/, "");
    if (mod === "__init__") continue;
    for (const t of all) { const b = posix.basename(t); if (b === `test_${mod}.py` || b === `${mod}_test.py`) out.add(t); }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- duração da suíte (sugestão automática)

export const SLOW_SUITE_MS = 120_000;
export interface DurationRec { at: number; ms: number; scope: "afetados" | "inteira"; ok: boolean }
function statsFile(repo: string): string {
  let id = repo;
  try { id = realpathSync(repo); } catch { /* repo sumiu */ }
  return join(homedir(), ".cardume", "test-stats", `${createHash("sha1").update(id).digest("hex").slice(0, 16)}.json`);
}
export function readDurations(repo: string): DurationRec[] {
  try { const j = JSON.parse(readFileSync(statsFile(repo), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}
/** Guarda a duração (últimas 20) — a suíte já roda, medir é de graça. */
export function recordDuration(repo: string, rec: DurationRec): DurationRec[] {
  const list = [...readDurations(repo), rec].slice(-20);
  try { mkdirSync(dirname(statsFile(repo)), { recursive: true }); writeFileSync(statsFile(repo), JSON.stringify(list)); } catch { /* sem disco: sem histórico */ }
  return list;
}
/**
 * Sugerir "só os afetados"? A suíte INTEIRA passou de 2 min em pelo menos duas rodadas, o modo é sempre/auto, o projeto
 * não tem CI (com CI o auto já roda só os afetados) e a pessoa ainda não respondeu. Devolve a média em segundos, ou null.
 */
export function suggestAffected(recs: DurationRec[], cfg: TestCfg, mode: TestMode, hasCi: boolean): number | null {
  if (cfg.testModeAsked || !(mode === "sempre" || (mode === "auto" && !hasCi))) return null;
  const slow = recs.filter((r) => r.scope === "inteira" && r.ms > SLOW_SUITE_MS);
  if (slow.length < 2) return null;
  return Math.round(slow.slice(-3).reduce((a, r) => a + r.ms, 0) / Math.min(3, slow.length) / 1000);
}
