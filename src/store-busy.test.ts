// node --test src/store-busy.test.ts  (npm test)
// Travamento ao enviar mensagem (28/09): o CLI (talk/metrics) abrindo o state.sqlite enquanto outro
// processo segura a trava falhava com "database is locked at new Store", e pedidos "na fila" de um
// turno morto ficavam presos pra sempre. Tudo em pastas TEMPORÁRIAS — nunca toca projeto real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, isBusyError, withBusyRetry } from "./store.ts";
import { Orchestrator } from "./orchestrator.ts";

/** Outro PROCESSO segura trava exclusiva no banco por `ms` (como um checkpoint/recuperação do WAL). */
function holdLock(file: string, ms: number): Promise<{ done: Promise<void> }> {
  const code = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO event (task_id,agent,ts,type,text) VALUES ('x','a',1,'note','trava');");
    process.stdout.write("held\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, ${ms});`;
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((r) => p.on("exit", () => r()));
  return new Promise((res) => p.stdout!.once("data", () => res({ done })));
}

test("new Store com o banco travado por outro processo ESPERA (antes: 'database is locked' na hora)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-busy-"));
  const file = join(dir, "state.sqlite");
  try {
    new Store(file).close(); // cria o schema
    // prova do bug: a ordem antiga (journal_mode ANTES do busy_timeout) falha imediatamente
    const h1 = await holdLock(file, 700);
    const t0 = Date.now();
    assert.throws(() => {
      const db = new DatabaseSync(file);
      try { db.exec("PRAGMA journal_mode = WAL;"); } finally { db.close(); }
    }, (e: unknown) => isBusyError(e));
    assert.ok(Date.now() - t0 < 300, "a ordem antiga falhava na hora, sem esperar");
    await h1.done;
    // a correção: espera a trava sair e abre
    const h2 = await holdLock(file, 700);
    const t1 = Date.now();
    const s = new Store(file);
    const waited = Date.now() - t1;
    assert.ok(waited >= 300, `deveria ter esperado a trava (${waited}ms)`);
    assert.equal(s.queueCount("x"), 0);
    s.close();
    await h2.done;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withBusyRetry: repete só erro de banco ocupado, com limite", () => {
  let n = 0;
  assert.equal(withBusyRetry(() => { if (++n < 3) throw new Error("database is locked"); return 42; }, 4, 1), 42);
  assert.equal(n, 3);
  n = 0;
  assert.throws(() => withBusyRetry(() => { n++; throw new Error("no such table: x"); }, 4, 1), /no such table/);
  assert.equal(n, 1, "erro que não é de trava não repete");
  n = 0;
  assert.throws(() => withBusyRetry(() => { n++; throw new Error("SQLITE_BUSY"); }, 3, 1), /SQLITE_BUSY/);
  assert.equal(n, 3);
});

test("fila órfã: ao pegar o turno, pedidos antigos (>30min) são descartados com aviso; recentes rodam depois", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-fila-"));
  try {
    const orch = new Orchestrator(dir);
    const st = orch.store;
    st.createTask({ id: "t1", title: "t", objective: "o", agent: "A", roles: [], engine: "claude" } as never, "b", dir, "main"); // o lock exige a tarefa existir
    const old = Date.now() - 3 * 24 * 3600_000; // como as 3 mensagens presas desde 01/09 no logcomex-ai-v2
    st.db.prepare(`INSERT INTO work_queue (task_id, kind, payload, status, created_at) VALUES ('t1','talk','{"message":"esta demorando demais"}','queued',?)`).run(old);
    st.db.prepare(`INSERT INTO work_queue (task_id, kind, payload, status, created_at) VALUES ('t1','talk','{"message":"recente"}','queued',?)`).run(Date.now() - 60_000);
    assert.equal(st.queueCount("t1"), 2);
    const ran: string[] = [];
    // o turno novo (ex.: a próxima mensagem do humano) pega o lock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orch as any).talkToAgentInner = async (_t: string, m: string) => { ran.push(m); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (orch as any).withTaskLock("t1", "talk", { message: "nova" }, async () => { ran.push("nova"); });
    assert.deepEqual(ran, ["nova", "recente"], "o antigo NÃO roda; o recente roda depois do turno");
    assert.equal(st.queueCount("t1"), 0);
    const evs = st.db.prepare(`SELECT text FROM event WHERE task_id='t1' ORDER BY id`).all() as { text: string }[];
    assert.ok(evs.some((e) => /^Fila limpa: 1 pedido antigo descartado/.test(e.text)), "aviso visível no chat");
    orch.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pedido que entra na fila no instante em que o turno acaba: roda na hora, UMA vez, sem 'Na fila' e sem soltar o lock no meio", async () => {
  const { execFileSync } = await import("node:child_process");
  const { realpathSync, writeFileSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-late-")));
  const repo = join(root, "repo");
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const orch = new Orchestrator(repo);
  try {
    orch.store.createTask({ id: "t", title: "t", objective: "o", agent: "A", roles: [], engine: "claude" } as never, "b", repo, "main");
    // 1ª tentativa de lock perde (turno ainda rodando); a re-checagem logo depois ganha (turno acabou)
    const o = orch as unknown as { tryLock(id: string): boolean; talkToAgentInner(...a: unknown[]): Promise<void> };
    const real = o.tryLock.bind(orch);
    let calls = 0;
    o.tryLock = (id: string) => (++calls === 1 ? false : real(id));
    const locksDuring: (number | null)[] = [];
    let ran = 0;
    o.talkToAgentInner = async () => { ran++; locksDuring.push(orch.store.busyPid("t")); };
    await orch.talkToAgent("t", "oi, tudo certo?");
    assert.equal(ran, 1);
    assert.deepEqual(locksDuring, [process.pid], "roda segurando o lock");
    assert.equal(orch.store.busyPid("t"), null);
    assert.equal(orch.store.queueCount("t"), 0);
    assert.ok(!orch.store.eventsForTask("t").some((e) => /^Na fila/.test(e.text)), "não anuncia fila pra algo que rodou na hora");
    // queueDone condicional: o mesmo pedido nunca é tomado duas vezes
    const id = orch.store.queueAdd("t", "talk", {});
    assert.equal(orch.store.queueDone(id), true);
    assert.equal(orch.store.queueDone(id), false);
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
