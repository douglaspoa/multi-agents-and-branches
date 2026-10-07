// Detector de loop (src/loop-detect.ts) — COMPORTAMENTO: a regra é conservadora (falso alarme é pior que loop perdido).
// Ruído de verdade, Claude e Codex, gravação no state.sqlite. Nenhuma IA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attemptFromHook, benignExit, claudeAttempts, codexAttempt, describeTool, emptyLoopState, errorLine, loopReset, loopStep, loopTrack, loopTurnEnd, loopTurnEndStep, normError, normLabel, quietTool, stableJson, type LoopState, type ToolAttempt } from "./loop-detect.ts";
import { mapHook } from "./terminal.ts";
import { Store } from "./store.ts";

const bash = (cmd: string, error?: string, agent?: string): ToolAttempt => ({ tool: "Bash", label: cmd, key: cmd, ok: !error, change: !!describeTool("Bash", { command: cmd })?.change, ...(error ? { error } : {}), ...(agent ? { agent } : {}) });
const edit = (file: string, n: number): ToolAttempt => ({ tool: "Edit", label: file, key: stableJson({ file_path: file, old_string: "a" + n, new_string: "b" + n }), ok: true, change: true });
const read = (file: string): ToolAttempt => ({ tool: "Read", label: file, key: stableJson({ file_path: file }), ok: true, change: false });
const run = (as: ToolAttempt[], s: LoopState = emptyLoopState()) => {
  const fires: string[] = []; let cleared = 0;
  for (const a of as) { const r = loopStep(s, a, 1000); s = r.state; if (r.fire) fires.push(r.fire.text); if (r.clear) cleared++; }
  return { s, fires, cleared };
};
// erro real do node: linha/coluna, caminho temporário, cor ANSI e duração mudam a cada tentativa
const nodeErr = (line: number, tmp: string, ms: number) =>
  `Exit code 1\n\x1b[31mError: Cannot find module './x'\x1b[39m\nRequire stack:\n- /private/var/folders/ab/${tmp}/T/a.js:${line}:${line + 3}\n✖ falhou em ${ms}ms`;
const E = "Error: Cannot find module './x'";

test("normalização: tira só o volátil (linha:col, temp, hora, duração, ANSI, hash longo) — números soltos ficam", () => {
  assert.equal(normError(nodeErr(12, "xyz1", 31)), normError(nodeErr(250, "qq9", 1204)));
  assert.equal(normError("src/a.ts:12:5 - error TS2322: Type 'string'"), normError("src/a.ts:48:17 - error TS2322: Type 'string'"));
  assert.equal(normError("[2026-10-07T13:01:22.123Z] boom em 1.5s"), normError("[2026-10-08T09:05:09.001Z] boom em 22s"));
  assert.equal(normError("fatal: commit a1b2c3d4e5 not found"), normError("fatal: commit 9f8e7d6c5b not found"), "hash com dígito e letra");
  assert.notEqual(normError("Tests: 3 failed, 10 passed"), normError("Tests: 5 failed, 8 passed"), "contagem de testes muda = progresso");
  assert.notEqual(normError("AssertionError: expected 3 rows"), normError("AssertionError: expected 5 rows"));
  assert.notEqual(normError("Error: connect ECONNREFUSED 127.0.0.1:5432"), normError("Error: connect ECONNREFUSED 127.0.0.1:5433"), "porta diferente");
  assert.notEqual(normError("error: exit 1234567 not found"), normError("error: exit 1234568 not found"), "número puro não é hash");
  assert.notEqual(normError("Error: Cannot find module './x'"), normError("Error: Cannot find module './y'"));
  assert.equal(errorLine(nodeErr(1, "a", 1)), E, "a frase legível: sem ANSI, sem 'Exit code'");
  assert.equal(normLabel("bash -lc 'npm test'"), "npm test");
  assert.equal(normLabel("/bin/zsh -lc \"npm   test\""), "npm test");
});

test("loop = mesma falha 3× SEM mudança de arquivo no meio (só re-tentando); uma vez por episódio", () => {
  const r = run([bash("npm test", nodeErr(3, "a", 10)), read("src/x.ts"), bash("npm test", nodeErr(9, "b", 20)), bash("git status"), bash("npm test", nodeErr(40, "c", 30))]);
  assert.equal(r.fires.length, 1, "leu um arquivo e olhou o status, mas não mudou nada");
  assert.match(r.fires[0], /A IA está repetindo o mesmo erro \(3×\): `npm test` falhou 3× com: Error: Cannot find module '\.\/x'/);
  assert.equal(run([bash("npm test", E), bash("npm test", E)], r.s).fires.length, 0, "4ª e 5ª falha do mesmo episódio: sem spam");
});

test("corrige → testa → corrige → testa NUNCA dispara (mesmo com o mesmo erro)", () => {
  const seq: ToolAttempt[] = [];
  for (let i = 0; i < 6; i++) { seq.push(edit("src/x.ts", i)); seq.push(bash("npm test", E)); }
  assert.equal(run(seq).fires.length, 0);
  const viaShell: ToolAttempt[] = [];
  for (let i = 0; i < 4; i++) { viaShell.push(bash(`sed -i 's/a${i}/b/' src/x.ts`)); viaShell.push(bash("npm test", E)); }
  assert.equal(run(viaShell).fires.length, 0, "mudança por comando (sed -i) também conta como mudança");
  // a MESMA edição idêntica de novo não é mudança nova
  const same = edit("src/x.ts", 1);
  assert.equal(run([same, bash("npm test", E), same, bash("npm test", E), same, bash("npm test", E)]).fires.length, 1);
});

test("erros diferentes, contagens que mudam e comandos diferentes NÃO são loop", () => {
  assert.equal(run([bash("npm test", E), bash("npm test", "TypeError: a is not a function"), bash("npm test", "SyntaxError: Unexpected token")]).fires.length, 0);
  assert.equal(run([bash("npm test", "Tests: 5 failed"), bash("npm test", "Tests: 4 failed"), bash("npm test", "Tests: 3 failed")]).fires.length, 0, "está avançando");
  assert.equal(run([bash("npm test", "Error: boom"), bash("npm run build", "Error: boom"), bash("npm run lint", "Error: boom")]).fires.length, 0);
});

test("sucesso da mesma ação no meio zera; sucesso depois do aviso tira o aviso", () => {
  assert.equal(run([bash("npm test", E), bash("npm test", E), bash("npm test"), bash("npm test", E), bash("npm test", E)]).fires.length, 0);
  const r = run([bash("npm test", E), bash("npm test", E), bash("npm test", E)]);
  assert.equal(r.s.warn?.n, 3);
  const after = loopStep(r.s, bash("npm test"));
  assert.equal(after.clear, true); assert.equal(after.state.warn, null);
  assert.equal(run([bash("npm test", E)], after.state).fires.length, 0, "contagem recomeça");
});

test("sem a regra 'mesma ação 4×': polling e leitura repetida não disparam", () => {
  assert.equal(run(Array.from({ length: 8 }, () => read("src/a.ts"))).fires.length, 0);
  assert.equal(run(Array.from({ length: 8 }, () => bash("gh pr checks 12"))).fires.length, 0);
  const viaHook = (p: Record<string, unknown>) => Array.from({ length: 6 }, () => attemptFromHook("PostToolUseFailure", p)).filter((x): x is ToolAttempt => !!x);
  assert.deepEqual(viaHook({ tool_name: "Bash", tool_input: { command: "sleep 30 && gh pr checks 12" }, error: "Exit code 8\nsome checks are still pending" }), [], "espera");
  assert.deepEqual(viaHook({ tool_name: "Bash", tool_input: { command: "until curl -sf localhost:3000; do sleep 1; done" }, error: "Exit code 7" }), [], "curl em laço");
  assert.deepEqual(viaHook({ tool_name: "TaskOutput", tool_input: { task_id: "b1" }, error: "still running" }), []);
  assert.deepEqual(viaHook({ tool_name: "write_stdin", tool_input: { chars: "" }, error: "no output" }), [], "Codex esperando a saída");
});

test("ignorados: código 1 de grep/rg/test/diff/git diff --quiet, espera, navegador — e sem nota 'falhou' no feed", () => {
  assert.equal(benignExit("grep -rn foo src", 1), true);
  assert.equal(benignExit("cd app && rg TODO", 1), true);
  assert.equal(benignExit("test -f out.txt", 1), true);
  assert.equal(benignExit("[ -d dist ]", 1), true);
  assert.equal(benignExit("git diff --quiet", 1), true);
  assert.equal(benignExit("diff a b", 1), true);
  assert.equal(benignExit("grep -rn foo src", 2), false, "código 2 do grep é erro de verdade");
  assert.equal(benignExit("npm test", 1), false);
  for (let i = 0; i < 4; i++) assert.equal(attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "grep -rn remarcar src" }, error: "Exit code 1" }), null);
  assert.equal(attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "sleep 20; gh run watch 99" }, error: "Exit code 1\nfailed" }), null);
  assert.equal(attemptFromHook("PostToolUseFailure", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: {}, error: "timeout" }), null);
  assert.equal(attemptFromHook("PostToolUseFailure", { tool_name: "TaskOutput", tool_input: { task_id: "b1" }, error: "not ready" }), null);
  assert.equal(quietTool("Bash", { command: "rg foo" }, "Exit code 1"), true);
  assert.deepEqual(mapHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "grep -rn x ." }, error: "Exit code 1" }).events, [], "sem nota no feed");
  assert.equal(mapHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nError: boom" }).events.length, 1, "falha de verdade continua no feed");
  assert.deepEqual(mapHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "rg x" }, tool_response: { is_error: true, error: "Exit code 1" } }).events, []);
});

test("chave da ferramenta ordena os campos aninhados (MultiEdit não vira {\"edits\":[{}]})", () => {
  const a = describeTool("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] })!;
  const b = describeTool("MultiEdit", { edits: [{ new_string: "z", old_string: "x" }], file_path: "a.ts" })!;
  assert.notEqual(a.key, b.key, "conteúdo diferente = chave diferente");
  assert.equal(describeTool("MultiEdit", { edits: [{ new_string: "y", old_string: "x" }], file_path: "a.ts" })!.key, a.key, "ordem das chaves não importa");
  assert.equal(a.change, true);
});

test("subagente tem janela própria: as falhas dele não somam com as do principal", () => {
  const r = run([bash("npm test", E), bash("npm test", E, "sub-1"), bash("npm test", E), bash("npm test", E, "sub-1")]);
  assert.equal(r.fires.length, 0);
  const h = (agent?: string) => attemptFromHook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: E, ...(agent ? { agent_id: agent } : {}) })!;
  assert.equal(h("ag9").agent, "ag9"); assert.equal(h().agent, undefined);
  const pend = new Map();
  claudeAttempts(JSON.stringify({ type: "assistant", parent_tool_use_id: "tu0", message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "npm test" } }] } }), pend);
  const a = claudeAttempts(JSON.stringify({ type: "user", parent_tool_use_id: "tu0", message: { content: [{ type: "tool_result", tool_use_id: "s1", is_error: true, content: "Exit code 1\nError: x" }] } }), pend);
  assert.equal(a[0].agent, "tu0", "stream: subagente pelo parent_tool_use_id");
});

test("fim do turno: aviso cuja ação não terminou na mesma falha sai; se terminou na falha, fica", () => {
  const r = run([bash("npm test", E), bash("npm test", E), bash("npm test", E)]);
  assert.ok(loopTurnEndStep(r.s).state.warn, "último resultado é a mesma falha: fica (a pessoa decide)");
  const r2 = run([bash("npm test", "Error: outra coisa")], r.s);
  const end = loopTurnEndStep(r2.s);
  assert.equal(end.clear, true); assert.equal(end.state.warn, null);
});

test("Codex no terminal: 'Exit code: N' (string) ou exit_code (objeto)", () => {
  const out = (code: number, line: number) => `Exit code: ${code}\nWall time: 0.${line} seconds\nOutput:\nsrc/a.rs:${line}:5: error[E0425]: cannot find value \`x\` in this scope`;
  const f = attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: ["bash", "-lc", "cargo build"] }, tool_response: out(101, 3) });
  assert.deepEqual([f?.ok, f?.label], [false, "bash -lc cargo build"]);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "cargo build" }, tool_response: out(0, 3) })?.ok, true);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "shell", tool_input: { command: "x" }, tool_response: { exit_code: 2, output: "fatal: x" } })?.ok, false);
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "rg x" }, tool_response: "Exit code: 1\nOutput:\n" }), null, "rg sem resultado");
  assert.equal(attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "x" }, tool_response: "saída sem código" })?.ok, true, "sem como saber = sucesso");
  const r = run([3, 17, 88].map((l) => attemptFromHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "cargo build" }, tool_response: out(101, l) })!));
  assert.equal(r.fires.length, 1);
  assert.match(r.fires[0], /`cargo build` falhou 3× com: src\/a\.rs:88:5: error\[E0425\]/, "a frase mostra o erro mais recente");
});

test("modo automático: stream do Claude (tool_use → tool_result) e do Codex (item.completed)", () => {
  const pend = new Map();
  claudeAttempts(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } }), pend);
  const a = claudeAttempts(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Exit code 1\nError: boom" }] } }), pend);
  assert.deepEqual([a.length, a[0].ok, a[0].label, pend.size], [1, false, "npm test", 0]);
  claudeAttempts(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Grep", input: { pattern: "x" } }, { type: "tool_use", id: "tu3", name: "Bash", input: { command: "grep -c x a" } }] } }), pend);
  assert.deepEqual(claudeAttempts(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu3", is_error: true, content: "Exit code 1" }] } }), pend), [], "grep sem resultado");
  const cx = (code: number) => JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'pytest -q'", aggregated_output: `E   AssertionError at t.py:${code + 10}`, exit_code: code, status: code ? "failed" : "completed" } });
  assert.equal(codexAttempt(cx(1))?.ok, false); assert.equal(codexAttempt(cx(0))?.ok, true);
  assert.equal(run([cx(1), cx(2), cx(3)].map((l) => codexAttempt(l)!)).fires.length, 1, "mesma asserção em linhas diferentes");
  const patch = JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: "t.py", kind: "update" }] } });
  assert.equal(codexAttempt(patch)?.change, true, "edição do Codex conta como mudança");
});

test("state.sqlite: aviso só na tabela (fora do spec), evento uma vez, reinício, intervenção, fim de turno", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-"));
  const file = join(dir, "state.sqlite");
  const store = new Store(file);
  const warn = (s: Store) => { const r = s.db.prepare("SELECT json_extract(json,'$.warn') AS w FROM loop_state WHERE task_id='t1'").get() as { w: string | null } | undefined; return r?.w ? JSON.parse(r.w) : null; };
  const loops = (s: Store) => s.eventsForTask("t1").filter((e) => e.type === "loop").length;
  try {
    store.createTask({ id: "t1", title: "T", objective: "o", agent: "a", engine: "claude", roles: [], autonomy: { approval: "auto" } } as any, "b", dir, "main");
    for (let i = 0; i < 5; i++) loopTrack(store, "t1", bash("npm test", nodeErr(i, "x" + i, i)), { quick: true });
    assert.equal(loops(store), 1);
    assert.match(warn(store).what, /`npm test` falhou 3×/);
    assert.equal(JSON.parse(store.getTask("t1")!.spec_json).loop, undefined, "nada no spec (sem corrida com patch_task_spec)");
    store.close();
    const s2 = new Store(file); // app reiniciado
    loopTrack(s2, "t1", bash("npm test", E));
    assert.equal(loops(s2), 1);
    loopTurnEnd(s2, "t1"); assert.ok(warn(s2), "turno acabou na mesma falha: fica");
    loopReset(s2, "t1"); assert.equal(warn(s2), null, "a pessoa interveio");
    for (let i = 0; i < 3; i++) loopTrack(s2, "t1", bash("npm test", E));
    assert.equal(loops(s2), 2, "episódio novo depois da intervenção");
    loopTrack(s2, "t1", bash("npm test", "Error: outra"));
    loopTurnEnd(s2, "t1"); assert.equal(warn(s2), null, "fim de turno com outro resultado: o aviso sai");
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("caminho do hook desiste em silêncio com o banco travado (não segura o Codex)", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"));
  const file = join(dir, "state.sqlite");
  const store = new Store(file);
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout = 0"); other.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    assert.equal(loopTrack(store, "t1", bash("npm test", E), { quick: true }), null);
    loopReset(store, "t1", { quick: true }); loopTurnEnd(store, "t1", { quick: true });
    assert.ok(Date.now() - t0 < 1500, `levou ${Date.now() - t0} ms`);
    other.exec("ROLLBACK");
    assert.equal((store.db.prepare("PRAGMA busy_timeout").get() as any).timeout, 8000, "o timeout volta ao normal");
  } finally { other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
