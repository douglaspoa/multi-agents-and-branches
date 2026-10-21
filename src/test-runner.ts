// VERIFICAÇÃO INDEPENDENTE (Frente 1 do plano dores-2026): o portão roda a suíte do projeto de verdade
// e confere o que o agente DISSE contra o que a execução DEU.
//
//   detectRunner(dir)          → qual suíte o projeto tem (npm/pnpm/yarn/bun, pytest, cargo, go, swift) — ou null
//   parseCounts(kind, saída)   → { passed, failed } lidos da saída real — ou null (não deu pra ler)
//   parseClaim(texto)          → o que o agente afirmou ("86/86", "86 passed", "ALL PASSED"…) — ou null
//   claimDivergence(claim, real) → frase do motivo quando o relato não bate com o real — ou null
//   runTests(dir, { timeoutMs }) → roda a suíte (grupo de processo próprio, mata a árvore no tempo-limite)
//   testGate(...)              → a parte de testes do portão (verifyProofs chama; não grava nada — quem chama grava)
//
// Tudo que é regra é função pura (testes em src/test-runner.test.ts). O único efeito colateral é runTests.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run as runCmd, sleep } from "./util/run.ts";

export type RunnerKind = "npm" | "pnpm" | "yarn" | "bun" | "pytest" | "cargo" | "go" | "swift";
export interface Runner {
  kind: RunnerKind;
  cmd: string;
  args: string[];
  /** como aparece no selo e nos motivos ("npm test", "pytest", "cargo test"…) */
  label: string;
}
export interface Counts { passed: number; failed: number }
export interface Claim {
  passed: number | null;
  total: number | null;
  /** "ALL PASSED" / "todos os testes passaram" — sem número */
  allPassed?: boolean;
}
export interface TestRun {
  ran: boolean;
  passed: boolean;
  detail: string;
  runner?: string;
  kind?: RunnerKind;
  counts?: Counts | null;
  timedOut?: boolean;
  /** cauda da saída (pro motivo e pro agente) */
  tail?: string;
  /** nomes dos testes que falharam (null = a saída não deixa ler) — compara com a suíte da base */
  failedNames?: string[] | null;
  /** a falha parece de AMBIENTE (comando/módulo ausente, sem banco), não do código */
  envFail?: boolean;
  durationMs?: number;
}
/** O selo de verificação que fica no spec (spec.verification) e o app mostra no cartão e na Revisão. */
export interface Verification {
  tests: {
    passed: number | null; failed: number | null; ran: boolean; runner: string; ok: boolean; timedOut?: boolean; skipped?: string; baseWarn?: string;
    /** onda 1.1: "afetados" (só o que o diff toca; a suíte inteira fica com o CI) ou "inteira" */
    scope?: "afetados" | "inteira";
    /** assinatura do plano que rodou (o cache por versão só vale pro mesmo plano) */
    planSig?: string;
    /** o projeto tem CI (o selo diz "suíte completa no CI") */
    ci?: boolean;
    /** o runner que rodou (npm/pnpm/yarn/bun/pytest/cargo/go/swift) — o FT-5 só usa o selo na checagem desse runner */
    kind?: string;
    /** a linha de comando exata que rodou — comando próprio do FT-5 só troca pelo selo se for IDÊNTICO */
    cmdLine?: string;
    durationMs?: number;
    /** "testes desligados neste projeto" / "rodam ao abrir o PR" */
    off?: string;
    /** a pessoa entregou sem esperar os testes (motivo) */
    skippedBy?: string;
    /** transparência: modo de testes fora do padrão / a tarefa tentou mudar (selo e corpo do PR) */
    modeNote?: string[];
  } | null;
  /** a suíte está rodando agora (o app mostra "rodando testes · 40 s") */
  running?: { since: number; sha?: string } | null;
  /** sugestão de rodar só os afetados (a suíte inteira passou de 2 min duas vezes): média em segundos */
  suggest?: { avgSec: number } | null;
  ci: { total: number; fail: number; pending: number } | null;
  divergente: boolean;
  /** a frase do relato divergente (quando houver) */
  relato?: string;
  /** HEAD da worktree quando a suíte rodou (mesma versão sem mudança solta = não roda de novo) */
  sha?: string;
  at: number;
}

/** Tempo-limite padrão da suíte no portão. */
export const TEST_TIMEOUT_MS = 180_000;

const NO_TEST = /no test specified/i;

/**
 * Qual suíte o projeto tem. O primeiro que casar vale: package.json com `scripts.test` real (gerenciador pelo
 * lockfile), Cargo.toml, go.mod, Package.swift, pytest. `package.json` ilegível LANÇA (a regra de sempre:
 * o projeto não roda → reprova). Sem nada → null (projeto sem suíte continua passando).
 */
export function detectRunner(dir: string): Runner | null {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (err) {
      throw new Error(`package.json inválido: ${String((err as Error)?.message ?? err).slice(0, 140)}`);
    }
    const t = String(pkg?.scripts?.test ?? "").trim();
    if (t && !NO_TEST.test(t)) {
      if (existsSync(join(dir, "pnpm-lock.yaml"))) return { kind: "pnpm", cmd: "pnpm", args: ["test"], label: "pnpm test" };
      if (existsSync(join(dir, "yarn.lock"))) return { kind: "yarn", cmd: "yarn", args: ["test"], label: "yarn test" };
      // `bun test` é o runner do bun, não o script: `bun run test` roda o que o projeto declarou
      if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return { kind: "bun", cmd: "bun", args: ["run", "test"], label: "bun run test" };
      return { kind: "npm", cmd: "npm", args: ["test", "--silent"], label: "npm test" };
    }
  }
  if (existsSync(join(dir, "Cargo.toml"))) return { kind: "cargo", cmd: "cargo", args: ["test"], label: "cargo test" };
  // -v: sem ele o go só imprime "ok pacote" — os "--- PASS/--- FAIL" por teste são o que dá o número real
  if (existsSync(join(dir, "go.mod"))) return { kind: "go", cmd: "go", args: ["test", "-v", "./..."], label: "go test ./..." };
  if (existsSync(join(dir, "Package.swift"))) return { kind: "swift", cmd: "swift", args: ["test"], label: "swift test" };
  if (hasPytest(dir)) {
    const py = process.platform === "win32" ? "python" : "python3";
    return { kind: "pytest", cmd: py, args: ["-m", "pytest", "-q"], label: "pytest" };
  }
  return null;
}

function hasPytest(dir: string): boolean {
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
  if (existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "conftest.py"))) return true;
  if (/pytest/.test(read("pyproject.toml")) || /\[tool:pytest\]/.test(read("setup.cfg")) || /\[pytest\]/.test(read("tox.ini"))) return true;
  const isTest = (f: string) => /^test_.*\.py$|_test\.py$/.test(f);
  try { if (readdirSync(join(dir, "tests")).some((f) => f.endsWith(".py"))) return true; } catch { /* sem tests/ */ }
  try { if (readdirSync(dir).some(isTest)) return true; } catch { /* pasta ilegível */ }
  return false;
}

const num = (s: string | undefined) => (s == null ? 0 : Number(s));
/** Soma TODAS as ocorrências de um padrão (cargo imprime um "test result" por alvo; pytest só um). */
function sumAll(re: RegExp, out: string, pick: (m: RegExpMatchArray) => Counts): Counts | null {
  let got = null as Counts | null;
  for (const m of out.matchAll(re)) {
    const c = pick(m);
    got = { passed: (got?.passed ?? 0) + c.passed, failed: (got?.failed ?? 0) + c.failed };
  }
  return got;
}
function lastOf(re: RegExp, out: string, pick: (m: RegExpMatchArray) => Counts): Counts | null {
  let got = null as Counts | null;
  for (const m of out.matchAll(re)) got = pick(m);
  return got;
}

/** Contagem real lida da saída da suíte. null = formato desconhecido (o portão mostra só passou/falhou). */
export function parseCounts(kind: RunnerKind | string, output: string): Counts | null {
  // tira as cores ANSI que jest/vitest/cargo põem quando acham que é terminal
  const out = String(output ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  if (kind === "cargo") {
    return sumAll(/test result: \w+\.\s*(\d+) passed;\s*(\d+) failed/g, out, (m) => ({ passed: num(m[1]), failed: num(m[2]) }));
  }
  if (kind === "pytest") {
    // a linha de resumo: "=== 84 passed, 2 failed in 1.2s ===" (ou, no -q, "84 passed, 2 failed in 1.2s")
    const line = out.split("\n").filter((l) => /\b\d+ (passed|failed|errors?)\b/.test(l)).pop();
    if (!line) return null;
    const g = (w: string) => num(line.match(new RegExp(`(\\d+) ${w}\\b`))?.[1]);
    return { passed: g("passed"), failed: g("failed") + g("errors?") };
  }
  if (kind === "go") {
    const p = (out.match(/^\s*--- PASS:/gm) ?? []).length, f = (out.match(/^\s*--- FAIL:/gm) ?? []).length;
    return p + f ? { passed: p, failed: f } : null;
  }
  if (kind === "swift") {
    // XCTest: "Executed 86 tests, with 2 failures" (a linha final é a do total); swift-testing: "Test run with 86 tests … passed/failed after"
    const x = lastOf(/Executed (\d+) tests?, with (\d+) failures?/g, out, (m) => ({ passed: num(m[1]) - num(m[2]), failed: num(m[2]) }));
    if (x) return x;
    const st = out.match(/Test run with (\d+) tests? (?:in \d+ suites? )?(passed|failed)(?: after [\d.]+ seconds)?(?: with (\d+) issues?)?/);
    if (st) return st[2] === "passed" ? { passed: num(st[1]), failed: 0 } : { passed: Math.max(0, num(st[1]) - num(st[3] ?? "1")), failed: num(st[3] ?? "1") };
    return null;
  }
  // JS (npm/pnpm/yarn/bun): node:test, jest, vitest, mocha — o que aparecer
  return parseJsCounts(out);
}

function parseJsCounts(out: string): Counts | null {
  // node --test (TAP): "# pass 84" / "# fail 2" — pode ter várias rodadas (scripts encadeados com &&): soma
  const np = [...out.matchAll(/^# pass (\d+)/gm)], nf = [...out.matchAll(/^# fail (\d+)/gm)];
  if (np.length) return { passed: np.reduce((a, m) => a + num(m[1]), 0), failed: nf.reduce((a, m) => a + num(m[1]), 0) };
  // node --test (spec reporter): "ℹ pass 84" / "ℹ fail 2"
  const sp = [...out.matchAll(/^ℹ pass (\d+)/gm)], sf = [...out.matchAll(/^ℹ fail (\d+)/gm)];
  if (sp.length) return { passed: sp.reduce((a, m) => a + num(m[1]), 0), failed: sf.reduce((a, m) => a + num(m[1]), 0) };
  // jest: "Tests:       2 failed, 84 passed, 86 total"
  const jest = out.match(/^Tests:\s+(.*\d+ total)/m);
  if (jest) return { passed: num(jest[1].match(/(\d+) passed/)?.[1]), failed: num(jest[1].match(/(\d+) failed/)?.[1]) };
  // vitest: "Tests  2 failed | 84 passed (86)"
  const vt = out.match(/^\s*Tests\s+(.*\(\d+\))/m);
  if (vt) return { passed: num(vt[1].match(/(\d+) passed/)?.[1]), failed: num(vt[1].match(/(\d+) failed/)?.[1]) };
  // mocha: "84 passing" / "2 failing"
  const mp = out.match(/^\s*(\d+) passing/m);
  if (mp) return { passed: num(mp[1]), failed: num(out.match(/^\s*(\d+) failing/m)?.[1]) };
  return null;
}

/** Palavra que faz um "N/M" ser relato de TESTE (com limite de palavra: "especificação", "Passo", "✓ requisitos" não contam). */
const TEST_WORD = /\b(tests?|testes?|su[ií]tes?|passed|passing|failed|falharam|passaram)\b/i;
/** Quantos caracteres antes/depois do número a palavra de teste pode estar. */
const TEST_WORD_NEAR = 20;
/**
 * O que o agente AFIRMOU sobre os testes, num texto livre (mensagem final, requirements.json). Lê, nesta ordem:
 * "84 passed, 2 failed" / "Tests: 84 passed, 2 failed" · "86/86" (com palavra de teste a até 20 caracteres) ·
 * "86 passed" / "86 testes passando" · "ALL PASSED" / "todos os testes passaram". Nada disso → null (não acusa ninguém).
 */
export function parseClaim(text: string): Claim | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  // par passou + falhou na mesma frase (em qualquer ordem)
  const pf = t.match(/(?<![\w.])(\d+)\s*(?:tests?\s*|testes?\s*)?(?:passed|passing|passaram|passando|ok)\b[^\n\d]{0,12}(\d+)\s*(?:tests?\s*|testes?\s*)?(?:failed|failing|falharam|falhando|falhou)/i);
  if (pf) return { passed: num(pf[1]), total: num(pf[1]) + num(pf[2]) };
  const fp = t.match(/(?<![\w.])(\d+)\s*(?:tests?\s*|testes?\s*)?(?:failed|failing|falharam|falhando)\b[^\n\d]{0,12}(\d+)\s*(?:tests?\s*|testes?\s*)?(?:passed|passing|passaram|passando)/i);
  if (fp) return { passed: num(fp[2]), total: num(fp[1]) + num(fp[2]) };
  // "86/86" ou "86 de 86" — só com palavra de teste PERTO (datas, "Passo 3/5", "✓ 4/6 requisitos" não contam)
  for (const line of t.split("\n")) {
    for (const m of line.matchAll(/(?<![\w/])(\d+)\s*(?:\/|de)\s*(\d+)(?![\d/])/g)) {
      const at = m.index ?? 0;
      const near = line.slice(Math.max(0, at - TEST_WORD_NEAR), at + m[0].length + TEST_WORD_NEAR);
      if (TEST_WORD.test(near) && num(m[2]) > 0 && num(m[1]) <= num(m[2])) return { passed: num(m[1]), total: num(m[2]) };
    }
  }
  // "86 passed" / "86 testes passando" / "# pass 86"
  const p = t.match(/(?<![\w.])(\d+)\s*(?:tests?|testes?)?\s*(?:passed|passing|pass\b|passaram|passando)/i) ?? t.match(/#\s*pass\s+(\d+)/i);
  if (p) return { passed: num(p[1]), total: null };
  if (/all (tests )?pass(ed|ing)?\b|todos os testes (passa(ram|ndo|m)|est[aã]o passando|verdes)|su[ií]te (inteira )?(verde|passou)/i.test(t)) return { passed: null, total: null, allPassed: true };
  return null;
}

/** "84/86" do real. */
export const fmtCounts = (c: Counts) => `${c.passed}/${c.passed + c.failed}`;

/**
 * O agente disse MAIS do que o real? Devolve o motivo exato; null quando não. Só acusa quando o relato é melhor que
 * a execução: passaram mais do que de fato passaram, ou "tudo verde" com a suíte vermelha. Relato MENOR que o real
 * (rodou só um pedaço, ou um número de antes da correção) não é mentira — não acusa.
 */
export function claimDivergence(claim: Claim | null, real: Counts | null): string | null {
  if (!claim || !real) return null;
  if (claim.allPassed) return real.failed > 0 ? `o agente relatou todos os testes passando, a execução real deu ${fmtCounts(real)}` : null;
  if (claim.passed == null) return null;
  const total = claim.total ?? claim.passed; // "86 passed" sem total = afirma 86/86
  const claimGreen = claim.passed === total;
  if (claim.passed > real.passed || (claimGreen && real.failed > 0)) return `o agente relatou ${claim.passed}/${total}, a execução real deu ${fmtCounts(real)}`;
  return null;
}

/** O que o agente afirmou: a ÚLTIMA fala final dele (evento `done`, o fim do turno) desde o último pedido da pessoa.
 * Os `think` do meio do turno não contam — "84 passed" antes da correção não é o relato da entrega. */
export function agentClaimFrom(events: Array<{ agent: string; type: string; text: string }>): { claim: Claim; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const txt = String(e.text ?? "");
    if (e.agent === "Você" || /^Você:\s*/.test(txt)) return null; // pedido novo da pessoa: o relato velho não vale mais
    if (e.agent === "Sistema" || e.type !== "done") continue;
    const claim = parseClaim(txt);
    return claim ? { claim, text: txt } : null;
  }
  return null;
}

/** O campo `tests` do requirements.json (texto "86/86" ou { passed, total } / { passed, failed }). */
export function claimFromReq(raw: unknown): Claim | null {
  const t = (raw as { tests?: unknown } | null)?.tests;
  if (t == null) return null;
  if (typeof t === "string") return parseClaim(/test|teste/i.test(t) ? t : `testes: ${t}`); // o campo já é sobre testes: "86/86" puro vale
  if (typeof t === "object") {
    const o = t as { passed?: unknown; total?: unknown; failed?: unknown };
    const p = Number(o.passed);
    if (!Number.isFinite(p)) return null;
    const total = Number.isFinite(Number(o.total)) ? Number(o.total) : Number.isFinite(Number(o.failed)) ? p + Number(o.failed) : null;
    return { passed: p, total };
  }
  return null;
}

/** Arquivo que NÃO é código (docs, estilo, imagem): mudança só nisso pode pular a suíte. */
export const NON_CODE_RE = /\.(md|mdx|markdown|txt|rst|adoc|css|scss|sass|less|png|jpe?g|gif|svg|webp|ico|pdf)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS)(\.\w+)?$|(^|\/)docs?\//i;
/** Por que pular a suíte (só docs/CSS no diff) — ou null (roda). Diff vazio/ilegível roda (não dá pra saber). */
export function skipReason(changed: string[]): string | null {
  const files = changed.filter((f) => f && !f.startsWith(".cardume/"));
  if (!files.length) return null;
  if (files.every((f) => NON_CODE_RE.test(f))) return `a mudança só toca em docs/estilo (${files.length} arquivo${files.length === 1 ? "" : "s"}) — a suíte não rodou`;
  return null;
}

/** Tempo-limite da suíte: env STARFORK_TEST_TIMEOUT_S, senão `testTimeoutSec` em <repo>/.cardume/checks.json, senão 180 s. */
export function testTimeoutMs(repo?: string): number {
  const env = Number(process.env.STARFORK_TEST_TIMEOUT_S);
  if (Number.isFinite(env) && env > 0) return env * 1000;
  if (repo) {
    try {
      const s = Number(JSON.parse(readFileSync(join(repo, ".cardume", "checks.json"), "utf8"))?.testTimeoutSec);
      if (Number.isFinite(s) && s > 0) return s * 1000;
    } catch { /* sem config */ }
  }
  return TEST_TIMEOUT_MS;
}

const tailOf = (s: string, n = 60) => s.split("\n").slice(-n).join("\n").trim();

/** Roda a suíte NA PASTA, num grupo de processo próprio: no tempo-limite mata a árvore toda (npm → node → …). */
export async function runTests(dir: string, o: { timeoutMs?: number; runner?: Runner | null } = {}): Promise<TestRun> {
  let runner: Runner | null;
  try {
    runner = o.runner !== undefined ? o.runner : detectRunner(dir);
  } catch (err) {
    return { ran: true, passed: false, detail: (err as Error).message };
  }
  if (!runner) return { ran: false, passed: true, detail: "sem suíte de testes detectada" };
  const timeoutMs = o.timeoutMs ?? TEST_TIMEOUT_MS;
  const t0 = Date.now();
  const r = await spawnCapture(runner.cmd, runner.args, dir, timeoutMs);
  const durationMs = Date.now() - t0;
  const counts = parseCounts(runner.kind, r.out);
  const tail = tailOf(r.out);
  // nomes sem a pasta (a mesma suíte roda na worktree da tarefa e na da base — o caminho não pode diferenciar)
  let dirs: string[] = [dir];
  try { dirs = [...new Set([realpathSync(dir), dir])]; } catch { /* pasta sumiu */ }
  const failedNames = parseFailedNames(runner.kind, r.out)?.map((n) => dirs.reduce((a, d) => a.split(d).join("<repo>"), n)) ?? null;
  const base = { runner: runner.label, kind: runner.kind, counts, tail, failedNames, envFail: isEnvFailure(r.out), durationMs };
  if (r.timedOut) return { ...base, ran: true, passed: false, timedOut: true, detail: `${runner.label} estourou o tempo (${Math.round(timeoutMs / 1000)}s)` };
  if (r.spawnErr) return { ...base, ran: false, passed: true, detail: `${runner.label} não está instalado nesta máquina (${r.spawnErr})` };
  if (r.code === 0 && !(counts && counts.failed > 0)) return { ...base, ran: true, passed: true, detail: counts ? `${runner.label} passou (${fmtCounts(counts)})` : `${runner.label} passou` };
  const why = counts ? `${fmtCounts(counts)} passaram` : tailOf(r.out, 3).slice(0, 160) || `saiu com código ${r.code}`;
  return { ...base, ran: true, passed: false, detail: `${runner.label}: ${why}` };
}

/** "[[dd-]hh:]mm:ss" do `ps -o etime=` → segundos. */
export function parseEtime(e: string): number | null {
  const m = String(e ?? "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + Number(m[3]) * 60 + Number(m[4]);
}
/** Quando o processo `pid` começou (ms), pelo `ps` — null se não existe ou não deu pra saber (Windows). */
export function procStartMs(pid: number): number | null {
  if (pid === process.pid) return Math.round(Date.now() - process.uptime() * 1000);
  if (process.platform === "win32") return null;
  try {
    const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
    const s = parseEtime(r.stdout);
    return s == null ? null : Date.now() - s * 1000;
  } catch { return null; }
}
/** O dono da trava ainda é o MESMO processo? (pid reaproveitado pelo sistema não conta) — tolerância de 5 s. */
export function sameProcess(pid: number, startedAt: unknown): boolean {
  const want = Number(startedAt);
  if (!Number.isFinite(want) || want <= 0) return false;
  const got = procStartMs(pid);
  return got != null && Math.abs(got - want) < 5_000;
}

/** Um argumento pro cmd.exe: entre aspas (dentro delas & | < > ( ) são literais) e aspas internas dobradas. O % ainda
 * expandiria variável — por isso nome com % (ou ! ^ ") nem chega aqui: o plano de afetados roda a suíte inteira. */
export function winArg(a: string): string {
  return `"${String(a).replace(/"/g, '""')}"`;
}
/** Suítes rodando agora (pid do grupo) — o processo morrendo leva elas junto, nunca ficam órfãs. */
const liveKids = new Set<number>();
/** Mata a árvore de um processo: grupo inteiro no Unix (kill -pid), `taskkill /T /F` no Windows. */
export function killTree(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, sig);
  } catch { /* já morreu */ }
}
let exitHooked = false;
/** SIGTERM/SIGINT viram process.exit (o 'exit' roda: mata as suítes filhas, solta travas). Idempotente. */
const exitCleanups = new Set<() => void>();
/** Limpeza que roda na SAÍDA (normal, SIGTERM, SIGINT): soltar o "rodando" do selo, travas, worktree temporária.
 * Síncrona (o 'exit' do node não espera promessa). Devolve quem tira a limpeza no caminho normal. */
export function onExitCleanup(fn: () => void): () => void {
  exitOnSignals();
  exitCleanups.add(fn);
  return () => { exitCleanups.delete(fn); };
}
export function exitOnSignals(): void {
  if (exitHooked) return;
  exitHooked = true;
  // primeiro as suítes filhas morrem; depois a limpeza (selo, travas, worktree da base)
  process.on("exit", () => {
    for (const p of liveKids) killTree(p, "SIGKILL");
    for (const f of [...exitCleanups]) { try { f(); } catch { /* segue limpando o resto */ } }
  });
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    if (process.listenerCount(sig) === 0) process.once(sig, () => process.exit(code));
  }
}

/** Trava em arquivo que SOME se o processo morrer (exit, SIGTERM, SIGINT). Devolve quem solta antes, no caminho normal. */
export function releaseOnExit(path: string): () => void {
  const free = () => { try { rmSync(path, { force: true }); } catch { /* já foi */ } };
  process.on("exit", free);
  exitOnSignals();
  return () => { process.off("exit", free); free(); };
}

function spawnCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean; spawnErr?: string }> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let out = "";
    let timedOut = false;
    let settled = false;
    const keep = (b: Buffer) => { out += b.toString("utf8"); if (out.length > 400_000) out = out.slice(-200_000); };
    let cp: ReturnType<typeof spawn>;
    // NODE_TEST_CONTEXT herdado (o motor rodando dentro de um `node --test`) faz o node:test do projeto falar o
    // protocolo interno com o pai e sair 0 — a suíte do projeto precisa rodar como se fosse a primeira
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env.NODE_TEST_CONTEXT;
    try {
      // Windows: nada de shell:true com nomes vindos do diff — cmd.exe /d /s /c com cada argumento escapado
      cp = win
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map(winArg).join(" ")}"`], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true })
        : spawn(cmd, args, { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", timedOut: false, spawnErr: (e as Error).message });
      return;
    }
    const pid = cp.pid;
    if (pid) { liveKids.add(pid); exitOnSignals(); }
    const kill = (sig: NodeJS.Signals) => { if (pid) killTree(pid, sig); else { try { cp.kill(sig); } catch { /* já morreu */ } } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 3000).unref(); }, timeoutMs);
    const done = () => { if (pid) liveKids.delete(pid); };
    cp.stdout?.on("data", keep);
    cp.stderr?.on("data", keep);
    cp.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer); done();
      resolve({ code: null, out, timedOut: false, spawnErr: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} não encontrado` : e.message });
    });
    cp.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); done();
      resolve({ code, out, timedOut });
    });
  });
}

/** Nomes dos testes que falharam, lidos da saída (TAP `not ok`, jest `●`, pytest `FAILED x::y`, cargo `... FAILED`,
 * go `--- FAIL:`, XCTest `Test Case '…' failed`). null = nenhum nome legível. */
export function parseFailedNames(kind: RunnerKind | string, output: string): string[] | null {
  const out = String(output ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const all = (re: RegExp) => [...out.matchAll(re)].map((m) => m[1].trim());
  let names: string[];
  if (kind === "cargo") names = all(/^test (\S+) \.\.\. FAILED/gm);
  else if (kind === "go") names = all(/^\s*--- FAIL: (\S+)/gm);
  else if (kind === "pytest") names = all(/^(?:FAILED|ERROR) (\S+)/gm);
  else if (kind === "swift") names = [...all(/Test Case '([^']+)' failed/g), ...all(/✘ Test (\S+?)(?:\(\))? (?:recorded|failed)/g)];
  else names = [
    ...[...out.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].filter((m) => !/#\s*(SKIP|TODO)\b/i.test(m[1])).map((m) => m[1].trim()),
    ...all(/^\s*● (.+?)\s*$/gm).filter((n) => !/^Test suite failed to run$/i.test(n)),
  ];
  const uniq = [...new Set(names.filter(Boolean))];
  return uniq.length ? uniq : null;
}

/** A suíte caiu por AMBIENTE (comando/módulo ausente, banco fora do ar), não por um teste? */
export function isEnvFailure(output: string): boolean {
  return /command not found|: not found\b|\bENOENT\b|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named|could not connect to (server|database)|ECONNREFUSED|database "?[\w-]+"? does not exist|no such table|linker `?cc`? not found|could not find `?Cargo\.toml/i.test(String(output ?? ""));
}

/**
 * A falha da tarefa é NOVA em relação à base? `fresh:false` = a main já falhava igual → vira aviso no selo, não reprova.
 * Compara os NOMES dos testes que falharam; sem nomes, a contagem (`real.failed > base.failed`); sem contagem, só a
 * falha de ambiente igual dos dois lados vira aviso.
 */
export function compareWithBase(t: TestRun, b: TestRun | null): { fresh: boolean; novos?: string[]; warn?: string } {
  if (!b || !b.ran || b.timedOut || b.passed) return { fresh: true };
  const pl = (n: number) => `a main já tinha ${n} teste${n === 1 ? "" : "s"} falhando`;
  if (t.failedNames && b.failedNames) {
    const novos = t.failedNames.filter((n) => !b.failedNames!.includes(n));
    return novos.length ? { fresh: true, novos } : { fresh: false, warn: pl(b.failedNames.length) };
  }
  if (t.counts && b.counts) return t.counts.failed > b.counts.failed ? { fresh: true } : { fresh: false, warn: pl(b.counts.failed) };
  if (t.envFail && b.envFail) return { fresh: false, warn: "a suíte não roda neste ambiente (a main falha igual)" };
  return { fresh: true };
}

/** Pastas de dependência que a tarefa ganhou por link (seedWorktreeEnv) — a worktree da base usa as MESMAS. */
const DEP_DIRS = ["node_modules", ".venv", "venv", "frontend/node_modules", "backend/node_modules", "backend/.venv", "backend/venv"];
const baseInflight = new Map<string, Promise<TestRun | null>>();
/** Pasta do cache da suíte da base, por repositório (compartilhado entre as tarefas). */
export function baselineDir(repo: string): string {
  let id = repo;
  try { id = realpathSync(repo); } catch { /* repo sumiu */ }
  return join(homedir(), ".cardume", "baseline", createHash("sha1").update(id).digest("hex").slice(0, 16));
}
function readBaseCache(file: string): TestRun | null {
  try { const j = JSON.parse(readFileSync(file, "utf8")); return j && j.run ? (j.run as TestRun) : null; } catch { return null; }
}

/**
 * Roda a suíte no MERGE-BASE (worktree destacada e descartável, com as mesmas deps linkadas da tarefa). Preguiçoso:
 * só é chamado quando a suíte da tarefa falha. Cache em ~/.cardume/baseline/<repo>/<sha>.json; um SHA roda uma vez
 * só por vez (mesmo processo: a mesma promessa; outro processo: trava em arquivo).
 */
export async function baselineRun(o: { repo: string; worktree: string; baseSha: string; timeoutMs: number; runner?: Runner | null; planSig?: string; run?: (dir: string, x: { timeoutMs: number; runner?: Runner | null }) => Promise<TestRun> }): Promise<TestRun | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(o.baseSha)) return null;
  const dir = baselineDir(o.repo);
  // modo afetado: o MESMO conjunto afetado roda na base — o cache é por SHA + plano (a suíte inteira fica sem sufixo)
  const suffix = o.planSig && !o.planSig.startsWith("inteira:") ? "-" + createHash("sha1").update(o.planSig).digest("hex").slice(0, 10) : "";
  const file = join(dir, `${o.baseSha}${suffix}.json`);
  const going = baseInflight.get(file);
  if (going) return going;
  const p = (async (): Promise<TestRun | null> => {
    const hit = readBaseCache(file);
    if (hit) return hit;
    mkdirSync(dir, { recursive: true });
    const lock = `${file}.lock`;
    const until = Date.now() + o.timeoutMs + 60_000;
    for (;;) {
      try { closeSync(openSync(lock, "wx")); break; } catch { /* outro processo rodando esta base */ }
      try { if (Date.now() - statSync(lock).mtimeMs > o.timeoutMs + 120_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      const c = readBaseCache(file);
      if (c) return c;
      if (Date.now() > until) return null;
      await sleep(500);
    }
    const tmp = mkdtempSync(join(tmpdir(), "starfork-base-"));
    const wt = join(tmp, "wt");
    // morto no meio (SIGTERM): a trava da base e a worktree temporária não ficam pra trás
    const undo = onExitCleanup(() => {
      rmSync(lock, { force: true });
      rmSync(tmp, { recursive: true, force: true });
      spawnSync("git", ["-C", o.repo, "worktree", "prune"], { stdio: "ignore", timeout: 5000 });
    });
    try {
      const again = readBaseCache(file);
      if (again) return again;
      await runCmd("git", ["-C", o.repo, "worktree", "add", "--detach", wt, o.baseSha], { timeout: 60_000 });
      for (const d of DEP_DIRS) {
        try { if (existsSync(join(o.worktree, d)) && !existsSync(join(wt, d))) symlinkSync(realpathSync(join(o.worktree, d)), join(wt, d)); } catch { /* sem a pasta */ }
      }
      const r = await (o.run ?? runTests)(wt, o.runner !== undefined ? { timeoutMs: o.timeoutMs, runner: o.runner } : { timeoutMs: o.timeoutMs });
      if (!r.timedOut) {
        const keep = { ...r, failedNames: r.failedNames?.map((n) => n.split(wt).join("<repo>")) ?? r.failedNames, tail: (r.tail ?? "").slice(-4000) };
        writeFileSync(file, JSON.stringify({ sha: o.baseSha, at: Date.now(), run: keep }));
        return keep;
      }
      return r;
    } catch {
      return null; // não deu pra montar a base (sha sumiu, git ocupado): sem comparação, a regra de sempre vale
    } finally {
      await runCmd("git", ["-C", o.repo, "worktree", "remove", "--force", wt]).catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
      await runCmd("git", ["-C", o.repo, "worktree", "prune"]).catch(() => undefined);
      rmSync(lock, { force: true });
      undo();
    }
  })().finally(() => baseInflight.delete(file));
  baseInflight.set(file, p);
  return p;
}

export interface GateInput {
  worktree: string;
  /** a tarefa PEDIU testes (autonomy.runTests / artefato tests): timeout reprova e docs-only não pula */
  wantsTests: boolean;
  changed: string[];
  /** o que o agente afirmou (requirements.json › tests, mensagem final) */
  claims: Array<Claim | null>;
  timeoutMs: number;
  /** HEAD da worktree agora + mudança solta (fora de .cardume) — mesma versão já verificada não roda de novo */
  sha?: string;
  dirty?: boolean;
  prev?: Verification | null;
  /** o CI do PR que o vigia do app gravou (spec.ciGate.ci) — entra no selo junto com os testes */
  ci?: Verification["ci"];
  /** onda 1.1: o plano (só os afetados, ou a suíte inteira) — ausente = detecta e roda a inteira, como antes */
  plan?: { scope: "afetados" | "inteira"; runner: Runner | null; sig: string; ci?: boolean };
  /** injetável nos testes */
  run?: (dir: string, o: { timeoutMs: number; runner?: Runner | null }) => Promise<TestRun>;
  /** suíte da base (merge-base), chamada SÓ quando a da tarefa falha — sem ela, qualquer falha reprova */
  baseline?: (r: TestRun) => Promise<TestRun | null>;
}
export interface GateResult {
  reasons: string[];
  verification: Verification;
  divergence: string | null;
  run: TestRun | null;
  /** a suíte NÃO rodou agora (pulou por docs-only, ou reaproveitou a verificação da mesma versão) */
  note?: string;
}

/** A parte de TESTES do portão: roda (ou pula com motivo), compara o relato e monta o selo. Não grava nada. */
export async function testGate(g: GateInput): Promise<GateResult> {
  const reasons: string[] = [];
  const ci = g.ci ?? g.prev?.ci ?? null;
  const skip = g.wantsTests ? null : skipReason(g.changed);
  if (skip) {
    return { reasons, divergence: null, run: null, note: skip, verification: { tests: { passed: null, failed: null, ran: false, runner: "", ok: true, skipped: skip }, ci, divergente: false, at: Date.now() } };
  }
  // mesma versão do código já verificada (fim de turno de conversa, sem commit novo): reaproveita o resultado
  const p = g.prev;
  if (p && p.tests && p.tests.ran && !p.tests.timedOut && g.sha && p.sha === g.sha && !g.dirty && (p.tests.planSig ?? "") === (g.plan?.sig ?? p.tests.planSig ?? "")) {
    if (!p.tests.ok && !p.tests.baseWarn) reasons.push(`os testes falharam: ${p.tests.runner}${p.tests.passed != null ? ` (${p.tests.passed}/${(p.tests.passed ?? 0) + (p.tests.failed ?? 0)} passaram)` : ""}`);
    // a divergência é recalculada contra o relato ATUAL (o motivo antigo não se repete)
    const real = p.tests.passed != null && p.tests.failed != null ? { passed: p.tests.passed, failed: p.tests.failed } : null;
    let div: string | null = null;
    for (const c of g.claims) { div = claimDivergence(c, real); if (div) break; }
    if (div) reasons.push(div);
    const { relato: _old, ...rest } = p;
    void _old;
    return { reasons, divergence: div && div !== p.relato ? div : null, run: null, note: "mesma versão já verificada — a suíte não rodou de novo", verification: { ...rest, ci, divergente: !!div, ...(div ? { relato: div } : {}) } };
  }
  const r = await (g.run ?? runTests)(g.worktree, g.plan ? { timeoutMs: g.timeoutMs, runner: g.plan.runner } : { timeoutMs: g.timeoutMs });
  let divergence: string | null = null;
  if (r.ran && !r.timedOut) {
    for (const c of g.claims) { divergence = claimDivergence(c, r.counts ?? null); if (divergence) break; }
  }
  let baseWarn: string | undefined;
  if (r.timedOut && !g.wantsTests) {
    // a tarefa não pediu testes: suíte lenta não trava a entrega — fica registrado no selo
  } else if (r.ran && !r.passed) {
    // falhou: a main já falhava igual? (preguiçoso — a base só roda agora)
    const cmp = !r.timedOut && g.baseline ? compareWithBase(r, await g.baseline(r).catch(() => null)) : { fresh: true } as ReturnType<typeof compareWithBase>;
    if (cmp.fresh) reasons.push(`os testes falharam: ${r.detail}${cmp.novos?.length ? ` — falha nova em relação à main: ${cmp.novos.slice(0, 5).join(", ")}${cmp.novos.length > 5 ? "…" : ""}` : ""}`);
    else baseWarn = cmp.warn;
  }
  if (divergence) reasons.push(divergence);
  const tests = r.ran || r.timedOut
    ? { passed: r.counts?.passed ?? null, failed: r.counts?.failed ?? null, ran: r.ran, runner: r.runner ?? "", ok: r.passed, ...(r.timedOut ? { timedOut: true } : {}), ...(baseWarn ? { baseWarn } : {}),
        ...(g.plan ? { scope: g.plan.scope, planSig: g.plan.sig, ...(g.plan.ci ? { ci: true } : {}) } : {}), ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
        ...((g.plan?.runner?.kind ?? r.kind) ? { kind: g.plan?.runner?.kind ?? r.kind } : {}), ...(g.plan?.runner ? { cmdLine: [g.plan.runner.cmd, ...g.plan.runner.args].join(" ") } : {}) }
    : r.runner ? { passed: null, failed: null, ran: false, runner: r.runner, ok: true, skipped: r.detail } : null;
  return {
    reasons, divergence, run: r,
    verification: { tests, ci, divergente: !!divergence, ...(divergence ? { relato: divergence } : {}), ...(g.sha && !g.dirty ? { sha: g.sha } : {}), at: Date.now() },
  };
}
