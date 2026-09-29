// node --test src/task-lock.test.ts  (npm test)
// Lock do turno (task.busy_pid): pegar o lock é ATÔMICO entre processos — dois "iniciar" quase juntos
// não sobem dois agentes na mesma worktree. Pastas TEMPORÁRIAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";

const spec = (id: string) => ({ id, title: id, objective: "o", agent: "A", roles: [], engine: "mock" }) as unknown as TaskSpec;

test("lock: livre/próprio/morto → pega; de outro processo vivo → não pega", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-lock-"));
  const store = new Store(join(dir, "state.sqlite"));
  try {
    store.createTask(spec("t"), "b", dir, "main");
    const vivos = new Set([111]);
    const alive = (p: number) => vivos.has(p);
    assert.equal(store.tryLockBusy("t", 111, alive), true);
    assert.equal(store.tryLockBusy("t", 111, alive), true, "o próprio dono pode re-entrar");
    assert.equal(store.tryLockBusy("t", 222, alive), false);
    assert.equal(store.busyPid("t"), 111);
    vivos.delete(111); // o dono morreu (parar/SIGKILL)
    assert.equal(store.tryLockBusy("t", 222, alive), true);
    assert.equal(store.busyPid("t"), 222);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6 processos pedem o lock AO MESMO TEMPO: só um ganha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-lock-"));
  const file = join(dir, "state.sqlite");
  const s0 = new Store(file);
  s0.createTask(spec("t"), "b", dir, "main");
  s0.close();
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const orchUrl = new URL("./orchestrator.ts", import.meta.url).href;
  const code = `
    const { Store } = await import(${JSON.stringify(storeUrl)});
    const { pidAlive } = await import(${JSON.stringify(orchUrl)});
    const s = new Store(${JSON.stringify(file)});
    // largada sincronizada: todos esperam o mesmo instante
    while (Date.now() < ${Date.now() + 1500}) {}
    const ok = s.tryLockBusy("t", process.pid, pidAlive);
    process.stdout.write(ok ? "GANHOU" : "perdeu");
    setTimeout(() => { s.close(); process.exit(0); }, 1200); // segue vivo enquanto os outros checam
  `;
  const runOne = () => new Promise<string>((res) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"], cwd: fileURLToPath(new URL("..", import.meta.url)) });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.on("exit", () => res(out));
  });
  try {
    const outs = await Promise.all(Array.from({ length: 6 }, runOne));
    assert.equal(outs.filter((o) => o === "GANHOU").length, 1, outs.join(","));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("erro inesperado no meio do pipeline: a tarefa vai pra 'erro' (antes: 'rodando' pra sempre) e o lock é solto", async () => {
  const { execFileSync } = await import("node:child_process");
  const { realpathSync, writeFileSync } = await import("node:fs");
  const { Orchestrator } = await import("./orchestrator.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-pipe-")));
  const repo = join(root, "repo");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  try {
    await orch.createTask({
      id: "t-x", title: "t", objective: "x", deliverables: [], requirements: [],
      scope: { owns: [], offLimits: [] },
      autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
      engine: "mock", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "mock" }], light: true, base: "main",
    } as unknown as TaskSpec);
    // o contexto do papel é montado DEPOIS do status "rodando" — uma exceção aqui escapava do pipeline
    orch.bus.buildContext = () => { throw new Error("database is locked"); };
    await assert.rejects(orch.runTask("t-x"), /database is locked/);
    const t = orch.store.getTask("t-x")!;
    assert.equal(t.status, "error");
    assert.equal(orch.store.busyPid("t-x"), null);
    assert.ok(orch.store.eventsForTask("t-x").some((e) => e.type === "error" && /erro inesperado: database is locked/.test(e.text)));
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
