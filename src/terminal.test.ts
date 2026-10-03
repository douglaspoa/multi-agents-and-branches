// node --test src/terminal.test.ts  (npm test)
// MODO TERMINAL: hooks do CLI oficial → feed/estado da tarefa, fusão do settings.local.json, custo pela
// statusLine e a máquina de estados do fim de turno (running → review + gate). Repos git TEMPORÁRIOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Orchestrator } from "./orchestrator.ts";
import { applyHook, excludeFromGit, mapHook, mergeClaudeSettings, recordStatuslineCost, termMessage, termModeOf, terminalCapable, HOOK_MARK, CLAUDE_HOOK_EVENTS, lastAssistantText } from "./terminal.ts";
import type { TaskSpec } from "./types.ts";

const BASE = ["/usr/bin/node", "/app/cli.mjs"];
const spec = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({ id, title: id, objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude" }], engine: "claude", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, ...extra }) as TaskSpec;

function withStore(fn: (s: Store, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "starfork-term-"));
  const store = new Store(join(dir, "state.sqlite"));
  try { fn(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("modo da tarefa: antigo = automático; só claude/codex têm terminal", () => {
  assert.equal(termModeOf({}), "auto");
  assert.equal(termModeOf({ termMode: "terminal" }), "terminal");
  assert.equal(termModeOf(null), "auto");
  assert.ok(terminalCapable("claude") && terminalCapable("codex"));
  assert.ok(!terminalCapable("deepseek"));
});

test("settings.local.json: funde sem apagar hooks/statusLine da pessoa e é idempotente", () => {
  const mine = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "say pronto" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] },
    statusLine: { type: "command", command: "~/minha-barra.sh" },
  };
  const a = mergeClaudeSettings(mine, BASE, "t1", "/repo");
  assert.deepEqual(a.settings.permissions, mine.permissions, "resto preservado");
  assert.equal(a.prevStatusLine, "~/minha-barra.sh", "barra da pessoa vira encadeada");
  assert.ok(String(a.settings.statusLine?.command).includes(HOOK_MARK));
  for (const ev of CLAUDE_HOOK_EVENTS) {
    const cmds = (a.settings.hooks![ev] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => String(h.command)));
    assert.equal(cmds.filter((c) => c.includes(HOOK_MARK)).length, 1, `um hook nosso em ${ev}`);
    assert.ok(cmds.some((c) => c.includes(`hook' '${ev}'`) || c.includes(`hook ${ev}`)), `comando do evento ${ev}: ${cmds}`);
  }
  assert.ok(a.settings.hooks!.Stop.some((g) => g.hooks!.some((h) => h.command === "say pronto")), "hook da pessoa fica");
  assert.ok(a.settings.hooks!.PreToolUse.some((g) => g.matcher === "Bash"), "matcher da pessoa fica");
  assert.equal(a.settings.hooks!.PreToolUse.find((g) => g.hooks!.some((h) => String(h.command).includes(HOOK_MARK)))!.hooks![0].async, true, "feed não segura a ferramenta");
  assert.equal(a.settings.hooks!.Stop.find((g) => g.hooks!.some((h) => String(h.command).includes(HOOK_MARK)))!.hooks![0].async, undefined, "Stop é síncrono (estado)");
  // rodar de novo (retomar) não duplica e não perde a barra encadeada
  const b = mergeClaudeSettings(a.settings, BASE, "t1", "/repo");
  assert.deepEqual(b.settings, a.settings);
  assert.equal(b.prevStatusLine, null, "a nossa não se encadeia nela mesma");
});

test("settings.local.json fica FORA do git da worktree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-ex-")));
  try {
    const repo = join(root, "r");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "b"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "x", join(root, "wt"), "main"]);
    excludeFromGit(join(root, "wt"), [".claude/settings.local.json"]);
    excludeFromGit(join(root, "wt"), [".claude/settings.local.json"]);
    mkdirSync(join(root, "wt", ".claude"));
    writeFileSync(join(root, "wt", ".claude", "settings.local.json"), "{}");
    assert.equal(execFileSync("git", ["-C", join(root, "wt"), "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".claude/settings.local.json").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hooks → feed e estado: sessão, ocupado, ferramentas, permissão, fim de turno", () => {
  assert.equal(mapHook("SessionStart", { session_id: "s-1", source: "startup" }).sessionId, "s-1");
  assert.match(mapHook("SessionStart", { session_id: "s-1", source: "resume" }).events[0].text, /retomada/);
  const up = mapHook("UserPromptSubmit", { prompt: "arruma o botão\n\n[ANEXOS]\n1. a.png (image, 3 KB) — .cardume/refs/a.png — imagem\n[/ANEXOS]" });
  assert.equal(up.busy, true);
  assert.equal(up.status, "running");
  assert.equal(up.events[0].agent, "Você");
  assert.match(up.events[0].text, /^Você: arruma o botão \[1 anexo\(s\)\]$/, "o app reconhece como fala do humano (evIsUserMsg)");
  assert.deepEqual(mapHook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }).events, [{ type: "edit", text: "src/a.ts", ok: true }]);
  assert.equal(mapHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }).events[0].type, "bash");
  assert.deepEqual(mapHook("PreToolUse", { tool_name: "mcp__cardume__claim", tool_input: { path: "src/**", mode: "write" } }).claim, { path: "src/**", mode: "write" });
  assert.equal(mapHook("PreToolUse", { tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n" } }).events[0].text, "a.ts, b.ts", "Codex apply_patch");
  assert.equal(mapHook("PostToolUse", { tool_name: "Bash", tool_response: { stdout: "ok" } }).events.length, 0, "sucesso não polui o feed");
  assert.equal(mapHook("PostToolUse", { tool_name: "Bash", tool_response: { is_error: true, error: "exit 1" } }).events[0].ok, false);
  assert.match(mapHook("Notification", { message: "Claude needs your permission to use Bash" }).events[0].text, /esperando você no terminal/);
  const stop = mapHook("Stop", { session_id: "s-1", last_assistant_message: "Pronto: botão corrigido." });
  assert.deepEqual([stop.busy, stop.turnEnd, stop.events[0].type, stop.events[0].text], [false, true, "done", "Pronto: botão corrigido."]);
  const cx = mapHook("codex-notify", { type: "agent-turn-complete", "thread-id": "th-9", "last-assistant-message": "feito" });
  assert.deepEqual([cx.busy, cx.turnEnd, cx.sessionId, cx.events[0].text], [false, true, "th-9", "feito"]);
  const end = mapHook("SessionEnd", { reason: "prompt_input_exit" });
  assert.deepEqual([end.busy, end.ended], [false, true]);
  assert.deepEqual(mapHook("Desconhecido", {}).events, []);
});

test("applyHook grava no banco: sessão, trava de turno com o pid do PTY, status e feed", () => {
  withStore((store, dir) => {
    store.createTask(spec("t"), "b", dir, "main");
    store.setStatus("t", "review");
    store.termSetPid("t", process.pid, "claude");
    applyHook(store, "t", mapHook("SessionStart", { session_id: "sess-42" }));
    assert.equal(store.getTask("t")!.session_id, "sess-42", "pro --resume");
    applyHook(store, "t", mapHook("UserPromptSubmit", { prompt: "oi" }));
    assert.equal(store.getTask("t")!.status, "running");
    assert.equal(store.termGet("t")!.busy, 1);
    assert.equal(store.busyPid("t"), process.pid, "ocupado = trava do turno (o automático não sobe outro agente)");
    applyHook(store, "t", mapHook("PreToolUse", { tool_name: "Write", tool_input: { file_path: "x.md" } }));
    applyHook(store, "t", mapHook("Stop", { last_assistant_message: "ok" }));
    assert.equal(store.termGet("t")!.busy, 0);
    assert.equal(store.busyPid("t"), null);
    const evs = store.eventsForTask("t").map((e) => [e.agent, e.type, e.text]);
    assert.deepEqual(evs.slice(-4), [["Sistema", "status", "terminal: sessão iniciada"], ["Você", "note", "Você: oi"], ["Vega", "write", "x.md"], ["Vega", "done", "ok"]]);
  });
});

test("custo pela statusLine: grava só o DELTA do acumulado da sessão (e não conta duas vezes)", () => {
  withStore((store, dir) => {
    store.createTask(spec("t"), "b", dir, "main");
    const sum = () => Number((store.db.prepare("SELECT COALESCE(SUM(usd),0) u FROM cost WHERE task_id='t'").get() as { u: number }).u);
    assert.equal(recordStatuslineCost(store, "t", { session_id: "s", cost: { total_cost_usd: 0.05 }, model: { id: "claude-sonnet" } }), 0.05);
    assert.equal(recordStatuslineCost(store, "t", { session_id: "s", cost: { total_cost_usd: 0.05 } }), 0, "mesma leitura = nada");
    assert.ok(Math.abs(recordStatuslineCost(store, "t", { session_id: "s", cost: { total_cost_usd: 0.12 } }) - 0.07) < 1e-9);
    assert.equal(recordStatuslineCost(store, "t", { session_id: "s", cost: { total_cost_usd: 0.1 } }), 0, "acumulado menor (barra atrasada) não desconta");
    assert.equal(recordStatuslineCost(store, "t", {}), 0);
    assert.ok(Math.abs(sum() - 0.12) < 1e-9);
    // retomada (--resume) restaura o acumulado: a base é a MESMA tabela do claude -p
    assert.ok(Math.abs(recordStatuslineCost(store, "t", { session_id: "s", cost: { total_cost_usd: 0.2 } }) - 0.08) < 1e-9);
  });
});

test("última fala do agente vem do transcript quando o Stop não traz", () => {
  withStore((_s, dir) => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, [JSON.stringify({ type: "user", message: { content: "oi" } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Feito!" }, { type: "tool_use" }] } }), ""].join("\n"));
    assert.equal(lastAssistantText(f), "Feito!");
    assert.equal(lastAssistantText(join(dir, "nada.jsonl")), "");
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repoFixture(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-termorch-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { root, repo };
}

test("fim de turno no terminal: commita, roda o gate e leva pra review; turno novo no meio não perde o status", async () => {
  const { root, repo } = repoFixture();
  const prev = process.env.CARDUME_NOTIFY;
  process.env.CARDUME_NOTIFY = "0";
  const orch = new Orchestrator(repo);
  try {
    const s = spec("tt", { requirements: ["arquivo hello.txt existe"], termMode: "terminal", autoPr: "no" });
    const t = await orch.createTask(s);
    orch.store.setStatus("tt", "running");
    writeFileSync(join(t.worktree, "hello.txt"), "oi\n");
    // sem requirements.json: gate pendente, mas a tarefa vai pra review (o humano decide)
    let gate = await orch.terminalTurnEnd("tt");
    assert.equal(gate!.ok, false);
    assert.equal(orch.store.getTask("tt")!.status, "review");
    assert.match(git(t.worktree, "log", "-1", "--pretty=%s"), /starfork\(terminal\)/, "mudança do turno commitada");
    assert.ok((orch.store.getDiff("tt")?.files ?? 0) >= 1);
    assert.ok(orch.store.eventsForTask("tt").some((e) => /gate de verificação: pendente/.test(e.text)));
    // agente escreveu a prova → gate ok
    mkdirSync(join(t.worktree, ".cardume", "artifacts"), { recursive: true });
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "proof.md"), "cat hello.txt → oi");
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "requirements.json"), JSON.stringify([{ req: "arquivo hello.txt existe", status: "done", evidence: ["proof.md"] }]));
    orch.store.setStatus("tt", "running");
    gate = await orch.terminalTurnEnd("tt");
    assert.equal(gate!.ok, true, JSON.stringify(gate));
    assert.equal(orch.store.getTask("tt")!.status, "review");
    // a pessoa já mandou outra mensagem (UserPromptSubmit → ocupado): o fim de turno atrasado não rebaixa pra review
    orch.store.setStatus("tt", "running");
    await orch.terminalTurnEnd("tt", () => true);
    assert.equal(orch.store.getTask("tt")!.status, "running");
  } finally {
    orch.close();
    if (prev === undefined) delete process.env.CARDUME_NOTIFY; else process.env.CARDUME_NOTIFY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pedidos do app viram texto pro terminal com os mesmos efeitos (requisito novo, ajuste, prova)", async () => {
  const { root, repo } = repoFixture();
  const orch = new Orchestrator(repo);
  try {
    const t = await orch.createTask(spec("tm", { requirements: ["r1"], termMode: "terminal" }));
    assert.equal(await termMessage(orch, "tm", "talk", { msg: "oi" }), "oi");
    const asReq = await termMessage(orch, "tm", "talk", { msg: "exportar CSV", asReq: true });
    assert.match(asReq, /REQUISITO novo/);
    assert.deepEqual((JSON.parse(orch.store.getTask("tm")!.spec_json) as TaskSpec).requirements, ["r1", "exportar CSV"]);
    assert.match(readFileSync(join(t.worktree, ".cardume", "TASK.yaml"), "utf8"), /exportar CSV/);
    assert.match(await termMessage(orch, "tm", "deliver", { deliver: "proof" }), /PROVA na UI REAL/);
    orch.store.addInstruction("tm", "botão azul");
    const adj = await termMessage(orch, "tm", "rework", {});
    assert.match(adj, /AJUSTE SOLICITADO.*botão azul/);
    assert.equal(orch.store.openInstructions("tm").length, 0, "instrução aplicada");
    await assert.rejects(termMessage(orch, "tm", "talk", { msg: "  " }), /vazia/);
    assert.ok(existsSync(t.worktree));
  } finally {
    orch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
