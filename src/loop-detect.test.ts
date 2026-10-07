// Detector de loop (src/loop-detect.ts) — regra pura com ruído de verdade + gravação no state.sqlite. Nenhuma IA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptFromHook, claudeAttempts, codexAttempt, emptyLoopState, errorLine, loopReset, loopStep, loopTrack, normError, normLabel, type LoopState, type ToolAttempt } from "./loop-detect.ts";
import { Store } from "./store.ts";

const bash = (cmd: string, error?: string): ToolAttempt => ({ tool: "Bash", label: cmd, key: cmd, ok: !error, ...(error ? { error } : {}) });
const run = (as: ToolAttempt[], s: LoopState = emptyLoopState()) => {
  const fires: string[] = []; let cleared = 0;
  for (const a of as) { const r = loopStep(s, a, 1000); s = r.state; if (r.fire) fires.push(r.fire.text); if (r.clear) cleared++; }
  return { s, fires, cleared };
};

// erro real do node com número de linha/coluna, caminho temporário, cor ANSI e duração mudando a cada tentativa
const nodeErr = (line: number, tmp: string, ms: number) =>
  `Exit code 1\n\x1b[31mError: Cannot find module './x'\x1b[39m\nRequire stack:\n- /private/var/folders/ab/${tmp}/T/a.js:${line}:${line + 3}\n  at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)\n✖ falhou em ${ms}ms`;

test("mesmo erro com número de linha, temp, cor e duração diferentes = MESMA assinatura", () => {
  assert.equal(normError(nodeErr(12, "xyz1", 31)), normError(nodeErr(250, "qq9", 1204)));
  assert.equal(normError("src/a.ts:12:5 - error TS2322: Type 'string' is not assignable"), normError("src/a.ts:48:17 - error TS2322: Type 'string' is not assignable"));
  assert.equal(normError("[2026-10-07T13:01:22.123Z] ECONNREFUSED 127.0.0.1:5432"), normError("[2026-10-07T13:05:09.001Z] ECONNREFUSED 127.0.0.1:5432"));
  assert.notEqual(normError("Error: Cannot find module './x'"), normError("Error: Cannot find module './y'"), "módulo diferente = erro diferente");
  assert.equal(errorLine(nodeErr(1, "a", 1)), "Error: Cannot find module './x'", "a frase legível: sem ANSI, sem 'Exit code'");
  assert.equal(normLabel("bash -lc 'npm test'"), "npm test", "wrapper de shell do Codex sai");
  assert.equal(normLabel("/bin/zsh -lc \"npm   test\""), "npm test");
});

test("3 falhas iguais nas últimas tentativas → loop, com a frase legível; uma vez por episódio", () => {
  const r = run([bash("npm test", nodeErr(3, "a", 10)), { tool: "Edit", label: "src/x.ts", key: "e1", ok: true }, bash("npm test", nodeErr(9, "b", 20)), { tool: "Edit", label: "src/x.ts", key: "e2", ok: true }, bash("npm test", nodeErr(40, "c", 30))]);
  assert.equal(r.fires.length, 1);
  assert.match(r.fires[0], /A IA está repetindo o mesmo erro \(3×\): `npm test` falhou 3× com: Error: Cannot find module '\.\/x'/);
  const more = run([bash("npm test", nodeErr(41, "d", 9)), bash("npm test", nodeErr(42, "e", 9))], r.s);
  assert.equal(more.fires.length, 0, "4ª e 5ª falha do mesmo episódio: sem spam");
});

test("erros diferentes NÃO são loop", () => {
  const r = run([bash("npm test", "Error: Cannot find module './x'"), bash("npm test", "TypeError: a is not a function"), bash("npm test", "AssertionError: expected 1 to equal 2"), bash("npm test", "SyntaxError: Unexpected token")]);
  assert.equal(r.fires.length, 0);
  const r2 = run([bash("npm test", "Error: boom"), bash("npm run build", "Error: boom"), bash("npm run lint", "Error: boom")]);
  assert.equal(r2.fires.length, 0, "mesma mensagem em comandos diferentes: não é a mesma ação");
});

test("sucesso da mesma ação no meio zera; e um sucesso depois do aviso o tira", () => {
  const e = "Error: Cannot find module './x'";
  assert.equal(run([bash("npm test", e), bash("npm test", e), bash("npm test"), bash("npm test", e), bash("npm test", e)]).fires.length, 0);
  const r = run([bash("npm test", e), bash("npm test", e), bash("npm test", e)]);
  assert.equal(r.fires.length, 1);
  const after = loopStep(r.s, bash("npm test"));
  assert.equal(after.clear, true, "o comando passou: o aviso some");
  assert.equal(after.state.fired, null);
  assert.equal(run([bash("npm test", e)], after.state).fires.length, 0, "recomeça a contagem");
});

test("falhas espalhadas além da janela não contam", () => {
  const e = "Error: x";
  const filler = Array.from({ length: 9 }, (_, i) => ({ tool: "Read", label: `f${i}.ts`, key: `f${i}`, ok: true }));
  assert.equal(run([bash("npm test", e), ...filler, bash("npm test", e), bash("npm test", e)]).fires.length, 0);
});

test("loop sem erro: a mesma ação idêntica 4× seguidas; edições diferentes no mesmo arquivo não", () => {
  const read = { tool: "Read", label: "src/a.ts", key: '{"file_path":"src/a.ts"}', ok: true };
  const r = run([read, read, read, read]);
  assert.equal(r.fires.length, 1);
  assert.match(r.fires[0], /repetindo a mesma ação \(4×\): ler `src\/a\.ts` 4× seguidas/);
  assert.equal(loopStep(r.s, bash("ls")).clear, true, "fez outra coisa: o aviso some");
  const edits = [1, 2, 3, 4].map((i) => ({ tool: "Edit", label: "src/a.ts", key: `{"new":"${i}"}`, ok: true }));
  assert.equal(run(edits).fires.length, 0);
  assert.equal(run([read, read, read, bash("ls"), read]).fires.length, 0, "precisa ser seguida");
});

test("Claude Code no terminal: PostToolUseFailure e PostToolUse viram tentativas", () => {
  const f = attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nError: boom" });
  assert.deepEqual([f?.ok, f?.label], [false, "npm test"]);
  assert.equal(attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "x" }, error: "x", is_interrupt: true }), null, "Esc da pessoa não é erro");
  const ok = attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", stderr: "" } });
  assert.equal(ok?.ok, true);
  const ed = attemptFromHook("PostToolUseFailure", { tool_name: "Edit", tool_input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b" }, error: "String to replace not found in file." });
  assert.deepEqual([ed?.label, ed?.ok], ["/w/src/a.ts", false]);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "mcp__cardume__ask_human", tool_input: {} }), null, "ferramenta do Starfork não conta");
  assert.equal(attemptFromHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "x" } }), null);
  const evs = Array.from({ length: 3 }, (_, i) => attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: nodeErr(i * 7, "t" + i, i) })!);
  assert.equal(run(evs).fires.length, 1);
});

test("Codex no terminal: PostToolUse com a saída 'Exit code: N' (string) ou exit_code (objeto)", () => {
  const out = (code: number, line: number) => `Exit code: ${code}\nWall time: 0.${line} seconds\nOutput:\nsrc/a.rs:${line}:5: error[E0425]: cannot find value \`x\` in this scope`;
  const f = attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: ["bash", "-lc", "cargo build"] }, tool_response: out(101, 3) });
  assert.deepEqual([f?.ok, f?.label], [false, "bash -lc cargo build"]);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "cargo build" }, tool_response: out(0, 3) })?.ok, true);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "shell", tool_input: { command: "x" }, tool_response: { exit_code: 2, output: "fatal: x" } })?.ok, false);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "x" }, tool_response: "saída sem código" })?.ok, true, "sem como saber = sucesso (nunca acusa no escuro)");
  const evs = [3, 17, 88].map((l) => attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "cargo build" }, tool_response: out(101, l) })!);
  const r = run(evs);
  assert.equal(r.fires.length, 1);
  assert.match(r.fires[0], /`cargo build` falhou 3× com: src\/a\.rs:88:5: error\[E0425\]/);
});

test("modo automático: stream do Claude (tool_use → tool_result) e do Codex (item.completed)", () => {
  const pend = new Map();
  const use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } });
  const res = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Exit code 1\nError: boom" }] } });
  assert.deepEqual(claudeAttempts(use, pend), []);
  const a = claudeAttempts(res, pend);
  assert.equal(a.length, 1); assert.equal(a[0].ok, false); assert.equal(a[0].label, "npm test"); assert.equal(pend.size, 0);
  assert.deepEqual(claudeAttempts('{"type":"assistant","message":{"content":[{"type":"text","text":"oi"}]}}', pend), []);
  const cx = (code: number) => JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'pytest -q'", aggregated_output: `E   AssertionError at t.py:${code + 10}`, exit_code: code, status: code ? "failed" : "completed" } });
  assert.deepEqual([codexAttempt(cx(1))?.ok, codexAttempt(cx(1))?.label], [false, "/bin/zsh -lc 'pytest -q'"]);
  assert.equal(codexAttempt(cx(0))?.ok, true);
  assert.equal(codexAttempt('{"type":"item.started","item":{"type":"command_execution","command":"x"}}'), null);
  assert.equal(run([cx(1), cx(2), cx(3)].map((l) => codexAttempt(l)!)).fires.length, 1, "mesma asserção em linhas diferentes");
});

test("estado por tarefa no state.sqlite: evento 'loop' uma vez, spec.loop, e a intervenção zera", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-"));
  const store = new Store(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "t1", title: "T", objective: "o", agent: "a", engine: "claude", roles: [], autonomy: { approval: "auto" } } as any, "b", dir, "main");
    for (let i = 0; i < 5; i++) loopTrack(store, "t1", bash("npm test", nodeErr(i, "x" + i, i)));
    const evs = store.eventsForTask("t1").filter((e) => e.type === "loop");
    assert.equal(evs.length, 1, "uma vez por episódio");
    assert.match(evs[0].text, /falhou 3×/);
    const sp = JSON.parse(store.getTask("t1")!.spec_json);
    assert.equal(sp.loop.kind, "erro"); assert.equal(sp.loop.n, 3); assert.match(sp.loop.what, /`npm test` falhou 3×/);
    // reabrir o banco (app reiniciado): a janela continua lá — mais uma falha igual não repete o aviso
    store.close();
    const s2 = new Store(join(dir, "state.sqlite"));
    loopTrack(s2, "t1", bash("npm test", nodeErr(99, "z", 1)));
    assert.equal(s2.eventsForTask("t1").filter((e) => e.type === "loop").length, 1);
    loopReset(s2, "t1");
    assert.equal(JSON.parse(s2.getTask("t1")!.spec_json).loop, undefined, "a pessoa interveio: o aviso some");
    for (let i = 0; i < 2; i++) loopTrack(s2, "t1", bash("npm test", "Error: boom"));
    assert.equal(s2.eventsForTask("t1").filter((e) => e.type === "loop").length, 1, "contagem recomeçou do zero");
    loopTrack(s2, "t1", bash("npm test", "Error: boom"));
    assert.equal(s2.eventsForTask("t1").filter((e) => e.type === "loop").length, 2, "episódio novo depois da intervenção");
    loopTrack(s2, "t1", bash("npm test"));
    assert.equal(JSON.parse(s2.getTask("t1")!.spec_json).loop, undefined, "o comando passou: aviso sai do spec");
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
