// node --test src/engine/claude-lifecycle.test.ts  (npm test)
// Ciclo de vida do processo do claude: um "claude" FALSO (script node) simula os casos ruins —
// concluir o turno e não sair, ignorar SIGTERM, e o app abandonar o turno no meio. Tudo em pastas
// temporárias, com HOME isolado (nada lê a config real do usuário).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine } from "./claude.ts";
import type { AgentEvent } from "./types.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid: number, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 100)); }
  return !alive(pid);
}

function fakeClaude(dir: string, body: string): string {
  const f = join(dir, "fake-claude.mjs");
  writeFileSync(f, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FAKE_PID_FILE, String(process.pid));\nconst out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

function setup(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "starfork-claude-"));
  mkdirSync(join(dir, "wt", ".cardume"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  const saved = { ...process.env };
  process.env.HOME = join(dir, "home");
  process.env.CARDUME_CLAUDE = fakeClaude(dir, body);
  process.env.FAKE_PID_FILE = join(dir, "pid");
  process.env.CARDUME_PROTECT = "0";
  delete process.env.CLAUDE_CONFIG_DIR;
  const input = {
    cwd: join(dir, "wt"),
    spec: { id: "t1", title: "ajuste de texto", objective: "trocar um texto", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] } } as never,
    systemContext: "",
    role: "builder",
    agentName: "Íris",
    dbFile: join(dir, "state.sqlite"),
  };
  // restaura CHAVE a chave: trocar o objeto process.env desliga o os.homedir() do HOME
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, input, restore, pid: () => Number(readFileSync(join(dir, "pid"), "utf8")) };
}

test("claude concluiu o turno (result) mas não saiu e ignora SIGTERM: o turno fecha e o processo morre", async () => {
  const s = setup(`
    process.on("SIGTERM", () => {}); // ignora o pedido educado
    out({ type: "system", subtype: "init", session_id: "s1", model: "m" });
    out({ type: "result", is_error: false, result: "pronto", total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 } });
    setInterval(() => {}, 1000);`);
  process.env.CARDUME_CLAUDE_EXIT_GRACE_MS = "300";
  try {
    const evs: AgentEvent[] = [];
    const t0 = Date.now();
    for await (const ev of new ClaudeEngine({ approval: "auto" }).run(s.input)) evs.push(ev);
    assert.ok(Date.now() - t0 < 10_000, "antes: ficava preso até o watchdog de 30 min");
    const done = evs.find((e) => e.type === "done");
    assert.equal(done?.ok, true);
    assert.deepEqual(done?.cost, { usd: 0.01, inTok: 5, outTok: 7 });
    assert.equal(evs.filter((e) => e.type === "error").length, 0, "turno concluído não pode virar erro (e disparar retry)");
    assert.ok(await waitDead(s.pid()), "SIGTERM ignorado → SIGKILL");
  } finally {
    s.restore();
  }
});

test("o app abandona o turno no meio (erro gravando no banco): o claude não fica órfão", async () => {
  const s = setup(`
    out({ type: "system", subtype: "init", session_id: "s1", model: "m" });
    setInterval(() => out({ type: "assistant", message: { content: [{ type: "text", text: "trabalhando" }] } }), 50);`);
  try {
    let n = 0;
    await assert.rejects(async () => {
      for await (const ev of new ClaudeEngine({ approval: "auto" }).run(s.input)) {
        if (ev.type === "think" && ++n >= 2) throw new Error("database is locked");
      }
    }, /database is locked/);
    assert.ok(await waitDead(s.pid()), "antes: o processo seguia rodando (e gastando) sem ninguém ouvir");
  } finally {
    s.restore();
  }
});

test("processo que sai com erro SEM result: o motivo chega (código + último erro do stderr)", async () => {
  const s = setup(`
    process.stderr.write("API Error: 429 rate limit\\n");
    process.exit(1);`);
  try {
    const evs: AgentEvent[] = [];
    for await (const ev of new ClaudeEngine({ approval: "auto" }).run(s.input)) evs.push(ev);
    const err = evs.find((e) => e.type === "error");
    assert.match(err?.text ?? "", /código 1 — API Error: 429 rate limit/);
  } finally {
    s.restore();
  }
});

test("custo no --resume: o total do claude vem ACUMULADO da sessão — conta só a diferença do turno", async () => {
  const s = setup(`
    out({ type: "system", subtype: "init", session_id: "50eb6fe2-fe85-4c71-8ea8-e16c62711d2b", model: "m" });
    out({ type: "result", is_error: false, result: "tchau", total_cost_usd: 0.0529608, usage: { input_tokens: 10, output_tokens: 52 } });`);
  try {
    // transcript como o Claude Code grava (medido num claude real em 28/09: 0.048 → 0.0529 no 2º turno)
    const sid = "50eb6fe2-fe85-4c71-8ea8-e16c62711d2b";
    const proj = join(process.env.HOME!, ".claude", "projects", "-tmp-wt");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), [
      JSON.stringify({ type: "user", message: { content: "oi" } }),
      JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: 0.02 }),
      JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: 0.048016 }),
      '{"type":"cost-state","totalCos', // linha truncada no fim (gravação interrompida)
    ].join("\n"));
    const evs: AgentEvent[] = [];
    for await (const ev of new ClaudeEngine({ approval: "auto" }).run({ ...s.input, resume: { sessionId: sid, instruction: "tchau" } })) evs.push(ev);
    const done = evs.find((e) => e.type === "done");
    assert.equal(done?.cost?.usd, 0.0049448, "antes: 0.0529608 (re-cobrava o 1º turno)");
    assert.match(done?.text ?? "", /\$0\.005/);
    // turno FRESCO (sem resume) não desconta nada
    const fresh: AgentEvent[] = [];
    for await (const ev of new ClaudeEngine({ approval: "auto" }).run(s.input)) fresh.push(ev);
    assert.equal(fresh.find((e) => e.type === "done")?.cost?.usd, 0.0529608);
  } finally {
    s.restore();
  }
});
