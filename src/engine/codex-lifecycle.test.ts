// node --test src/engine/codex-lifecycle.test.ts  (npm test)
// Ciclo de vida do processo do codex com um "codex" FALSO (script node). HOME isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngine } from "./codex.ts";
import type { AgentEvent } from "./types.ts";

// scripts falsos com shebang, sleep e sinais POSIX: não valem no Windows
const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid: number, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 100)); }
  return !alive(pid);
}

function setup(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "starfork-codex-"));
  mkdirSync(join(dir, "wt"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  const f = join(dir, "fake-codex.mjs");
  writeFileSync(f, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FAKE_PID_FILE, String(process.pid));\nconst out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\n${body}\n`);
  chmodSync(f, 0o755);
  const saved = { ...process.env };
  process.env.HOME = join(dir, "home");
  process.env.USERPROFILE = join(dir, "home");
  process.env.CARDUME_CODEX = f;
  process.env.FAKE_PID_FILE = join(dir, "pid");
  const input = {
    cwd: join(dir, "wt"),
    spec: { id: "t1", title: "t", objective: "o", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] } } as never,
    systemContext: "", role: "builder", agentName: "Onda", dbFile: join(dir, "state.sqlite"),
  };
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  };
  return { input, restore, pid: () => Number(readFileSync(join(dir, "pid"), "utf8")) };
}

async function collect(input: ReturnType<typeof setup>["input"]): Promise<AgentEvent[]> {
  const evs: AgentEvent[] = [];
  for await (const ev of new CodexEngine().run(input)) evs.push(ev);
  return evs;
}

test("turno concluído: UM done e nenhum erro; processo que não sai é encerrado após a folga", POSIX, async () => {
  const s = setup(`
    process.on("SIGTERM", () => {});
    out({ type: "thread.started", thread_id: "th1" });
    out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    setInterval(() => {}, 1000);`);
  process.env.CARDUME_CLAUDE_EXIT_GRACE_MS = "300";
  try {
    const t0 = Date.now();
    const evs = await collect(s.input);
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(evs.filter((e) => e.type === "done").length, 1);
    assert.equal(evs.filter((e) => e.type === "error").length, 0);
    assert.ok(await waitDead(s.pid()));
  } finally {
    s.restore();
  }
});

test("turno abandonado pelo app: o codex não fica órfão", POSIX, async () => {
  const s = setup(`
    setInterval(() => out({ type: "item.completed", item: { type: "reasoning", text: "pensando" } }), 50);`);
  try {
    let n = 0;
    await assert.rejects(async () => {
      for await (const ev of new CodexEngine().run(s.input)) if (ev.type === "think" && ++n >= 2) throw new Error("database is locked");
    }, /database is locked/);
    assert.ok(await waitDead(s.pid()));
  } finally {
    s.restore();
  }
});

test("turn.failed e saída 1: UM erro, com o motivo real (o 'código 1' genérico não o encobre)", POSIX, async () => {
  const s = setup(`
    out({ type: "turn.failed", error: { message: "usage limit reached, try again later" } });
    process.exit(1);`);
  try {
    const errs = (await collect(s.input)).filter((e) => e.type === "error");
    assert.equal(errs.length, 1, errs.map((e) => e.text).join(" | "));
    assert.match(errs[0].text, /usage limit reached/);
  } finally {
    s.restore();
  }
});
