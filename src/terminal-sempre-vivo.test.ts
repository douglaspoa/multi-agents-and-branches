// node --test src/terminal-sempre-vivo.test.ts  (npm test)
// TERMINAL SEMPRE VIVO (mesa 09/10): menu aberto segura a fila do app, Cadeado 1 em plan mode, portão do teto ao abrir
// pra trabalhar, e o REVISOR no mesmo terminal (troca de papel pedida pelo fim de turno). Repos git TEMPORÁRIOS; a IA
// é um binário falso (nunca o `claude` de verdade) e a config do Claude Code vai pra uma pasta temporária.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, reviewerBlockedWhy, revisorAutoOn, REVISOR_AUTO_DEFAULT } from "./orchestrator.ts";
import { parseArgs } from "./util/args.ts";
import { aiLaunch, applyHook, iaExit, KICKOFF, trustClaudeProject, mapHook, PLAN_READY_NOTE, reviewKick, termCapGate, termMessage, termPrep, waitingMenu } from "./terminal.ts";
import type { TaskSpec } from "./types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const spec = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({ id, title: id, objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude" }], engine: "claude", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, autoPr: "no", ...extra }) as TaskSpec;
const TEAM = [{ role: "builder", name: "Vega", engine: "claude" }, { role: "reviewer", name: "Iris", engine: "claude", model: "opus" }] as TaskSpec["roles"];

/** repo git + config do Claude Code isolada + IA falsa; devolve a limpeza. */
function fixture(): { root: string; repo: string; done: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-sempre-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t"); git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");
  const fake = join(root, "ia-falsa");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
  const keep = { cfg: process.env.CLAUDE_CONFIG_DIR, bin: process.env.CARDUME_AI_BIN_claude, notify: process.env.CARDUME_NOTIFY, rev: process.env.STARFORK_REVISOR_AUTO };
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-cfg"); mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  process.env.CARDUME_AI_BIN_claude = fake;
  process.env.CARDUME_NOTIFY = "0";
  const back = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return { root, repo, done: () => { back("CLAUDE_CONFIG_DIR", keep.cfg); back("CARDUME_AI_BIN_claude", keep.bin); back("CARDUME_NOTIFY", keep.notify); back("STARFORK_REVISOR_AUTO", keep.rev); rmSync(root, { recursive: true, force: true }); } };
}
const specOf = (orch: Orchestrator, id: string) => JSON.parse(orch.store.getTask(id)!.spec_json) as TaskSpec & Record<string, any>;

test("menu aberto (permissão/elicitação) segura a fila do app; idle_prompt não; Stop/prompt soltam", () => {
  assert.equal(waitingMenu("permission_prompt", ""), true);
  assert.equal(waitingMenu("elicitation_dialog", ""), true);
  assert.equal(waitingMenu("idle_prompt", "Claude is waiting for your input"), false, "parado no prompt não é menu (Téo)");
  assert.equal(waitingMenu(undefined, "Claude needs your permission to use Bash"), true, "versão sem notification_type: pelo texto");
  assert.equal(mapHook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }).waiting, true);
  assert.equal(mapHook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }).waiting, undefined);
  assert.equal(mapHook("UserPromptSubmit", { prompt: "oi" }).waiting, false);
  assert.equal(mapHook("Stop", {}).waiting, false);
  const plan = mapHook("PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "1. x" } });
  assert.equal(plan.planReady, true);
  assert.equal(plan.waiting, true);
});

test("Cadeado 1 no terminal: plano pronto = precisa de você; aprovar (ferramenta roda) ou pedir mudança volta pra rodando", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("pl", { termMode: "terminal" }));
    orch.store.setStatus("pl", "running");
    applyHook(orch.store, "pl", mapHook("PreToolUse", { tool_name: "ExitPlanMode" }));
    assert.equal(orch.store.getTask("pl")!.status, "needs-you");
    assert.equal(specOf(orch, "pl").needsYou?.kind, "plano");
    assert.ok(orch.store.eventsForTask("pl").some((e) => e.text === PLAN_READY_NOTE));
    applyHook(orch.store, "pl", mapHook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }));
    assert.equal(orch.store.getTask("pl")!.status, "running", "aprovou: a ferramenta rodou");
    assert.equal(specOf(orch, "pl").needsYou, null);
  } finally { orch.close(); f.done(); }
});

test("kickoff em plan mode só na tarefa NOVA com aprovação do plano; retomar nunca reabre o cadeado", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("pm", { termMode: "terminal", autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto", planApproval: "review" } }));
    const L = aiLaunch(orch, "pm", "claude", { resume: true });
    const mode = L.args[L.args.indexOf("--permission-mode") + 1];
    assert.equal(mode, "plan", "kickoff da tarefa nova: plan mode");
    assert.equal(L.args[L.args.length - 1], KICKOFF);
    assert.equal(specOf(orch, "pm").termBuild, true, "o kickoff abre uma rodada de construção");
    orch.store.termSetSession("pm", "sess-1234-abcd");
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "x"), { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "x", "sess-1234-abcd.jsonl"), "{}\n");
    const R = aiLaunch(orch, "pm", "claude", { resume: true });
    assert.equal(R.args[R.args.indexOf("--permission-mode") + 1], "bypassPermissions", "no --resume o cadeado não reabre");
  } finally { orch.close(); f.done(); }
});

test("portão do teto ao abrir pra TRABALHAR: ≥ 80% → precisa de você com a pergunta do teto; abrir quieto passa", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("tc", { budgetUsd: 1 }));
    termCapGate(orch, "tc", "abrir o terminal"); // sem gasto: passa
    orch.store.addCost("tc", "Vega", "builder", 0.85, 1, 1, 0, "claude", undefined, 0);
    assert.throws(() => termPrep(orch, "tc", { resume: true }), /teto de custo/);
    const sp = specOf(orch, "tc");
    assert.equal(sp.budgetHit?.mode, "etapa", "liberar → ▶ abre de novo");
    assert.equal(orch.store.getTask("tc")!.status, "needs-you");
    assert.doesNotThrow(() => termPrep(orch, "tc", { resume: true, quiet: true }), "abrir pra olhar não gasta");
    await assert.rejects(termMessage(orch, "tc", "kickoff", {}), /teto de custo/, "▶ com o terminal aberto também passa pelo portão");
    sp.autopilot = true; orch.store.updateSpec("tc", JSON.stringify(sp));
    assert.doesNotThrow(() => termCapGate(orch, "tc", "x"), "piloto automático: quem decide é o piloto");
  } finally { orch.close(); f.done(); }
});

test("pedir ajuste e o ▶ no terminal aberto abrem uma rodada de CONSTRUÇÃO; conversa não", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("rb", { termMode: "terminal" }));
    await termMessage(orch, "rb", "talk", { msg: "o que você fez?" });
    assert.ok(!specOf(orch, "rb").termBuild);
    assert.equal(await termMessage(orch, "rb", "kickoff", {}), KICKOFF);
    assert.equal(specOf(orch, "rb").termBuild, true);
    orch.store.patchSpec("rb", { termBuild: null });
    orch.store.addInstruction("rb", "botão azul");
    await termMessage(orch, "rb", "rework", {});
    assert.equal(specOf(orch, "rb").termBuild, true);
  } finally { orch.close(); f.done(); }
});

test("revisor no MESMO terminal: construção → revisor (rodada 1) → muda volta pro construtor com os pedidos → revisor (2) → aprova → gate/review", async () => {
  const f = fixture();
  process.env.STARFORK_REVISOR_AUTO = "1";
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("rv", { termMode: "terminal", roles: TEAM }));
    orch.store.setStatus("rv", "running");
    orch.store.patchSpec("rv", { termBuild: true });
    writeFileSync(join(t.worktree, "a.txt"), "1\n");
    await orch.terminalTurnEnd("rv");
    let sp = specOf(orch, "rv");
    assert.equal(sp.termHandoff?.to, "reviewer", "fim da construção pede o revisor");
    assert.equal(sp.termHandoff?.round, 1);
    assert.ok(!sp.termBuild, "a rodada de construção fechou");
    assert.equal(orch.store.getTask("rv")!.status, "running", "não vai pra review antes do revisor");
    assert.match(git(t.worktree, "log", "-1", "--pretty=%s"), /starfork\(terminal\)/, "o turno do construtor foi commitado");
    // o app troca: o revisor sobe (sessão nova, persona/lente, veredito); a sessão do construtor fica guardada
    orch.store.termSetSession("rv", "sess-construtor-01");
    const R = aiLaunch(orch, "rv", "claude", { papel: "revisor", round: 1 });
    assert.ok(!R.args.includes("--resume"), "revisor: sessão nova");
    assert.equal(R.args[R.args.length - 1], reviewKick(1));
    assert.ok(R.args.some((a) => a.includes("VEREDITO")), "a regra do veredito vai no system prompt");
    assert.equal(R.args[R.args.indexOf("--model") + 1], "opus", "o modelo do papel revisor");
    sp = specOf(orch, "rv");
    assert.deepEqual(sp.termRole, { role: "reviewer", name: "Iris", builder: "Vega", round: 1, max: 2 });
    assert.equal(sp.termBuilderSid, "sess-construtor-01");
    // o revisor fala no feed com o nome DELE
    applyHook(orch.store, "rv", mapHook("UserPromptSubmit", { prompt: reviewKick(1), session_id: "sess-revisor-01" }));
    assert.equal(orch.store.getTask("rv")!.stage, "reviewer");
    writeFileSync(join(t.worktree, ".cardume", "VEREDITO.md"), "VEREDITO: muda\n- a.txt:1 — escreva 2\n");
    orch.store.patchSpec("rv", { termHandoff: null });
    await orch.terminalTurnEnd("rv");
    sp = specOf(orch, "rv");
    assert.equal(sp.reviewRounds?.length, 1);
    assert.equal(sp.termHandoff?.to, "builder");
    assert.match(String(sp.termHandoff?.msg), /escreva 2/, "os pedidos do revisor vão como 1ª mensagem do construtor");
    assert.ok(orch.store.eventsForTask("rv").some((e) => e.type === "veredito" && e.agent === "Iris"));
    // volta: o construtor retoma a sessão DELE (nunca a do revisor) e abre a rodada 2 de construção
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "w"), { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "w", "sess-construtor-01.jsonl"), "{}\n");
    const B = aiLaunch(orch, "rv", "claude", { resume: true, papel: "construtor", message: String(sp.termHandoff?.msg) });
    assert.equal(B.args[B.args.indexOf("--resume") + 1], "sess-construtor-01");
    sp = specOf(orch, "rv");
    assert.equal(sp.termRole, null);
    assert.equal(sp.termBuild, true);
    orch.store.patchSpec("rv", { termHandoff: null });
    await orch.terminalTurnEnd("rv");
    assert.equal(specOf(orch, "rv").termHandoff?.round, 2, "rodada 2 do revisor");
    aiLaunch(orch, "rv", "claude", { papel: "revisor", round: 2 });
    writeFileSync(join(t.worktree, ".cardume", "VEREDITO.md"), "VEREDITO: aprova\n");
    orch.store.patchSpec("rv", { termHandoff: null });
    await orch.terminalTurnEnd("rv");
    sp = specOf(orch, "rv");
    assert.equal(sp.reviewRounds?.length, 2);
    assert.equal(sp.termHandoff?.to, "builder", "aprovado: a conversa volta pra quem constrói (quieto)");
    assert.equal(sp.termHandoff?.msg, undefined);
    assert.equal(orch.store.getTask("rv")!.status, "review", "aprovado: gate e review");
  } finally { orch.close(); f.done(); }
});

test("revisor: 2ª rodada pedindo mudança = precisa de você com o QUÊ; desligado = segue direto pro review", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    process.env.STARFORK_REVISOR_AUTO = "1";
    await orch.createTask(spec("r2", { termMode: "terminal", roles: TEAM }));
    orch.store.setStatus("r2", "running");
    orch.store.patchSpec("r2", { reviewRounds: [{ round: 1, verdict: "muda", items: ["x"], at: 1, reviewer: "Iris" }], termRole: { role: "reviewer", name: "Iris", builder: "Vega", round: 2, max: 2 } });
    writeFileSync(join(orch.store.getTask("r2")!.worktree, ".cardume", "VEREDITO.md"), "VEREDITO: muda\n- de novo\n");
    await orch.terminalTurnEnd("r2");
    assert.equal(orch.store.getTask("r2")!.status, "needs-you");
    assert.match(String(specOf(orch, "r2").needsYou?.text), /pediu mudanças 2 vezes · decida/);
    process.env.STARFORK_REVISOR_AUTO = "0";
    await orch.createTask(spec("off", { termMode: "terminal", roles: TEAM }));
    orch.store.setStatus("off", "running");
    orch.store.patchSpec("off", { termBuild: true });
    await orch.terminalTurnEnd("off");
    assert.equal(specOf(orch, "off").termHandoff, undefined, "desligado: sem troca");
    assert.equal(orch.store.getTask("off")!.status, "review");
  } finally { orch.close(); f.done(); }
});

test("revisor bloqueado explica em português simples", () => {
  assert.equal(reviewerBlockedWhy("claude", "darwin"), "");
  assert.match(reviewerBlockedWhy("claude", "win32"), /Windows/);
  assert.match(reviewerBlockedWhy("gateway", "linux"), /IA sem terminal/);
});

test("revisor automático: Ajustes (termRevisorAuto) liga/desliga; padrão desligado até o teste de fumaça", () => {
  const home = mkdtempSync(join(tmpdir(), "starfork-rev-"));
  const keep = { home: process.env.HOME, rev: process.env.STARFORK_REVISOR_AUTO };
  try {
    delete process.env.STARFORK_REVISOR_AUTO; process.env.HOME = home;
    assert.equal(revisorAutoOn(), REVISOR_AUTO_DEFAULT);
    assert.equal(REVISOR_AUTO_DEFAULT, false, "veto do Rafa: desligado por padrão");
    mkdirSync(join(home, ".constellation"));
    writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ termRevisorAuto: "1" }));
    assert.equal(revisorAutoOn(), true);
    writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ termRevisorAuto: "0" }));
    assert.equal(revisorAutoOn(), false);
  } finally {
    if (keep.home === undefined) delete process.env.HOME; else process.env.HOME = keep.home;
    if (keep.rev === undefined) delete process.env.STARFORK_REVISOR_AUTO; else process.env.STARFORK_REVISOR_AUTO = keep.rev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("menu aberto não fica preso: a IA saindo solta a marca; teto aberto não é engolido pelo plano", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("wt", { termMode: "terminal" }));
    applyHook(orch.store, "wt", mapHook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
    const w = () => (orch.store.db.prepare("SELECT waiting FROM term_session WHERE task_id='wt'").get() as { waiting: number }).waiting;
    assert.equal(w(), 1);
    iaExit(orch.store, "wt", "claude");
    assert.equal(w(), 0, "a IA saiu: nenhum menu aberto");
    orch.store.patchSpec("wt", { needsYou: { kind: "teto", text: "decida o teto", at: 1 } });
    orch.store.setStatus("wt", "needs-you");
    applyHook(orch.store, "wt", mapHook("PreToolUse", { tool_name: "ExitPlanMode" }));
    assert.equal(specOf(orch, "wt").needsYou?.kind, "teto", "a pergunta do teto continua (o plano não a apaga)");
  } finally { orch.close(); f.done(); }
});

test("pedir ajuste e pedir prova também passam pelo portão do teto", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("tg", { termMode: "terminal", budgetUsd: 1 }));
    orch.store.addCost("tg", "Vega", "builder", 0.9, 1, 1, 0, "claude", undefined, 0);
    await assert.rejects(termMessage(orch, "tg", "rework", { msg: "x" }), /teto de custo/);
    await assert.rejects(termMessage(orch, "tg", "deliver", { deliver: "proof" }), /teto de custo/);
  } finally { orch.close(); f.done(); }
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
test("hook Stop roda o fim de turno EM LINHA (commit, gate, review) antes de devolver ao Claude Code", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("hs", { termMode: "terminal" }));
    orch.store.setStatus("hs", "running");
    orch.close();
    writeFileSync(join(t.worktree, "novo.txt"), "do turno\n");
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook", "Stop", "--starfork-task", "hs", "--repo", f.repo], { encoding: "utf8", input: JSON.stringify({ last_assistant_message: "pronto" }), env: { ...process.env, CARDUME_NOTIFY: "0" } });
    assert.equal(r.status, 0, r.stderr);
    const o2 = new Orchestrator(f.repo);
    try {
      assert.equal(o2.store.getTask("hs")!.status, "review", "quando o hook volta, o turno já foi pra revisão");
      assert.match(git(t.worktree, "log", "-1", "--pretty=%s"), /starfork\(terminal\)/, "commitado dentro do hook");
      assert.ok(o2.store.eventsForTask("hs").some((e) => /gate de verificação/.test(e.text)));
    } finally { o2.close(); }
  } finally { try { orch.close(); } catch { /* fechado */ } f.done(); }
});

test("fim de turno em linha com gate ok: o PR sai DESTACADO (openPr) — e --so-pr é flag sem valor", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("pr", { termMode: "terminal", requirements: ["r1"] }));
    mkdirSync(join(t.worktree, ".cardume", "artifacts"), { recursive: true });
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "proof.md"), "ok");
    writeFileSync(join(t.worktree, ".cardume", "artifacts", "requirements.json"), JSON.stringify([{ req: "r1", status: "done", evidence: ["proof.md"] }]));
    orch.store.setStatus("pr", "running");
    const g = await orch.terminalTurnEnd("pr", () => false, { deferPr: true });
    assert.equal(g!.ok, true, JSON.stringify(g));
    assert.equal(g!.openPr, true, "o PR fica pro processo destacado");
    const a = parseArgs(["turn-end", "pr", "--so-pr", "--repo", "/r"]);
    assert.equal(a.flags["so-pr"], "true"); assert.equal(a.flags.repo, "/r");
  } finally { orch.close(); f.done(); }
});

test("revisão de PR no terminal: o review fatual do diff entra UMA vez; a pasta de revisão é confiada", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("rp", { termMode: "terminal", kind: "review", roles: [{ role: "reviewer", name: "Iris", engine: "claude" }] }));
    writeFileSync(join(t.worktree, "DIFF.patch"), "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    orch.store.setStatus("rp", "running");
    await orch.terminalTurnEnd("rp");
    orch.store.setStatus("rp", "running");
    await orch.terminalTurnEnd("rp");
    assert.ok(orch.store.getReview("rp"), "review fatual gravado");
    assert.equal(orch.store.eventsForTask("rp").filter((e) => /^review pronto/.test(e.text)).length, 1, "uma vez só");
    const cfg = join(f.root, "trust"); mkdirSync(cfg);
    writeFileSync(join(cfg, ".claude.json"), "{}");
    assert.equal(trustClaudeProject(join(f.repo, ".cardume", "reviews", "pr-1"), f.repo, { CLAUDE_CONFIG_DIR: cfg }), true, "pasta de revisão de PR confiada");
    assert.equal(trustClaudeProject(join(f.root, "fora"), f.repo, { CLAUDE_CONFIG_DIR: cfg }), false);
  } finally { orch.close(); f.done(); }
});

test("waiting no banco: menu de permissão marca, ferramenta rodando e fim de turno soltam", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("wq", { termMode: "terminal" }));
    const w = () => (orch.store.db.prepare("SELECT waiting FROM term_session WHERE task_id='wq'").get() as { waiting: number }).waiting;
    applyHook(orch.store, "wq", mapHook("Notification", { notification_type: "permission_prompt", message: "x" }));
    assert.equal(w(), 1);
    applyHook(orch.store, "wq", mapHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    assert.equal(w(), 0, "permitiu: a ferramenta rodou");
    applyHook(orch.store, "wq", mapHook("Notification", { notification_type: "elicitation_dialog", message: "x" }));
    applyHook(orch.store, "wq", mapHook("Stop", {}));
    assert.equal(w(), 0);
  } finally { orch.close(); f.done(); }
});
