// node --test src/ondas-epico.test.ts  (npm test)
// Bug das ONDAS de épico (15/10): a tarefa da onda seguinte começava sem o código da anterior e, às vezes, na MESMA
// branch de um épico anterior. Aqui: repo git TEMPORÁRIO (origin bare + clone), loja fictícia, nunca projeto real.
// O portão da onda (o que conta como "concluída") é testado em app/tests/epico-ondas.test.mjs; aqui fica o lado do git:
// cada tarefa nasce com pasta e branch PRÓPRIAS, da main FRESCA do origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "./git.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { TaskSpec } from "./types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-ondas-")));
  const origin = join(root, "origin.git");
  const repo = join(root, "loja");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "ana@loja.test");
  git(repo, "config", "user.name", "Ana");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "loja fictícia\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { root, repo };
}

const spec = (id: string, title: string, o: Partial<TaskSpec> = {}): TaskSpec => ({
  id, title, objective: title, deliverables: [], requirements: [],
  scope: { owns: [], offLimits: [] },
  autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
  engine: "mock", agent: "Vega", roles: [], light: true, branchType: "feat", ...o,
} as unknown as TaskSpec);

/** commita um arquivo na worktree da tarefa e publica a branch (= o PR aberto, ainda NÃO integrado) */
function commitAndPush(wt: string, branch: string, file: string): void {
  writeFileSync(join(wt, file), "feito\n");
  git(wt, "add", file);
  git(wt, "commit", "-q", "-m", `tarefa: ${file}`);
  git(wt, "push", "-q", "origin", branch);
}

test("épico anterior deixou feat/<slug> no origin: a tarefa nova ganha branch PRÓPRIA (-2), da main, sem o código do outro", async () => {
  const { root, repo } = setup();
  const orch = new Orchestrator(repo);
  try {
    // épico 1 (LOJA-1…): "Tela de login" publicou a branch e o PR foi mergeado no GitHub, mas a branch ficou no origin
    // (o GitHub não apaga sozinho) e a tarefa não existe mais NESTA máquina (outra pessoa/outra máquina/apagada)
    const velho = await orch.createTask(spec("tela-de-login", "Tela de login"));
    assert.equal(velho.branch, "feat/tela-de-login");
    commitAndPush(velho.worktree, velho.branch, "login-velho.txt");
    git(repo, "worktree", "remove", "--force", velho.worktree);
    git(repo, "branch", "-q", "-D", velho.branch);
    orch.store.db.prepare("DELETE FROM task WHERE id = ?").run("tela-de-login");

    // épico 2: um cartão com o MESMO título — antes nascia em feat/tela-de-login e o `gh pr view <branch>` achava o PR
    // MERGEADO do épico 1 (a tarefa virava "integrada" e a onda seguinte começava sem nada)
    const novo = await orch.createTask(spec("tela-de-login", "Tela de login"));
    assert.equal(novo.branch, "feat/tela-de-login-2", "nunca a branch de outro épico");
    assert.equal(git(novo.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/tela-de-login-2");
    assert.ok(!existsSync(join(novo.worktree, "login-velho.txt")), "nasce da main, sem o código do épico anterior");
    assert.equal(git(novo.worktree, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
    const notes = orch.store.eventsForTask("tela-de-login").map((e) => e.text);
    assert.ok(notes.some((t) => /a branch feat\/tela-de-login já existia .* esta tarefa usa feat\/tela-de-login-2/.test(t)), notes.join("\n"));
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch só LOCAL (tarefa apagada daqui) também não é reaproveitada; -2 ocupada → -3", async () => {
  const { root, repo } = setup();
  try {
    git(repo, "branch", "feat/catalogo");
    git(repo, "branch", "feat/catalogo-2");
    const g = new GitService(repo);
    assert.equal(await g.freeBranch("feat/catalogo"), "feat/catalogo-3");
    assert.equal(await g.freeBranch("feat/carrinho"), "feat/carrinho", "livre: o nome de sempre");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pasta de trabalho de outra tarefa no caminho: recusa sem criar nada (nunca reaproveita a worktree de outra)", async () => {
  const { root, repo } = setup();
  const orch = new Orchestrator(repo);
  try {
    const wt = orch.ws.worktreePath("checkout");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "sobra.txt"), "de outra tarefa\n");
    await assert.rejects(orch.createTask(spec("checkout", "Checkout")), /já existe \(de outra tarefa\)/);
    assert.equal(orch.store.getTask("checkout"), undefined);
    assert.ok(!git(repo, "branch", "--list", "feat/checkout"), "nenhuma branch criada");
    // id repetido no banco também recusa (o app sufixa o id antes — lib.rs new_task)
    await orch.createTask(spec("frete", "Frete"));
    await assert.rejects(orch.createTask(spec("frete", "Frete")), /já existe uma tarefa com o id frete/);
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("onda 2 depois que o PR da onda 1 é INTEGRADO: nasce da main fresca, com o código da onda 1, em branch própria", async () => {
  const { root, repo } = setup();
  const orch = new Orchestrator(repo);
  try {
    const a = await orch.createTask(spec("loja-1-catalogo", "Catálogo", { issueCode: "LOJA-1" } as Partial<TaskSpec>));
    assert.equal(a.branch, "feat/LOJA-1-loja-1-catalogo");
    commitAndPush(a.worktree, a.branch, "catalogo.txt");
    // PR aberto, ainda NÃO integrado: a main do origin não tem o catálogo — por isso o portão da onda espera
    assert.throws(() => git(repo, "cat-file", "-e", "origin/main:catalogo.txt"));
    // o PR é integrado no GitHub (merge na main do origin, feito por outra cópia)
    const other = join(root, "outra");
    execFileSync("git", ["clone", "-q", join(root, "origin.git"), other]);
    git(other, "config", "user.email", "bruno@loja.test"); git(other, "config", "user.name", "Bruno"); git(other, "config", "commit.gpgsign", "false");
    git(other, "merge", "-q", "--no-ff", "-m", "merge LOJA-1", `origin/${a.branch}`);
    git(other, "push", "-q", "origin", "main");
    // onda 2: a main LOCAL está velha (sem o merge) — a tarefa nasce da origin/main fresca, com o catálogo
    const b = await orch.createTask(spec("loja-2-carrinho", "Carrinho", { issueCode: "LOJA-2", after: ["loja-1-catalogo"], wave: 2 } as Partial<TaskSpec>));
    assert.ok(existsSync(join(b.worktree, "catalogo.txt")), "a onda 2 tem o código da onda 1");
    assert.notEqual(b.branch, a.branch);
    assert.notEqual(b.worktree, a.worktree);
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
