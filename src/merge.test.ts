// node --test src/merge.test.ts  (npm test)
// Merge pelo app: só é "em conflito" quando o git parou com conflito de verdade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator, mergeFailReason } from "./orchestrator.ts";
import type { TaskSpec } from "./types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-merge-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "app.txt"), "linha original\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  const spec = {
    id: "t-m", title: "muda app", objective: "x", deliverables: [], requirements: [],
    scope: { owns: [], offLimits: [] },
    autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
    engine: "mock", agent: "Vega", roles: [], light: true, base: "main",
  } as unknown as TaskSpec;
  const task = await orch.createTask(spec);
  writeFileSync(join(task.worktree, "app.txt"), "linha da tarefa\n");
  git(task.worktree, "commit", "-q", "-am", "tarefa");
  orch.store.setStatus("t-m", "review");
  return { root, repo, orch, task };
}

test("mudança local não commitada no repo principal: NÃO vira 'em conflito' e explica o motivo", async () => {
  const { root, repo, orch } = await setup();
  try {
    writeFileSync(join(repo, "app.txt"), "edição do humano, não commitada\n");
    await assert.rejects(orch.mergeTask("t-m"), /mudanças não commitadas no repositório principal/);
    assert.equal(orch.store.getTask("t-m")!.status, "review", "antes: ia pra 'conflict' sem conflito nenhum");
    assert.equal(git(repo, "status", "--porcelain"), "M app.txt", "a edição do humano fica intacta");
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflito de verdade: status 'conflict', merge abortado, repo limpo", async () => {
  const { root, repo, orch } = await setup();
  try {
    writeFileSync(join(repo, "app.txt"), "linha mudada na main\n");
    git(repo, "commit", "-q", "-am", "main mudou");
    await assert.rejects(orch.mergeTask("t-m"), /conflito ao mergear/);
    assert.equal(orch.store.getTask("t-m")!.status, "conflict");
    assert.equal(git(repo, "status", "--porcelain"), "");
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge limpo segue funcionando", async () => {
  const { root, repo, orch } = await setup();
  try {
    await orch.mergeTask("t-m");
    assert.equal(orch.store.getTask("t-m")!.status, "merged");
    assert.equal(git(repo, "show", "HEAD:app.txt"), "linha da tarefa");
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("motivos legíveis", () => {
  assert.match(mergeFailReason("merge: feat/x - not something we can merge"), /não existe mais/);
  assert.match(mergeFailReason("fatal: You have not concluded your merge (MERGE_HEAD exists)."), /merge em andamento/);
  assert.equal(mergeFailReason("Command failed: git merge\nfatal: algo novo"), "algo novo");
});
