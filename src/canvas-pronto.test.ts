// node --test src/canvas-pronto.test.ts  (npm test)
// 03/10 "nem o canva está pronto": (1) o número da tarefa contava o avanço da main local defasada;
// (2) servidor de prévia rodando numa worktree removida ficava órfão servindo 404 (Prévia branca).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "./git.ts";
import { killInDir, parseLsofCwd, procsInDir } from "./orfaos.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, lines: number, msg: string) => {
  writeFileSync(join(cwd, file), Array.from({ length: lines }, (_, i) => "linha " + i).join("\n") + "\n");
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg);
};

test("diffStat: main LOCAL defasada não entra no número da tarefa (conta do ponto de bifurcação real)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-diffstat-")));
  try {
    const up = join(root, "up"), repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", up]); git(up, "config", "user.email", "t@t"); git(up, "config", "user.name", "t");
    commit(up, "a.txt", 3, "base");
    execFileSync("git", ["clone", "-q", up, repo]); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
    // a main do remoto anda 40 arquivos; a main LOCAL fica parada (ninguém deu pull)
    for (let i = 0; i < 40; i++) commit(up, `outro-${i}.txt`, 50, "avanço " + i);
    git(repo, "fetch", "-q", "origin");
    // a tarefa nasce da origin/main (como o Starfork faz) e mexe em 2 arquivos
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", wt, "origin/main");
    commit(wt, "novo.txt", 10, "tarefa"); commit(wt, "a.txt", 5, "tarefa 2");
    const d = await new GitService(repo).diffStat(wt, "main");
    assert.equal(d.files, 2, "só os 2 arquivos da tarefa — antes: 42");
    assert.equal(d.add, 10 + 2);
    // e um merge da main na branch no meio do caminho também não infla
    for (let i = 0; i < 5; i++) commit(up, `depois-${i}.txt`, 30, "mais " + i);
    git(repo, "fetch", "-q", "origin"); git(wt, "merge", "-q", "--no-edit", "origin/main");
    const d2 = await new GitService(repo).diffStat(wt, "main");
    assert.equal(d2.files, 2, "merge da origin/main na branch não conta como arquivo da tarefa");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("órfãos: lsof → processos dentro da pasta (prefixo de nome não conta)", () => {
  const l = parseLsofCwd("p10\nfcwd\nn/r/.cardume/worktrees/header\np11\nfcwd\nn/r/.cardume/worktrees/header/web\np12\nfcwd\nn/r/.cardume/worktrees/header-2\np13\nfcwd\nn/r\n");
  assert.deepEqual(procsInDir(l, "/r/.cardume/worktrees/header", 999), [10, 11]);
  assert.deepEqual(procsInDir(l, "/r/.cardume/worktrees/header/", 10), [11], "o próprio processo nunca");
});

test("órfãos: remover a worktree derruba o servidor que roda dentro dela", { skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-orfao-")));
  const wt = join(root, ".cardume", "worktrees", "t1"); mkdirSync(wt, { recursive: true });
  const ch = spawn("sleep", ["30"], { cwd: wt, stdio: "ignore" });
  const exited = new Promise<number | null>((r) => ch.on("exit", (c, sig) => r(sig ? -1 : c)));
  await new Promise((r) => setTimeout(r, 300));
  try {
    assert.ok((await killInDir(wt)) >= 1);
    assert.equal(await exited, -1, "morreu por sinal, antes dos 30 s");
  } finally { try { ch.kill("SIGKILL"); } catch { /* */ } rmSync(root, { recursive: true, force: true }); }
});
