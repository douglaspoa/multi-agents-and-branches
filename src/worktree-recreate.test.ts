// node --test src/worktree-recreate.test.ts  (npm test)
// Retomar conversa depois do merge: a worktree removida é RECRIADA no mesmo
// caminho. Roda contra repos git TEMPORÁRIOS (origin bare + clone) — nunca
// toca projeto real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "./git.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { TaskSpec } from "./types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** origin bare + clone com main publicada. */
function setup(): { root: string; repo: string; origin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-wt-")));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { root, repo, origin };
}

/** Cria worktree+branch, commita um arquivo, (opcional) publica a branch. */
function work(repo: string, wt: string, branch: string, file: string, push = false): void {
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "main");
  writeFileSync(join(wt, file), "feito pela tarefa\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `tarefa: ${file}`);
  if (push) git(wt, "push", "-q", "origin", branch);
}

/** Squash-merge na main + push + remove worktree + apaga branch (local e remota) — o padrão do app. */
function squashMergeAndClean(repo: string, wt: string, branch: string): void {
  git(repo, "merge", "-q", "--squash", branch);
  git(repo, "commit", "-q", "-m", `squash ${branch}`);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "worktree", "remove", "--force", wt);
  git(repo, "branch", "-q", "-D", branch);
  try { git(repo, "push", "-q", "origin", "--delete", branch); } catch { /* não publicada */ }
  git(repo, "fetch", "-q", "--prune", "origin");
}

test("mergeada (squash + branch apagada): recria no MESMO caminho numa branch -cont com o conteúdo da main", async () => {
  const { root, repo } = setup();
  try {
    const wt = join(repo, ".cardume", "worktrees", "t1");
    work(repo, wt, "agent/t1", "feature.txt", true);
    squashMergeAndClean(repo, wt, "agent/t1");
    assert.equal(existsSync(wt), false);

    const r = await new GitService(repo).recreateWorktree(wt, { branch: "agent/t1", base: "main", merged: true });
    assert.equal(r.branch, "agent/t1-cont");
    assert.equal(r.reused, false);
    assert.equal(r.from, "origin/main");
    assert.ok(existsSync(join(wt, ".git")), "worktree existe de novo no mesmo caminho");
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "agent/t1-cont");
    assert.equal(readFileSync(join(wt, "feature.txt"), "utf8"), "feito pela tarefa\n", "o trabalho mergeado está lá");
    assert.equal(git(wt, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));

    // segunda retomada depois de outro merge: -cont2 (não reaproveita nome com PR mergeado)
    git(wt, "push", "-q", "origin", "agent/t1-cont");
    git(repo, "worktree", "remove", "--force", wt);
    const r2 = await new GitService(repo).recreateWorktree(wt, { branch: "agent/t1-cont", base: "main", merged: true });
    assert.equal(r2.branch, "agent/t1-cont2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("não mergeada, branch local existe (liberar espaço): reusa a branch com os commits", async () => {
  const { root, repo } = setup();
  try {
    const wt = join(repo, ".cardume", "worktrees", "t2");
    work(repo, wt, "agent/t2", "wip.txt");
    const head = git(wt, "rev-parse", "HEAD");
    git(repo, "worktree", "remove", "--force", wt);
    const r = await new GitService(repo).recreateWorktree(wt, { branch: "agent/t2", base: "main", merged: false });
    assert.deepEqual(r, { branch: "agent/t2", from: "agent/t2", reused: true });
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
    assert.ok(existsSync(join(wt, "wip.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("não mergeada, só existe no origin: busca e recria a partir de origin/<branch>", async () => {
  const { root, repo } = setup();
  try {
    const wt = join(repo, ".cardume", "worktrees", "t3");
    work(repo, wt, "agent/t3", "remote.txt", true);
    const head = git(wt, "rev-parse", "HEAD");
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-q", "-D", "agent/t3");
    git(repo, "update-ref", "-d", "refs/remotes/origin/agent/t3");
    const r = await new GitService(repo).recreateWorktree(wt, { branch: "agent/t3", base: "main", merged: false });
    assert.deepEqual(r, { branch: "agent/t3", from: "origin/agent/t3", reused: true });
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orquestrador: tarefa mergeada sem worktree → recria, troca a branch, arquiva o PR e avisa no chat", async () => {
  const { root, repo } = setup();
  const orch = new Orchestrator(repo);
  try {
    const spec = {
      id: "t4", title: "t4", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "mock", agent: "Vega", roles: [], light: true, base: "main",
    } as unknown as TaskSpec;
    const task = await orch.createTask(spec);
    writeFileSync(join(task.worktree, "x.txt"), "x\n");
    git(task.worktree, "add", "x.txt");
    git(task.worktree, "commit", "-q", "-m", "x");
    git(task.worktree, "push", "-q", "origin", task.branch);
    const s = JSON.parse(orch.store.getTask("t4")!.spec_json);
    s.prUrl = "https://github.com/o/r/pull/1";
    orch.store.updateSpec("t4", JSON.stringify(s));
    squashMergeAndClean(repo, task.worktree, task.branch);
    orch.store.setStatus("t4", "merged");

    assert.equal(await orch.ensureTaskWorktree("t4"), true);
    const after = orch.store.getTask("t4")!;
    assert.equal(after.worktree, task.worktree, "mesmo caminho → --resume da sessão continua valendo");
    assert.equal(after.branch, `${task.branch}-cont`);
    assert.ok(existsSync(join(after.worktree, ".cardume", "TASK.yaml")));
    assert.ok(existsSync(join(after.worktree, "x.txt")));
    const sp = JSON.parse(after.spec_json);
    assert.equal(sp.prUrl, undefined);
    assert.deepEqual(sp.prHistory, ["https://github.com/o/r/pull/1"]);
    const notes = orch.store.eventsForTask("t4").map((e) => e.text);
    assert.ok(notes.some((t) => /^Recriei a cópia de trabalho desta tarefa a partir de origin\/main — a conversa continua\.$/.test(t)), notes.join("\n"));
    // já existe → não mexe
    assert.equal(await orch.ensureTaskWorktree("t4"), false);
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumo IA do commit: ENOENT do claude vira texto pt-BR que o catálogo do app reconhece", async () => {
  const { claudeErrText, claudeEnv } = await import("./engine/claude.ts");
  const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const txt = claudeErrText(err);
  assert.doesNotMatch(txt, /spawn claude ENOENT/);
  // mesmo regex do ERR_CATALOG 'claude-missing' (app/src/js/00-util.js)
  assert.match(txt, /claude (code )?n[aã]o (est[aá] )?instalado/i);
  const env = claudeEnv();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
});
