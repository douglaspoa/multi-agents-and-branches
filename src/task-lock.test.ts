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
