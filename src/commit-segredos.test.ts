// O commit automático do Starfork (fim de turno, antes do PR, ajuste) NUNCA leva arquivo de segredo novo.
// Caso real: o app semeia os `.env*` do repo principal na worktree; onde o .gitignore do projeto não cobria
// (`.env.homol`, `servico/.env`), o `add -A` commitava e o push publicava. Dados fictícios.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, isSecretFile, excludeLine } from "./git.ts";

function repoNovo(): { repo: string; g: (...a: string[]) => string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sf-segredo-")));
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, ".env.rastreado"), "JA_ESTAVA=1\n"); // o projeto escolheu rastrear: não é problema nosso
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return { repo, g };
}

test("isSecretFile: .env e chaves sim; modelos e código não", () => {
  for (const f of [".env", ".env.homol", "lia-back/.env", "a/b/.env.production", "chaves/id_rsa", "id_ed25519", "cert/loja.p12", "x.PFX", "android/release.keystore"]) assert.ok(isSecretFile(f), f);
  for (const f of [".env.example", "api/.env.sample", ".env.template", ".envrc", "env.ts", "src/dotenv.js", "id_rsa.pub", "README.md", "config/.environment"]) assert.ok(!isSecretFile(f), f);
});

test("excludeLine: ancora na raiz e escapa curinga", () => {
  assert.equal(excludeLine("lia-back/.env"), "/lia-back/.env");
  assert.equal(excludeLine("meu app/[x].env"), "/meu\\ app/\\[x\\].env");
});

test("commitAll: código entra, segredo novo fica no disco e fora do commit", async () => {
  const { repo, g } = repoNovo();
  mkdirSync(join(repo, "lia-back"));
  writeFileSync(join(repo, ".env.homol"), "SENHA=ficticia-1\n");
  writeFileSync(join(repo, "lia-back/.env"), "TOKEN=ficticio-2\n");
  writeFileSync(join(repo, ".env.example"), "SENHA=\n");
  writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, ".env.rastreado"), "JA_ESTAVA=2\n");
  const git = new GitService(repo);
  assert.equal(await git.commitAll(repo, "starfork(terminal): feature"), true);
  const noCommit = g("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(noCommit, [".env.example", ".env.rastreado", "feature.ts"]);
  assert.deepEqual([...git.lastHeld].sort(), [".env.homol", "lia-back/.env"]);
  assert.ok(existsSync(join(repo, ".env.homol")) && existsSync(join(repo, "lia-back/.env")), "continuam no disco");
  assert.equal(g("status", "--porcelain").trim(), "", "exclude local: não aparecem mais como soltos");
  assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /^\/lia-back\/\.env$/m);
  // turno seguinte: nada novo → não commita, e não segura de novo (já está no exclude)
  assert.equal(await git.commitAll(repo, "starfork(terminal): de novo"), false);
  assert.deepEqual(git.lastHeld, []);
});

test("commitAll: só segredo solto → não cria commit", async () => {
  const { repo, g } = repoNovo();
  const antes = g("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, ".env"), "CHAVE=ficticia\n");
  const git = new GitService(repo);
  assert.equal(await git.commitAll(repo, "starfork(terminal): x"), false);
  assert.equal(g("rev-parse", "HEAD").trim(), antes);
  assert.deepEqual(git.lastHeld, [".env"]);
});

test("commitAll numa worktree: o exclude é o comum do repo e vale pra ela", async () => {
  const { repo, g } = repoNovo();
  const wt = join(repo, ".cardume", "wt", "t1");
  g("worktree", "add", "-q", "-b", "task/t1", wt);
  mkdirSync(join(wt, "ncm-pro"));
  writeFileSync(join(wt, "ncm-pro/.env"), "DB=ficticio\n");
  writeFileSync(join(wt, "a.txt"), "mudança\n");
  const git = new GitService(repo);
  assert.equal(await git.commitAll(wt, "starfork(terminal): t1"), true);
  assert.equal(execFileSync("git", ["-C", wt, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim(), "a.txt");
  assert.equal(execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
});

// ── ponta a ponta no motor: semeia os .env do repo principal → fim de turno → nada de segredo no commit ──
import { Orchestrator } from "./orchestrator.ts";
import type { TaskSpec } from "./types.ts";
import { rmSync } from "node:fs";

test("tarefa real: .env semeado fora do .gitignore não entra no commit do fim de turno", async () => {
  const { repo, g } = repoNovo();
  g("config", "commit.gpgsign", "false");
  // como no caso real: nada disso está no .gitignore do projeto
  mkdirSync(join(repo, "plataformabi-back"));
  writeFileSync(join(repo, ".env.homol"), "SENHA=ficticia\n");
  writeFileSync(join(repo, "plataformabi-back/.env"), "TOKEN=ficticio\n");
  const keep = process.env.CARDUME_NOTIFY; process.env.CARDUME_NOTIFY = "0";
  const orch = new Orchestrator(repo);
  try {
    const spec = { id: "seg", title: "seg", objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude" }], engine: "claude", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, autoPr: "no", termMode: "terminal", light: true } as TaskSpec;
    const t = await orch.createTask(spec);
    assert.ok(existsSync(join(t.worktree, ".env.homol")) && existsSync(join(t.worktree, "plataformabi-back/.env")), "o ambiente foi semeado");
    const st = (...a: string[]) => execFileSync("git", ["-C", t.worktree, ...a], { encoding: "utf8" }).trim();
    assert.equal(st("status", "--porcelain"), "", "semeado já nasce fora do git");
    writeFileSync(join(t.worktree, "feature.ts"), "export const y = 2;\n");
    writeFileSync(join(t.worktree, ".env.local"), "CRIADO_PELA_IA=ficticio\n"); // a IA criou no turno
    await orch.terminalTurnEnd("seg");
    const arquivos = st("log", "--name-only", "--format=", "main..HEAD").split("\n").filter(Boolean);
    assert.deepEqual(arquivos, ["feature.ts"]);
    assert.ok(orch.store.eventsForTask("seg").some((e) => /segurei 1 arquivo\(s\) de segredo fora do commit: \.env\.local/.test(e.text)), "avisa na tarefa");
  } finally { orch.close(); if (keep === undefined) delete process.env.CARDUME_NOTIFY; else process.env.CARDUME_NOTIFY = keep; rmSync(repo, { recursive: true, force: true }); }
});
