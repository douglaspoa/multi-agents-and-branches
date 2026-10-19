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
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
}
/** O selo de verificação que fica no spec (spec.verification) e o app mostra no cartão e na Revisão. */
export interface Verification {
  tests: { passed: number | null; failed: number | null; ran: boolean; runner: string; ok: boolean; timedOut?: boolean; skipped?: string } | null;
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

const TEST_WORD = /test|teste|su[ií]te|spec|pass|✓|✅/i;
/**
 * O que o agente AFIRMOU sobre os testes, num texto livre (mensagem final, requirements.json). Lê, nesta ordem:
 * "84 passed, 2 failed" / "Tests: 84 passed, 2 failed" · "86/86" (com palavra de teste na linha) · "86 passed" /
 * "86 testes passando" · "ALL PASSED" / "todos os testes passaram". Nada disso → null (não acusa ninguém).
 */
export function parseClaim(text: string): Claim | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  // par passou + falhou na mesma frase (em qualquer ordem)
  const pf = t.match(/(?<![\w.])(\d+)\s*(?:tests?\s*|testes?\s*)?(?:passed|passing|passaram|passando|ok)\b[^\n\d]{0,12}(\d+)\s*(?:tests?\s*|testes?\s*)?(?:failed|failing|falharam|falhando|falhou)/i);
  if (pf) return { passed: num(pf[1]), total: num(pf[1]) + num(pf[2]) };
  const fp = t.match(/(?<![\w.])(\d+)\s*(?:tests?\s*|testes?\s*)?(?:failed|failing|falharam|falhando)\b[^\n\d]{0,12}(\d+)\s*(?:tests?\s*|testes?\s*)?(?:passed|passing|passaram|passando)/i);
  if (fp) return { passed: num(fp[2]), total: num(fp[1]) + num(fp[2]) };
  // "86/86" ou "86 de 86" — só em linha que fala de teste (datas e "rodada 1/2" não contam)
  for (const line of t.split("\n")) {
    if (!TEST_WORD.test(line)) continue;
    const m = line.match(/(?<![\d/])(\d+)\s*(?:\/|de)\s*(\d+)(?![\d/])/);
    if (m && num(m[2]) > 0 && num(m[1]) <= num(m[2])) return { passed: num(m[1]), total: num(m[2]) };
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
 * O relato bate com o real? Devolve o motivo exato quando NÃO bate; null quando bate ou não dá pra comparar.
 * Real todo verde + relato sem falha = não acusa mesmo com número diferente (o agente rodou só um pedaço da suíte).
 */
export function claimDivergence(claim: Claim | null, real: Counts | null): string | null {
  if (!claim || !real) return null;
  const realTotal = real.passed + real.failed;
  if (claim.allPassed) return real.failed > 0 ? `o agente relatou todos os testes passando, a execução real deu ${fmtCounts(real)}` : null;
  if (claim.passed == null) return null;
  const total = claim.total ?? claim.passed;
  const claimGreen = claim.passed === total;
  if (real.failed === 0 && claimGreen) return null;
  if (claim.passed === real.passed && total === realTotal) return null;
  return `o agente relatou ${claim.passed}/${total}, a execução real deu ${fmtCounts(real)}`;
}

/** O que o agente afirmou: a fala mais recente dele DESDE a última mensagem da pessoa que tiver número. */
export function agentClaimFrom(events: Array<{ agent: string; type: string; text: string }>): { claim: Claim; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const txt = String(e.text ?? "");
    if (e.agent === "Você" || /^Você:\s*/.test(txt)) break; // pedido novo da pessoa: o relato velho não vale mais
    if (e.agent === "Sistema" || !["done", "think", "note"].includes(e.type)) continue;
    const claim = parseClaim(txt);
    if (claim) return { claim, text: txt };
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
  const r = await spawnCapture(runner.cmd, runner.args, dir, timeoutMs);
  const counts = parseCounts(runner.kind, r.out);
  const tail = tailOf(r.out);
  const base = { runner: runner.label, kind: runner.kind, counts, tail };
  if (r.timedOut) return { ...base, ran: true, passed: false, timedOut: true, detail: `${runner.label} estourou o tempo (${Math.round(timeoutMs / 1000)}s)` };
  if (r.spawnErr) return { ...base, ran: false, passed: true, detail: `${runner.label} não está instalado nesta máquina (${r.spawnErr})` };
  if (r.code === 0 && !(counts && counts.failed > 0)) return { ...base, ran: true, passed: true, detail: counts ? `${runner.label} passou (${fmtCounts(counts)})` : `${runner.label} passou` };
  const why = counts ? `${fmtCounts(counts)} passaram` : tailOf(r.out, 3).slice(0, 160) || `saiu com código ${r.code}`;
  return { ...base, ran: true, passed: false, detail: `${runner.label}: ${why}` };
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
      cp = spawn(cmd, args, { cwd, detached: !win, shell: win, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", timedOut: false, spawnErr: (e as Error).message });
      return;
    }
    const killTree = (sig: NodeJS.Signals) => {
      try { if (!win && cp.pid) process.kill(-cp.pid, sig); else cp.kill(sig); } catch { /* já morreu */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree("SIGTERM"); setTimeout(() => killTree("SIGKILL"), 3000).unref(); }, timeoutMs);
    cp.stdout?.on("data", keep);
    cp.stderr?.on("data", keep);
    cp.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: null, out, timedOut: false, spawnErr: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} não encontrado` : e.message });
    });
    cp.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
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
  /** injetável nos testes */
  run?: (dir: string, o: { timeoutMs: number }) => Promise<TestRun>;
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
  if (p && p.tests && p.tests.ran && !p.tests.timedOut && g.sha && p.sha === g.sha && !g.dirty) {
    if (!p.tests.ok) reasons.push(`os testes falharam: ${p.tests.runner}${p.tests.passed != null ? ` (${p.tests.passed}/${(p.tests.passed ?? 0) + (p.tests.failed ?? 0)} passaram)` : ""}`);
    if (p.divergente && p.relato) reasons.push(p.relato);
    return { reasons, divergence: null, run: null, note: "mesma versão já verificada — a suíte não rodou de novo", verification: { ...p, ci } };
  }
  const r = await (g.run ?? runTests)(g.worktree, { timeoutMs: g.timeoutMs });
  let divergence: string | null = null;
  if (r.ran && !r.timedOut) {
    for (const c of g.claims) { divergence = claimDivergence(c, r.counts ?? null); if (divergence) break; }
  }
  if (r.timedOut && !g.wantsTests) {
    // a tarefa não pediu testes: suíte lenta não trava a entrega — fica registrado no selo
  } else if (r.ran && !r.passed) reasons.push(`os testes falharam: ${r.detail}`);
  if (divergence) reasons.push(divergence);
  const tests = r.ran || r.timedOut
    ? { passed: r.counts?.passed ?? null, failed: r.counts?.failed ?? null, ran: r.ran, runner: r.runner ?? "", ok: r.passed, ...(r.timedOut ? { timedOut: true } : {}) }
    : r.runner ? { passed: null, failed: null, ran: false, runner: r.runner, ok: true, skipped: r.detail } : null;
  return {
    reasons, divergence, run: r,
    verification: { tests, ci, divergente: !!divergence, ...(divergence ? { relato: divergence } : {}), ...(g.sha && !g.dirty ? { sha: g.sha } : {}), at: Date.now() },
  };
}
