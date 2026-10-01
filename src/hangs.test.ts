// node --test src/hangs.test.ts  (npm test)
// Travamentos por falta de teto: processo neto segurando pipe, fetch pendurado, setup.sh que não
// termina, claude auxiliar pendurado. Repos e HOME TEMPORÁRIOS — nunca toca projeto real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./util/run.ts";
import { GitService } from "./git.ts";
import { Orchestrator, prUrlFrom } from "./orchestrator.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

// scripts falsos com shebang, sleep e sinais POSIX: não valem no Windows
const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repoTmp(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-hang-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { root, repo };
}

/** Seta envs só durante `fn` (restaura chave a chave). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test("run(): processo que deixa um neto segurando o stdout NÃO trava a promessa", POSIX, async () => {
  const t0 = Date.now();
  const r = await run("bash", ["-c", "sleep 20 & echo pronto"]);
  assert.equal(r.stdout.trim(), "pronto");
  assert.equal(r.truncated, true, "cortado por causa do neto: marcado");
  // saída GRANDE normal: nada é cortado nem marcado
  const big = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"]);
  assert.equal(big.stdout.length, 5 * 1024 * 1024);
  assert.equal(big.truncated, undefined);
  assert.ok(Date.now() - t0 < 8000, `demorou ${Date.now() - t0}ms (antes: esperava o neto, 20s)`);
});

test("base fresca com remoto que não responde: a criação da tarefa segue com a base local", POSIX, async () => {
  const { root, repo } = repoTmp();
  try {
    git(repo, "remote", "add", "origin", "ssh://git@example.invalid/x.git");
    const t0 = Date.now();
    // GIT_SSH_COMMAND = "sleep 30": simula a conexão pendurada (VPN caída, host que não responde)
    const ref = await withEnv({ GIT_SSH_COMMAND: "sleep 30", CARDUME_NET_TIMEOUT_MS: "800" }, () => new GitService(repo).freshBaseRef("main"));
    assert.equal(ref, "main");
    assert.ok(Date.now() - t0 < 8000, `demorou ${Date.now() - t0}ms (antes: sem teto)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup.sh do projeto que não termina: a tarefa nasce e o AMBIENTE.md avisa que o setup não completou", POSIX, async () => {
  const { root, repo } = repoTmp();
  const orch = new Orchestrator(repo);
  try {
    writeFileSync(join(repo, ".cardume", "setup.sh"), "echo subindo; sleep 30\n");
    const spec = {
      id: "t-setup", title: "t", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "mock", agent: "Vega", roles: [], base: "main",
    } as unknown as TaskSpec;
    const t0 = Date.now();
    const task = await withEnv({ CARDUME_SETUP_TIMEOUT_MS: "600" }, () => orch.createTask(spec));
    assert.ok(Date.now() - t0 < 10_000, `demorou ${Date.now() - t0}ms`);
    const amb = readFileSync(join(task.worktree, ".cardume", "AMBIENTE.md"), "utf8");
    assert.match(amb, /setup\.sh NÃO completou \(passou de 1s e foi interrompido\)/);
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude auxiliar (destilador/resumo) pendurado: desiste no teto em vez de prender o processo", POSIX, async () => {
  const { root, repo } = repoTmp();
  const orch = new Orchestrator(repo);
  const H = tempHome(); // IA padrão do dev (ex.: Codex) não vaza pro teste
  try {
    const fake = join(root, "claude-lento.sh");
    writeFileSync(fake, "#!/bin/sh\nsleep 30\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: fake, CARDUME_AUX_TIMEOUT_MS: "500" }, () => (orch as unknown as { aux(p: string): Promise<string> }).aux("oi"));
    assert.equal(out, "");
    assert.ok(Date.now() - t0 < 8000, `demorou ${Date.now() - t0}ms`);
    // o resumo do commit (dentro do pipeline, com o lock da tarefa) também tem teto e registra a falha
    mkdirSync(join(repo, ".cardume"), { recursive: true });
    orch.store.createTask({ id: "t-sum", title: "t", objective: "o", agent: "A", roles: [], engine: "claude" } as unknown as TaskSpec, "b", repo, "main");
    const head = git(repo, "rev-parse", "HEAD");
    await withEnv({ HOME: H.home, CARDUME_CLAUDE: fake, CARDUME_AUX_TIMEOUT_MS: "500" }, () =>
      (orch as unknown as { summarizeCommit(t: string, h: string, w: string, s: unknown): Promise<void> }).summarizeCommit("t-sum", head, repo, { objective: "o", agent: "A" }));
    assert.ok(orch.store.eventsForTask("t-sum").some((e) => /resumo IA do commit falhou/.test(e.text)));
  } finally {
    H.cleanup();
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR já aberto pra branch: a URL sai do erro do gh (antes: 'falha ao abrir o PR' com o PR existindo)", () => {
  const err = 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/o/r/pull/42\n';
  assert.equal(prUrlFrom(err), "https://github.com/o/r/pull/42");
  assert.equal(prUrlFrom("Warning: 2 uncommitted changes\nhttps://github.com/o/r/pull/7\n"), "https://github.com/o/r/pull/7");
  assert.equal(prUrlFrom("erro qualquer"), "");
});

test("PR automático com PR já aberto (gh falso): registra 'PR aberto' com a URL do erro", POSIX, async () => {
  const { root, repo } = repoTmp();
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const gh = join(root, "gh-falso.sh");
  writeFileSync(gh, '#!/bin/sh\necho "a pull request for branch \\"$6\\" into branch \\"main\\" already exists:" >&2\necho "https://github.com/o/r/pull/42" >&2\nexit 1\n');
  chmodSync(gh, 0o755);
  const orch = new Orchestrator(repo);
  try {
    const spec = {
      id: "t-pr", title: "t", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "mock", agent: "Vega", roles: [], light: true, base: "main", autoPr: "auto", prBase: "main",
    } as unknown as TaskSpec;
    const task = await orch.createTask(spec);
    writeFileSync(join(task.worktree, "x.txt"), "x\n");
    git(task.worktree, "add", "x.txt");
    git(task.worktree, "commit", "-q", "-m", "x");
    await withEnv({ CARDUME_GH: gh }, () =>
      (orch as unknown as { maybeOpenPr(id: string, t: unknown, s: unknown): Promise<void> }).maybeOpenPr("t-pr", orch.store.getTask("t-pr"), spec));
    const texts = orch.store.eventsForTask("t-pr").map((e) => e.text);
    assert.ok(texts.includes("PR aberto automaticamente: https://github.com/o/r/pull/42"), texts.join("\n"));
    assert.ok(!texts.some((t) => /falha ao abrir o PR/.test(t)));
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
