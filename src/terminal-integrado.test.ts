// node --test src/terminal-integrado.test.ts  (npm test)
// TERMINAL INTEGRADO: as tools novas do MCP (servidor de verdade, stdio), os /starfork-* do Claude Code (fusão sem
// sobrescrever o que é da pessoa) e o DeepSeek dentro do `claude` (env, chave fora do argv, custo não gravado).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";
import { tempHome } from "./testing/temp-home.ts";
import { cleanSuggestions, findCommand, mergeSection, naturalCommand, SECTION_BEGIN, SECTION_END, shellInstructions, STARFORK_COMMANDS, STARFORK_MARK, suggestedSinceUser, suggestFromText, writeInstructionsSection, writeStarforkCommands } from "./terminal-integrado.ts";
import { etapaStatus, parseSf } from "./starfork-cli.ts";
import { aiOfEngine, claudeJsonPath, codexTrustArg, geminiSettings, trustClaudeProject, mergedRule, deepseekClaudeEnv, DEEPSEEK_ANTHROPIC_URL, launchScript, NEXT_MSG_REL, recommendedLaunch, shArg, shimScript, skipStatuslineCost, TERM_BIN_REL, terminalCapable, termAiOf, termModelOf, termPrep } from "./terminal.ts";
import type { TaskSpec } from "./types.ts";

const SERVER = fileURLToPath(new URL("./mcp/server.ts", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const spec = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({ id, title: id, objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude" }], engine: "claude", deliverables: ["d1"], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, autoPr: "no", ...extra }) as TaskSpec;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-integrado-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const h = tempHome();
  const cfg = join(root, "claude-cfg");
  mkdirSync(cfg, { recursive: true });
  return { root, repo, home: h.home, cfg, db: join(repo, ".cardume", "state.sqlite"), done: () => { h.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

/** Sobe o servidor MCP de verdade e manda as chamadas EM SEQUÊNCIA (cada uma espera a resposta). */
async function mcp(f: { db: string; home: string; cfg: string }, task: string, calls: { name: string; arguments?: unknown }[]): Promise<{ text: string; isError: boolean }[]> {
  const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], {
    env: { ...process.env, CARDUME_DB: f.db, CARDUME_TASK: task, CARDUME_AGENT: "Vega", CARDUME_ROLE: "builder", HOME: f.home, CLAUDE_CONFIG_DIR: f.cfg, CARDUME_NOTIFY: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const replies: Record<number, any> = {};
  srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* não-JSON */ } } });
  const out: { text: string; isError: boolean }[] = [];
  try {
    for (let n = 0; n < calls.length; n++) {
      const id = n + 1;
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: calls[n].name, arguments: calls[n].arguments ?? {} } }) + "\n");
      for (let k = 0; k < 1200 && !replies[id]; k++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(replies[id], `sem resposta pra ${calls[n].name}`);
      out.push({ text: replies[id].result.content[0].text, isError: !!replies[id].result.isError });
    }
  } finally {
    srv.stdin.end();
    await new Promise((r) => srv.on("close", r));
  }
  return out;
}

test("suggest_replies: limpa, deduplica, corta em 60 e grava o evento 'suggest'; inválido vira erro sem derrubar o servidor", async () => {
  assert.deepEqual(cleanSuggestions(["  pode seguir ", "Pode seguir", "mostra o diff", "", "abre o PR", "x", "y"]), { ok: true, options: ["pode seguir", "mostra o diff", "abre o PR", "x"] });
  assert.equal(cleanSuggestions(["só uma"]).ok, false);
  assert.equal(cleanSuggestions("texto").ok, false);
  const long = cleanSuggestions(["a".repeat(80), "b"]);
  assert.ok(long.ok && long.options[0].length === 60 && long.options[0].endsWith("…"));
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("sg"));
    orch.close();
    const [ok, bad, unk] = await mcp(f, "sg", [{ name: "suggest_replies", arguments: { options: ["pode seguir", "mostra o diff"] } }, { name: "suggest_replies", arguments: { options: ["a", "A"] } }, { name: "nao_existe" }]);
    assert.equal(ok.isError, false, ok.text);
    assert.equal(bad.isError, true);
    assert.equal(unk.isError, true);
    const s = new Store(f.db);
    try {
      const ev = s.eventsForTask("sg").filter((e) => e.type === "suggest");
      assert.equal(ev.length, 1);
      assert.deepEqual(JSON.parse(ev[0].text), ["pode seguir", "mostra o diff"]);
    } finally { s.close(); }
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("task_status / set_status / open_pr (gate): provas por requisito, o que falta, status travado em integrada", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("st", { requirements: ["arquivo hello existe", "botão azul"] }));
    await orch.createTask(spec("integrada"));
    orch.store.setStatus("st", "running");
    orch.store.setStatus("integrada", "merged");
    const art = join(t.worktree, ".cardume", "artifacts");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "proof.md"), "cat hello → oi");
    writeFileSync(join(art, "requirements.json"), JSON.stringify([{ req: "arquivo hello existe", status: "done", evidence: ["proof.md"] }, { req: "botão azul", status: "todo" }]));
    orch.close();
    const [st, rev, bad, pr, draftless] = await mcp(f, "st", [
      { name: "task_status" },
      { name: "set_status", arguments: { status: "review", note: "terminei a primeira parte" } },
      { name: "set_status", arguments: { status: "merged", note: "x" } },
      { name: "open_pr", arguments: {} },
      { name: "set_status", arguments: { status: "needs-you", note: "qual tom de azul?" } },
    ]);
    assert.equal(st.isError, false, st.text);
    assert.match(st.text, /Tarefa: st/);
    assert.match(st.text, /\[provado\] arquivo hello existe → proof\.md/);
    assert.match(st.text, /\[pendente\] botão azul/);
    assert.match(st.text, /Requisitos \(1\/2 provados\)/);
    assert.match(st.text, /- d1/, "entregáveis");
    assert.match(st.text, /- proof\.md/, "artefatos");
    assert.match(st.text, /Falta para PROVADO:[\s\S]*botão azul[\s\S]*set_status review/);
    assert.match(st.text, /Falta para ENTREGUE:[\s\S]*open_pr/);
    assert.equal(rev.isError, false, rev.text);
    assert.match(rev.text, /pronta pra revisão[\s\S]*Ainda falta para PROVADO[\s\S]*botão azul/);
    assert.ok(!/set_status review/.test(rev.text), "já está em review: não pede de novo");
    assert.equal(bad.isError, true);
    assert.match(bad.text, /review \| needs-you \| running/);
    assert.equal(pr.isError, true, "gate reprovou: não abre (e nem tenta rede)");
    assert.match(pr.text, /PR NÃO aberto[\s\S]*botão azul[\s\S]*draft=true/);
    assert.equal(draftless.isError, false);
    const s = new Store(f.db);
    try {
      assert.equal(s.getTask("st")!.status, "needs-you");
      const texts = s.eventsForTask("st").map((e) => e.text);
      assert.ok(texts.includes("pronta pra revisão — terminei a primeira parte"), texts.join("\n"));
      assert.ok(texts.includes("esperando você — qual tom de azul?"));
      assert.ok(texts.some((x) => /^PR NÃO aberto \(gate de verificação\)/.test(x)));
    } finally { s.close(); }
    const [locked] = await mcp(f, "integrada", [{ name: "set_status", arguments: { status: "running", note: "voltar" } }]);
    assert.equal(locked.isError, true);
    assert.match(locked.text, /integrada/);
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("list_skills / use_skill: ativas do projeto primeiro, depois projeto e pessoais; corpo sem frontmatter; desconhecida lista as disponíveis", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  const skill = (dir: string, name: string, desc: string, body: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${body}\n`); };
  try {
    await orch.createTask(spec("sk"));
    orch.close();
    skill(join(f.repo, ".claude", "skills"), "rodar-lint", "Roda o lint do projeto", "Rode npm run lint e corrija.");
    skill(join(f.repo, ".claude", "skills"), "citar-fonte", "Cita a fonte de cada dado", "Sempre cite.");
    skill(join(f.cfg, "skills"), "minha-pessoal", "Skill pessoal", "Faça do meu jeito.");
    writeFileSync(join(f.repo, ".cardume", "skills.json"), JSON.stringify([{ name: "citar-fonte" }]));
    const [list, use, unknown, traversal] = await mcp(f, "sk", [{ name: "list_skills" }, { name: "use_skill", arguments: { name: "rodar-lint" } }, { name: "use_skill", arguments: { name: "nao-tem" } }, { name: "use_skill", arguments: { name: "../../etc" } }]);
    const lines = list.text.split("\n").filter((l) => l.startsWith("- "));
    assert.deepEqual(lines.map((l) => l.slice(2).split(" [")[0]), ["citar-fonte", "rodar-lint", "minha-pessoal"]);
    assert.match(lines[0], /\[projeto · ativa\]: Cita a fonte/);
    assert.match(lines[2], /\[pessoal\]: Skill pessoal/);
    assert.equal(use.isError, false);
    assert.match(use.text, /^# Skill rodar-lint \(projeto\)/);
    assert.match(use.text, /Rode npm run lint e corrija\./);
    assert.ok(!/^---$/m.test(use.text) && !/description:/.test(use.text), "sem frontmatter");
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /não encontrada\. Disponíveis: citar-fonte, rodar-lint, minha-pessoal/);
    assert.equal(traversal.isError, true);
    const s = new Store(f.db);
    try { assert.ok(s.eventsForTask("sk").some((e) => e.text === "usou a skill rodar-lint")); } finally { s.close(); }
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("create_task: tarefa nova em RASCUNHO no mesmo projeto, herda épico/equipe/modo; id livre; evento na tarefa atual", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("mae", { epicId: "ep-1", epicDoneWhen: ["D1: abre"], termMode: "terminal", roles: [{ role: "builder", name: "Vega", engine: "claude", model: "opus" }] }));
    await orch.createTask(spec("exportar-csv")); // id ocupado → a nova vira exportar-csv-2
    orch.close();
    const [ok, empty, other] = await mcp(f, "mae", [
      { name: "create_task", arguments: { title: "Exportar CSV", objective: "baixar a lista em CSV", requirements: ["botão baixa .csv"] } },
      { name: "create_task", arguments: { title: "  ", objective: "x" } },
      { name: "create_task", arguments: { title: "Fora do épico", objective: "y", same_epic: false } },
    ]);
    assert.equal(ok.isError, false, ok.text);
    assert.match(ok.text, /tarefa criada: exportar-csv-2 — "Exportar CSV" · rascunho criado — inicie pelo quadro quando quiser/);
    assert.equal(empty.isError, true);
    assert.equal(other.isError, false, other.text);
    const s = new Store(f.db);
    try {
      const t = s.getTask("exportar-csv-2")!;
      assert.equal(t.status, "draft");
      assert.ok(existsSync(t.worktree), "worktree criada");
      const sp = JSON.parse(t.spec_json) as TaskSpec;
      assert.equal(sp.epicId, "ep-1");
      assert.deepEqual(sp.epicDoneWhen, ["D1: abre"]);
      assert.equal(sp.linkedTo, "mae");
      assert.equal(sp.termMode, "terminal");
      assert.deepEqual(sp.requirements, ["botão baixa .csv"]);
      assert.equal(sp.objective, "baixar a lista em CSV");
      assert.equal(sp.roles[0].model, "opus");
      assert.equal((JSON.parse(s.getTask("fora-do-epico")!.spec_json) as TaskSpec).epicId, undefined);
      assert.ok(s.eventsForTask("mae").some((e) => e.text === 'criou a tarefa "Exportar CSV" (exportar-csv-2)'));
    } finally { s.close(); }
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("/starfork-*: escreve os nossos, NÃO sobrescreve o da pessoa, é idempotente e tem equivalente em linguagem natural", () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "starfork-cmds-")));
  try {
    const dir = join(wt, ".claude", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "starfork-pr.md"), "meu comando próprio\n");
    writeFileSync(join(dir, "outro.md"), "não é nosso\n");
    const r = writeStarforkCommands(wt);
    assert.deepEqual(r.skipped, [".claude/commands/starfork-pr.md"]);
    assert.equal(r.written.length, STARFORK_COMMANDS.length - 1);
    assert.equal(readFileSync(join(dir, "starfork-pr.md"), "utf8"), "meu comando próprio\n");
    assert.equal(readFileSync(join(dir, "outro.md"), "utf8"), "não é nosso\n");
    const etapa = readFileSync(join(dir, "starfork-etapa.md"), "utf8");
    assert.match(etapa, /^---\ndescription: ".+"\nargument-hint: "construir\|provar\|entregar"\n---\n<!-- starfork -->\n/);
    assert.match(etapa, /\$ARGUMENTS/);
    assert.match(etapa, /set_status/);
    // nosso arquivo antigo (com a marca) é atualizado; rodar de novo não muda nada
    writeFileSync(join(dir, "starfork-skill.md"), `${STARFORK_MARK}\nversão velha`);
    const r2 = writeStarforkCommands(wt);
    assert.ok(r2.written.includes(".claude/commands/starfork-skill.md"));
    assert.match(readFileSync(join(dir, "starfork-skill.md"), "utf8"), /use_skill/);
    assert.deepEqual(writeStarforkCommands(wt), r2);
    for (const c of STARFORK_COMMANDS) for (const k of ["name", "description", "argumentHint", "body"] as const) assert.ok(c[k], `${c.name}.${k}`);
    assert.equal(findCommand("/starfork-pr")?.name, "starfork-pr");
    assert.equal(findCommand("etapa")?.name, "starfork-etapa");
    const nat = naturalCommand("starfork-skill", "rodar-lint");
    assert.match(nat, /use_skill com name = "rodar-lint"/);
    assert.ok(!nat.includes("$ARGUMENTS"));
    assert.match(naturalCommand("/starfork-revisao"), /4 lentes|correção.*testes.*UX.*segurança/s);
    assert.throws(() => naturalCommand("nada"), /comando desconhecido/);
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test("DeepSeek no terminal: `claude` com a API Anthropic-compatível, chave só no env, sem custo da barra; sem chave = erro claro", async () => {
  assert.ok(terminalCapable("deepseek") && terminalCapable("DeepSeek · V4 Pro") && terminalCapable("dsh-flash"));
  assert.ok(!terminalCapable("gateway", "win32"));
  const e = deepseekClaudeEnv("", "sk-teste");
  assert.equal(e.ANTHROPIC_BASE_URL, DEEPSEEK_ANTHROPIC_URL);
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, "sk-teste");
  assert.equal(e.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]", "vazio = o capaz");
  assert.equal(e.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash");
  assert.equal(deepseekClaudeEnv("deepseek-flash", "k").ANTHROPIC_MODEL, "deepseek-flash[1m]");
  assert.equal(deepseekClaudeEnv("opus", "k").ANTHROPIC_MODEL, "deepseek-v4-pro[1m]", "alias do Claude → o capaz");
  assert.throws(() => deepseekClaudeEnv("x", " "), /DEEPSEEK_API_KEY/);
  assert.ok(skipStatuslineCost({ STARFORK_ENGINE: "deepseek" }) && !skipStatuslineCost({}));

  const f = fixture();
  const keys = ["HOME", "DEEPSEEK_API_KEY", "CARDUME_NOTIFY", "CARDUME_AI_BIN_claude"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // binário do claude falso (o teste não depende de ter o Claude Code instalado)
  const fake = join(f.root, "bin", "claude");
  mkdirSync(join(f.root, "bin"), { recursive: true });
  writeFileSync(fake, "#!/bin/sh\n");
  Object.assign(process.env, { HOME: f.home, CARDUME_NOTIFY: "0", CARDUME_AI_BIN_claude: fake });
  delete process.env.DEEPSEEK_API_KEY;
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("ds", { engine: "deepseek", roles: [{ role: "builder", name: "Vega", engine: "deepseek", model: "deepseek-flash" }] }));
    assert.throws(() => termPrep(orch, "ds"), /Falta a chave da DeepSeek/, "shell: erro claro ANTES de abrir o PTY");
    assert.throws(() => termPrep(orch, "ds", { direct: true }), /Falta a chave da DeepSeek/);
    writeFileSync(join(f.home, ".constellation", "llm.env"), "DEEPSEEK_API_KEY=sk-segredo-123\n");
    // a IA direto (Windows) — o MESMO lançamento que o `starfork ia deepseek` roda dentro do shell
    const L = termPrep(orch, "ds", { direct: true });
    assert.equal(L.engine, "deepseek");
    assert.match(L.program, /claude/);
    assert.equal(L.env.ANTHROPIC_AUTH_TOKEN, "sk-segredo-123");
    assert.equal(L.env.ANTHROPIC_MODEL, "deepseek-flash[1m]");
    assert.equal(L.env.STARFORK_ENGINE, "deepseek");
    assert.ok(!L.args.some((a) => a.includes("sk-segredo-123")), "chave nunca no argv");
    assert.ok(!L.args.includes("--model"), "modelo vai no env");
    assert.ok(!L.envRemove.includes("ANTHROPIC_AUTH_TOKEN") && L.envRemove.includes("ANTHROPIC_API_KEY"));
    const sys = L.args[L.args.indexOf("--append-system-prompt") + 1];
    assert.match(sys, /Terminal integrado do Starfork[\s\S]*suggest_replies[\s\S]*@\.cardume\/refs/);
    assert.match(sys, /\/starfork-etapa/);
    assert.ok(existsSync(join(t.worktree, ".claude", "commands", "starfork-pr.md")));
    assert.equal(git(t.worktree, "status", "--porcelain", "--", ".claude"), "", "comandos e settings fora do git");
    // Claude puro: mesmo bloco, sem env da DeepSeek
    await orch.createTask(spec("cl"));
    const C = termPrep(orch, "cl", { direct: true });
    assert.equal(C.engine, "claude");
    assert.equal(C.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.ok(C.envRemove.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.match(C.args[C.args.indexOf("--append-system-prompt") + 1], /suggest_replies/);
  } finally {
    orch.close();
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    f.done();
  }
});

// ======================= terminal integrado NO SHELL (qualquer IA) =======================
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** `starfork <args>` de verdade (o motor), no ambiente do terminal da tarefa. */
function sf(f: { db: string; home: string; cfg: string }, task: string, args: string[], extra: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "starfork", ...args], {
    encoding: "utf8", env: { ...process.env, CARDUME_DB: f.db, CARDUME_TASK: task, CARDUME_AGENT: "Vega", CARDUME_ROLE: "builder", HOME: f.home, CLAUDE_CONFIG_DIR: f.cfg, CARDUME_NOTIFY: "0", ...extra },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
/** Troca env do processo durante o teste (termPrep/aiLaunch leem o process.env). */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const fakeBin = (dir: string, name: string) => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, "#!/bin/sh\necho \"--help --prompt-interactive --resume\"\n"); chmodSync(p, 0o755); return p; };

test("recomendado: IA + modelo que a criação decidiu; troca de IA no app grava termAi/termModel; Gemini não herda modelo do Claude", () => {
  const base = spec("r", { roles: [{ role: "builder", name: "Vega", engine: "claude", model: "sonnet" }] });
  assert.deepEqual(recommendedLaunch(base), { ai: "claude", model: "sonnet", command: "starfork ia claude --modelo sonnet" });
  assert.equal(termAiOf(spec("x", { engine: "codex", roles: [{ role: "builder", name: "V", engine: "codex" }] })), "codex");
  assert.equal(aiOfEngine("DeepSeek · V4 Pro"), "deepseek");
  assert.equal(aiOfEngine("dsh-flash"), "deepseek");
  assert.equal(aiOfEngine("gateway"), "claude", "motor sem CLI próprio abre o Claude Code");
  assert.equal(aiOfEngine("opus"), "claude");
  assert.deepEqual(recommendedLaunch({ ...base, termAi: "gemini" }), { ai: "gemini", model: "", command: "starfork ia gemini" }, "modelo do Claude não serve pro Gemini");
  assert.deepEqual(recommendedLaunch({ ...base, termAi: "gemini", termModel: "gemini-2.5-flash" }).command, "starfork ia gemini --modelo gemini-2.5-flash");
  assert.equal(recommendedLaunch({ ...base, termAi: "claude" }).model, "sonnet", "voltou pra IA da tarefa sem escolher modelo = o do papel");
  assert.equal(recommendedLaunch({ ...base, termAi: "nada" as never }).ai, "claude", "termAi inválida = a do motor");
  assert.equal(termModelOf({ ...base, roles: [{ role: "builder", name: "V", engine: "claude", model: "claude opus 4" }] }), "claude opus 4");
  assert.equal(shArg("claude opus 4"), "'claude opus 4'");
  assert.equal(shArg("deepseek-v4-pro"), "deepseek-v4-pro");
});

test("shell (macOS/Linux): PTY = shell de login na worktree subindo `starfork ia`; shim no PATH; mensagem por arquivo; fora do git", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("sh", { roles: [{ role: "builder", name: "Vega", engine: "claude", model: "sonnet" }] }));
    const L = withEnv({ HOME: f.home, SHELL: "/bin/bash", CARDUME_NOTIFY: "0" }, () => termPrep(orch, "sh", { resume: true, message: "oi do app 'com aspas'" }));
    assert.equal(L.shell, true);
    assert.equal(L.program, "/bin/bash", "o shell da pessoa ($SHELL)");
    assert.deepEqual(L.args.slice(0, 3), ["-l", "-i", "-c"], "login + interativo");
    const shim = join(t.worktree, TERM_BIN_REL, "starfork");
    assert.equal(L.args[3], `'${shim}' ia claude --modelo sonnet --resume --msg-file '${NEXT_MSG_REL}'; '/bin/bash' -l -i; :`, "sobe a IA da tarefa com o modelo dela e, ao sair, vira o shell");
    assert.ok(!L.args[3].includes("oi do app"), "texto do humano NUNCA no argv do shell");
    assert.equal(readFileSync(join(t.worktree, NEXT_MSG_REL), "utf8"), "oi do app 'com aspas'");
    assert.equal(L.env.PATH.split(":")[0], join(t.worktree, TERM_BIN_REL), "`starfork` na frente do PATH");
    assert.equal(L.env.CARDUME_TASK, "sh");
    assert.equal(L.env.STARFORK_TERMINAL, "1");
    assert.equal(L.cwd, t.worktree);
    assert.equal(L.engine, "claude");
    assert.equal(L.busy, true, "leva mensagem: nasce ocupado");
    assert.deepEqual(L.recommended, { ai: "claude", model: "sonnet", command: "starfork ia claude --modelo sonnet" });
    assert.ok(statSync(shim).mode & 0o100, "shim executável");
    const body = readFileSync(shim, "utf8");
    assert.match(body, /^#!\/bin\/sh\n/);
    assert.match(body, /starfork ia-prep "\$@"\) \|\| \{ .* starfork _ia-exit "\$1" --falha >\/dev\/null 2>&1; exit 1; \}/, "ia: o motor imprime o lançamento; se ele morrer, solta o estado");
    assert.match(body, /trap ':' INT\n  eval "\$__sf_launch"/, "Ctrl+C não mata o sh; a IA roda nele");
    assert.match(body, /exec .* starfork "\$@"\n$/, "os outros subcomandos vão direto pro motor");
    assert.equal(git(t.worktree, "status", "--porcelain"), "", "shim e mensagem fora do git");
    assert.equal(JSON.parse(orch.store.getTask("sh")!.spec_json).termMode, "terminal");
    const W = withEnv({ HOME: f.home, SHELL: "/usr/bin/nao-existe", CARDUME_NOTIFY: "0" }, () => termPrep(orch, "sh"));
    assert.match(W.program, /^\/bin\/(zsh|bash)$/, "SHELL inválido → zsh/bash");
    assert.ok(!W.args[3].includes("--msg-file") && !W.args[3].includes("--resume"));
  } finally { orch.close(); f.done(); }
});

test("starfork ia-prep / _ia-exit: script de lançamento (env/unset/cd, chave fora do argv), cli rodando → '', IA ausente = mensagem de instalação", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("ia", { roles: [{ role: "builder", name: "Vega", engine: "claude", model: "sonnet" }] }));
    orch.close();
    const bins = join(f.root, "bins");
    const env = { CARDUME_AI_BIN_claude: fakeBin(bins, "claude"), CARDUME_AI_BIN_codex: fakeBin(bins, "codex"), CARDUME_AI_BIN_gemini: fakeBin(bins, "gemini"), CARDUME_AI_BIN_opencode: fakeBin(bins, "opencode") };
    mkdirSync(join(t.worktree, ".cardume", "term"), { recursive: true });
    writeFileSync(join(t.worktree, NEXT_MSG_REL), "mensagem do arquivo");
    const r = sf(f, "ia", ["ia-prep", "claude", "--modelo", "haiku", "--resume", "--msg-file", NEXT_MSG_REL], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Starfork: Claude Code · haiku/, "aviso curto no TTY (stderr), o script no stdout");
    const lines = r.out.trim().split("\n");
    assert.equal(lines[0], `cd '${t.worktree}' || exit 1`);
    assert.match(r.out, /^unset .*ANTHROPIC_API_KEY/m, "sem chave de API: quem paga é a assinatura");
    assert.match(r.out, /^export CARDUME_TASK='ia'$/m);
    // a linha da IA (o system prompt tem quebras de linha dentro das aspas): do binário até o `__sf_rc`
    const runOf = (out: string) => out.slice(out.indexOf(`\n'${env.CARDUME_AI_BIN_claude}'`) + 1, out.indexOf("\n__sf_rc"));
    const run = runOf(r.out);
    assert.ok(run.includes("'--model' 'haiku'") && run.includes("'--append-system-prompt'") && run.includes("'--mcp-config'"), run.slice(0, 200));
    assert.ok(run.endsWith("'mensagem do arquivo'"), "a mensagem vira o 1º pedido");
    assert.match(r.out, /__sf_rc=\$\?\n.* starfork _ia-exit claude >\/dev\/null 2>&1\nexit \$__sf_rc\n$/);
    assert.ok(!existsSync(join(t.worktree, NEXT_MSG_REL)), "arquivo da mensagem é de uso único");
    let s = new Store(f.db);
    try { assert.equal(s.termCli("ia"), "claude"); assert.equal(s.termGet("ia")!.busy, 1); } finally { s.close(); }
    assert.ok(existsSync(join(t.worktree, ".claude", "settings.local.json")), "hooks do Claude escritos pelo ia-prep");
    assert.equal(sf(f, "ia", ["_ia-exit", "claude"]).code, 0);
    s = new Store(f.db);
    try {
      assert.equal(s.termCli("ia"), "");
      assert.equal(s.termGet("ia")!.busy, 0);
      assert.equal(s.getTask("ia")!.status, "review", "saiu no meio de um turno: não fica rodando");
      assert.ok(s.eventsForTask("ia").some((e) => /Claude Code encerrado — o terminal segue no shell/.test(e.text)));
    } finally { s.close(); }
    // DeepSeek: chave SÓ no export, nunca na linha da IA
    writeFileSync(join(f.home, ".constellation", "llm.env"), "DEEPSEEK_API_KEY=sk-segredo-9\n");
    const d = sf(f, "ia", ["ia-prep", "deepseek"], env);
    assert.equal(d.code, 0, d.err);
    assert.match(d.out, /^export ANTHROPIC_AUTH_TOKEN='sk-segredo-9'$/m);
    assert.ok(runOf(d.out).startsWith(`'${env.CARDUME_AI_BIN_claude}'`) && !runOf(d.out).includes("sk-segredo-9"), "chave fora do argv");
    assert.ok(!/^unset .*ANTHROPIC_AUTH_TOKEN/m.test(d.out), "não tira a chave que acabou de pôr");
    // Codex: MCP + instruções como developer_instructions; AGENTS.md (não existia) com a seção, fora do git
    const c = sf(f, "ia", ["ia-prep", "codex"], env);
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /'developer_instructions="# Starfork — terminal integrado/);
    assert.match(c.out, /'mcp_servers\.cardume\.command=/);
    assert.ok(c.out.includes(`'projects={${JSON.stringify(t.worktree)}={"trust_level"="trusted"}`), "codex: pasta confiada só nesta sessão (-c)");
    assert.match(readFileSync(join(t.worktree, "AGENTS.md"), "utf8"), /<!-- starfork:inicio -->[\s\S]*starfork sugerir[\s\S]*<!-- starfork:fim -->/);
    // Gemini: MCP no settings de SISTEMA apontado no env (nada no .gemini do repo); GEMINI.md nosso
    const g = sf(f, "ia", ["ia-prep", "gemini"], { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: "" });
    assert.equal(g.code, 0, g.err);
    const gs = JSON.parse(readFileSync(join(t.worktree, ".cardume", "term", "gemini-settings.json"), "utf8"));
    assert.equal(gs.mcpServers.cardume.trust, true);
    assert.match(g.out, /^export GEMINI_CLI_SYSTEM_SETTINGS_PATH=/m);
    assert.match(g.out, /'--yolo'/);
    assert.match(g.out, /'--prompt-interactive' '/, "kickoff na 1ª mensagem (a versão instalada aceita)");
    assert.ok(!existsSync(join(t.worktree, ".gemini")), "o .gemini do repo não é tocado");
    assert.ok(existsSync(join(t.worktree, "GEMINI.md")));
    s = new Store(f.db);
    try { assert.equal(s.termGet("ia")!.busy, 0, "Gemini sem hooks: nunca nasce ocupado"); } finally { s.close(); }
    const g2 = sf(f, "ia", ["ia-prep", "gemini", "--resume"], env);
    assert.match(g2.out, /'--resume' 'latest'/, "já rodou aqui: retoma a última");
    // OpenCode: config PRÓPRIA no OPENCODE_CONFIG com MCP local (argv inteiro) + instruções
    const o = sf(f, "ia", ["ia-prep", "opencode", "--modelo", "anthropic/claude-sonnet-4"], env);
    assert.equal(o.code, 0, o.err);
    const oc = JSON.parse(readFileSync(join(t.worktree, ".cardume", "term", "opencode.json"), "utf8"));
    assert.equal(oc.mcp.cardume.type, "local");
    assert.ok(Array.isArray(oc.mcp.cardume.command) && oc.mcp.cardume.command.length >= 2);
    assert.match(oc.instructions[0], /AGENTS\.starfork\.md$/);
    assert.match(o.out, /'--model' 'anthropic\/claude-sonnet-4'/);
    assert.equal(git(t.worktree, "status", "--porcelain"), "", "nada do Starfork no diff da tarefa");
    // IA não instalada: mensagem com o comando de instalação, código 1, cli '' e a mensagem volta pro arquivo
    writeFileSync(join(t.worktree, NEXT_MSG_REL), "não pode sumir");
    const miss = sf(f, "ia", ["ia-prep", "opencode", "--msg-file", NEXT_MSG_REL], { ...env, CARDUME_AI_BIN_opencode: "", PATH: "/usr/bin:/bin", HOME: join(f.root, "vazio") });
    assert.equal(miss.code, 1);
    assert.match(miss.err, /OpenCode não está instalado[\s\S]*npm i -g opencode-ai/);
    assert.equal(miss.out, "", "nada pro sh executar");
    assert.equal(readFileSync(join(t.worktree, NEXT_MSG_REL), "utf8"), "não pode sumir");
    s = new Store(f.db);
    try { assert.equal(s.termCli("ia"), ""); } finally { s.close(); }
    assert.match(sf(f, "ia", ["ia-prep", "nada"]).err, /diga qual IA/);
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("starfork no shell: as MESMAS ferramentas do MCP (status, sugerir, etapa, requisito, entregavel, skills, tarefa, pr, mapa); erro = código 1", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("cmd", { requirements: ["r1"] }));
    orch.close();
    const st = sf(f, "cmd", ["status"]);
    assert.equal(st.code, 0, st.err);
    assert.match(st.out, /Tarefa: cmd[\s\S]*\[pendente\] r1[\s\S]*Falta para ENTREGUE/);
    assert.equal(sf(f, "cmd", ["sugerir", "pode seguir", "mostra o diff"]).code, 0);
    assert.equal(sf(f, "cmd", ["sugerir", "só uma"]).code, 1, "inválido → código 1");
    assert.match(sf(f, "cmd", ["requisito", "salvar", "rascunho"]).out, /requisito registrado \(2 na checklist\): salvar rascunho/);
    assert.equal(sf(f, "cmd", ["entregavel", "doc.md"]).code, 0);
    const e = sf(f, "cmd", ["etapa", "esperando", "--nota", "preciso da chave"]);
    assert.equal(e.code, 0, e.err);
    assert.match(e.out, /esperando você/);
    assert.match(sf(f, "cmd", ["etapa", "voando"]).err, /status inválido/);
    assert.match(sf(f, "cmd", ["skills"]).out, /Nenhuma skill/);
    const pr = sf(f, "cmd", ["pr"]);
    assert.equal(pr.code, 1);
    assert.match(pr.err, /PR NÃO aberto — o gate das provas reprovou/);
    const nt = sf(f, "cmd", ["tarefa", "Tela de login", "--requisito", "valida e-mail", "--requisito", "mostra erro"]);
    assert.equal(nt.code, 0, nt.err);
    assert.match(nt.out, /tarefa criada: tela-de-login/);
    assert.match(sf(f, "cmd", ["mapa", "--json", "{\"req\":\"r1\",\"code\":[{\"file\":\"README.md\",\"lines\":\"1\"}]}"]).out, /mapa registrado/);
    assert.equal(sf(f, "cmd", ["mapa", "--json", "{nao é json"]).code, 1);
    assert.match(sf(f, "cmd", ["ajuda"]).out, /starfork ia <claude\|codex\|deepseek\|gemini\|opencode>[\s\S]*starfork sugerir/);
    assert.equal(sf(f, "cmd", ["voar"]).code, 1);
    assert.equal(sf(f, "", ["status"]).code, 1, "fora do terminal de uma tarefa");
    const s = new Store(f.db);
    try {
      const ev = s.eventsForTask("cmd");
      assert.ok(ev.some((x) => x.type === "suggest" && x.text === JSON.stringify(["pode seguir", "mostra o diff"])), "chips do app");
      assert.equal(s.getTask("cmd")!.status, "needs-you");
      const sp = JSON.parse(s.getTask("cmd")!.spec_json) as TaskSpec;
      assert.deepEqual(sp.requirements, ["r1", "salvar rascunho"]);
      assert.ok(sp.deliverables.includes("doc.md"));
      assert.ok(s.getTask("tela-de-login"), "tarefa nova no mesmo projeto");
    } finally { s.close(); }
    assert.deepEqual(parseSf(["a", "--opcao", "x", "--opcao=y", "--rascunho", "b"]), { pos: ["a", "b"], flags: { opcao: ["x", "y"], rascunho: ["true"] } });
    assert.equal(etapaStatus("Revisão"), "review");
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("instruções em AGENTS.md/GEMINI.md: só arquivo novo ou só nosso; rastreado ou com texto da pessoa fica intocado", () => {
  const f = fixture();
  try {
    assert.equal(mergeSection(null, "A"), `${SECTION_BEGIN}\nA\n${SECTION_END}\n`);
    const mine = "# Meu\n\ntexto\n";
    const merged = mergeSection(mine, "A");
    assert.ok(merged.startsWith(mine) && merged.includes(`${SECTION_BEGIN}\nA\n${SECTION_END}`));
    assert.equal(mergeSection(merged, "B"), merged.replace("\nA\n", "\nB\n"), "troca só a nossa seção");
    assert.equal(writeInstructionsSection(f.repo, "AGENTS.md", "regras"), true, "não existia: escreve");
    assert.equal(writeInstructionsSection(f.repo, "AGENTS.md", "regras 2"), true, "só nosso: atualiza");
    assert.match(readFileSync(join(f.repo, "AGENTS.md"), "utf8"), /regras 2/);
    writeFileSync(join(f.repo, "GEMINI.md"), "da pessoa\n");
    assert.equal(writeInstructionsSection(f.repo, "GEMINI.md", "regras"), false, "texto da pessoa: não mexe");
    assert.equal(readFileSync(join(f.repo, "GEMINI.md"), "utf8"), "da pessoa\n");
    writeFileSync(join(f.repo, "CLAUDE.md"), mergeSection(null, "x"));
    git(f.repo, "add", "CLAUDE.md");
    git(f.repo, "commit", "-q", "-m", "c");
    assert.equal(writeInstructionsSection(f.repo, "CLAUDE.md", "y"), false, "rastreado: nunca");
    assert.match(shellInstructions(), /\.cardume\/TASK\.yaml[\s\S]*@\.cardume\/refs[\s\S]*starfork sugerir/);
  } finally { f.done(); }
});

test("script de lançamento: só nomes de env válidos, unset sem tirar o que exporta, IA com o TTY e _ia-exit no fim", () => {
  const L = { ai: "claude" as const, program: "/x/claude", args: ["--a", "it's"], env: { A: "1", "B-C": "x", ANTHROPIC_AUTH_TOKEN: "k" }, envRemove: ["CLAUDECODE", "ANTHROPIC_AUTH_TOKEN", "BAD NAME"], resumed: false, sessionId: null, cwd: "/w t", busy: true };
  assert.equal(launchScript(L, ["/n", "/c.mjs"]), "cd '/w t' || exit 1\nunset CLAUDECODE\nexport A='1'\nexport ANTHROPIC_AUTH_TOKEN='k'\n'/x/claude' '--a' 'it'\\''s'\n__sf_rc=$?\n'/n' '/c.mjs' starfork _ia-exit claude >/dev/null 2>&1\nexit $__sf_rc\n");
  assert.match(shimScript(["/n", "/c d.mjs"]), /'\/n' '\/c d\.mjs' starfork ia-prep "\$@"/);
});

/** `cli.ts <args>` (o motor, como o app chama) → última linha JSON. */
function cliJson(args: string[], env: Record<string, string> = {}, input?: string): any {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", input, env: { ...process.env, CARDUME_NOTIFY: "0", ...env } });
  const l = r.stdout.trim().split("\n").filter((x) => x.startsWith("{")).pop();
  return l ? JSON.parse(l) : { stdout: r.stdout, stderr: r.stderr };
}

test("term-ai (CLI): grava termAi/termModel, modelo vazio apaga, recomendado segue; term-msg devolve a worktree", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("st", { roles: [{ role: "builder", name: "Vega", engine: "claude", model: "sonnet" }] }));
    orch.close();
    const sp = () => { const s = new Store(f.db); try { return JSON.parse(s.getTask("st")!.spec_json) as TaskSpec; } finally { s.close(); } };
    const a = cliJson(["term-ai", "st", "--ai", "gemini", "--model", "gemini-2.5-flash", "--repo", f.repo], { HOME: f.home });
    assert.deepEqual(a.recommended, { ai: "gemini", model: "gemini-2.5-flash", command: "starfork ia gemini --modelo gemini-2.5-flash" });
    assert.equal(sp().termAi, "gemini");
    assert.equal(sp().termModel, "gemini-2.5-flash");
    const b = cliJson(["term-ai", "st", "--ai", "claude", "--repo", f.repo], { HOME: f.home });
    assert.equal(sp().termModel, undefined, "sem --model: apaga o modelo escolhido antes");
    assert.deepEqual(b.recommended, recommendedLaunch(sp()), "o recomendado do CLI = recommendedLaunch do spec gravado");
    assert.equal(b.recommended.command, "starfork ia claude --modelo sonnet", "voltou pra IA da tarefa: o modelo do papel");
    assert.match(String(cliJson(["term-ai", "st", "--ai", "nada", "--repo", f.repo], { HOME: f.home }).error), /IA desconhecida/);
    const m = cliJson(["term-msg", "st", "--kind", "talk", "--msg", "oi", "--repo", f.repo], { HOME: f.home });
    assert.deepEqual(m, { text: "oi", worktree: t.worktree });
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("statusline com STARFORK_ENGINE=deepseek: não grava custo (seria preço de Claude)", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("ds"));
    orch.close();
    const j = JSON.stringify({ session_id: "sess-ds-1", cost: { total_cost_usd: 1.25 }, model: { id: "deepseek-v4-pro", display_name: "DeepSeek" } });
    const run = (extra: Record<string, string>) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "statusline", "--starfork-task", "ds", "--repo", f.repo], { encoding: "utf8", input: j, env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.cfg, CARDUME_DB: f.db, ...extra } });
    const cost = () => { const s = new Store(f.db); try { return (s.db.prepare("SELECT COUNT(*) AS n FROM cost WHERE task_id='ds'").get() as { n: number }).n; } finally { s.close(); } };
    assert.match(run({ STARFORK_ENGINE: "deepseek" }).stdout, /US\$ 0\.00/);
    assert.equal(cost(), 0, "DeepSeek: nenhuma linha de custo");
    run({ STARFORK_ENGINE: "" });
    assert.equal(cost(), 1, "Claude: grava (prova que o caminho é o mesmo)");
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("--msg-file fora de .cardume/term/next-msg.txt é recusado (o arquivo seria APAGADO)", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("mf"));
    orch.close();
    const env = { CARDUME_AI_BIN_claude: fakeBin(join(f.root, "bins"), "claude") };
    writeFileSync(join(t.worktree, "importante.txt"), "não apague");
    const r = sf(f, "mf", ["ia-prep", "claude", "--msg-file", "importante.txt"], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /--msg-file só aceita \.cardume\/term\/next-msg\.txt/);
    assert.equal(readFileSync(join(t.worktree, "importante.txt"), "utf8"), "não apague");
    assert.equal(sf(f, "mf", ["ia-prep", "claude", "--msg-file", "../../../../README.md"], env).code, 1);
    assert.ok(existsSync(join(f.repo, "README.md")));
    const s = new Store(f.db);
    try { assert.equal(s.termCli("mf"), ""); assert.equal(s.termGet("mf")?.busy ?? 0, 0, "recusa solta cli/ocupado"); } finally { s.close(); }
    assert.equal(sf(f, "mf", ["ia-prep", "claude", "--msg-file", join(t.worktree, NEXT_MSG_REL)], env).code, 0, "o caminho absoluto do arquivo certo vale");
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("openPr: rascunho com gh falso (--draft, prUrl/prNumber gravados, solto commitado); PR aberto = só push; gh sem URL = erro", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const origin = join(f.root, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  git(f.repo, "remote", "add", "origin", origin);
  git(f.repo, "push", "-q", "origin", "main");
  const argvFile = join(f.root, "gh-argv.txt");
  const gh = join(f.root, "gh-falso.sh");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n[ -n "$GH_SEM_URL" ] && { echo "criado"; exit 0; }\necho "https://github.com/o/r/pull/77"\n`);
  chmodSync(gh, 0o755);
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("pr", { requirements: ["r1"], prBase: "main" }));
    writeFileSync(join(t.worktree, "solto.txt"), "x\n");
    const r = await withEnvAsync({ CARDUME_GH: gh, GH_SEM_URL: undefined }, () => orch.openPr("pr", { draft: true, title: "Meu PR" }));
    assert.deepEqual(r, { ok: true, url: "https://github.com/o/r/pull/77" });
    const argv = readFileSync(argvFile, "utf8").split("\n");
    assert.ok(argv.includes("--draft") && argv.includes("Meu PR"), argv.join(" "));
    const sp = JSON.parse(orch.store.getTask("pr")!.spec_json) as TaskSpec;
    assert.equal(sp.prUrl, "https://github.com/o/r/pull/77");
    assert.equal(sp.prNumber, 77);
    assert.equal(git(t.worktree, "status", "--porcelain", "--", "solto.txt"), "", "arquivo solto commitado");
    assert.ok(git(origin, "log", "--oneline", t.branch).length > 0, "branch no remoto");
    // PR já aberto: "atualizar" = commit + push, sem gate (r1 sem prova) e sem gh
    rmSync(argvFile);
    writeFileSync(join(t.worktree, "mais.txt"), "y\n");
    const u = await withEnvAsync({ CARDUME_GH: gh }, () => orch.openPr("pr"));
    assert.deepEqual(u, { ok: true, url: "https://github.com/o/r/pull/77" });
    assert.ok(!existsSync(argvFile), "não chamou o gh");
    assert.equal(git(origin, "rev-parse", t.branch), git(t.worktree, "rev-parse", "HEAD"), "push com o novo commit");
    // gh sem URL
    orch.store.patchSpec("pr", { prUrl: undefined, prNumber: undefined });
    const n = await withEnvAsync({ CARDUME_GH: gh, GH_SEM_URL: "1" }, () => orch.openPr("pr", { draft: true }));
    assert.equal(n.ok, false);
    assert.match(String(n.error), /gh não devolveu a URL do PR/);
  } finally { orch.close(); f.done(); }
});
async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("integrada no terminal: bloco 'modo conversa' nas instruções (Claude e shell), sem kickoff, sem mudar o status", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("feita", { prUrl: "https://github.com/o/r/pull/5" }));
    orch.store.setStatus("feita", "merged");
    orch.close();
    const env = { CARDUME_AI_BIN_claude: fakeBin(join(f.root, "bins"), "claude"), CARDUME_AI_BIN_codex: fakeBin(join(f.root, "bins"), "codex") };
    const r = sf(f, "feita", ["ia-prep", "claude"], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Esta tarefa JÁ FOI INTEGRADA \(PR https:\/\/github\.com\/o\/r\/pull\/5\)[\s\S]*NÃO altere código aqui[\s\S]*starfork tarefa "Ajuste: …"/);
    assert.ok(!r.out.includes("Comece: leia .cardume/TASK.yaml"), "sem kickoff de construir");
    const c = sf(f, "feita", ["ia-prep", "codex"], env);
    assert.match(c.out, /developer_instructions=.*JÁ FOI INTEGRADA/);
    const s = new Store(f.db);
    try {
      assert.equal(s.getTask("feita")!.status, "merged");
      assert.equal(s.termGet("feita")!.busy, 0, "sem kickoff: nasce livre");
    } finally { s.close(); }
    assert.match(mergedRule("u"), /JÁ FOI INTEGRADA \(PR u\)/);
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("confiança da pasta: ~/.claude.json ganha só a nossa worktree (atômico, preserva o resto, não cria); codex -c projects", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-trust-")));
  try {
    const cfg = join(root, "cfg"), repo = join(root, "repo"), wt = join(repo, ".cardume", "worktrees", "t1");
    mkdirSync(cfg, { recursive: true }); mkdirSync(wt, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: cfg };
    assert.equal(claudeJsonPath(env), join(cfg, ".claude.json"));
    assert.equal(claudeJsonPath({ HOME: "/h" }), "/h/.claude.json");
    assert.equal(trustClaudeProject(wt, repo, env), false, "sem arquivo: não cria");
    assert.ok(!existsSync(join(cfg, ".claude.json")));
    const orig = { numStartups: 9, projects: { "/outro": { hasTrustDialogAccepted: false, allowedTools: ["x"] }, [wt]: { mcpServers: { a: 1 } } } };
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify(orig));
    assert.equal(trustClaudeProject(join(root, "fora"), repo, env), false, "pasta fora de .cardume/worktrees: nunca");
    assert.equal(trustClaudeProject(wt, repo, env), true);
    const after = JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8"));
    assert.equal(after.numStartups, 9);
    assert.deepEqual(after.projects["/outro"], orig.projects["/outro"], "o resto intocado");
    assert.deepEqual(after.projects[wt], { mcpServers: { a: 1 }, hasTrustDialogAccepted: true });
    assert.equal(trustClaudeProject(wt, repo, env), false, "já confiada: não regrava");
    writeFileSync(join(cfg, ".claude.json"), "{quebrado");
    assert.equal(trustClaudeProject(wt, repo, env), false, "ilegível: segue sem quebrar");
    assert.equal(readFileSync(join(cfg, ".claude.json"), "utf8"), "{quebrado");
    assert.equal(codexTrustArg(wt, repo), `projects={${JSON.stringify(wt)}={"trust_level"="trusted"},${JSON.stringify(repo)}={"trust_level"="trusted"}}`);
    assert.deepEqual(geminiSettings(null, {}).security, { folderTrust: { enabled: false } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chips de reserva: só quando a fala TERMINA com opções claras; nada se o agente já sugeriu", () => {
  assert.deepEqual(suggestFromText("Feito.\n\nPróximos passos:\n1. Rodar os testes\n2. **Abrir o PR**\n3. Revisar o diff"), ["Rodar os testes", "Abrir o PR", "Revisar o diff"]);
  assert.deepEqual(suggestFromText("Posso:\n- ajustar o layout\n- manter assim\n\nO que prefere?"), ["ajustar o layout", "manter assim"], "pergunta curta depois da lista vale");
  assert.deepEqual(suggestFromText("Pronto, corrigi o bug. Prefere manter assim ou ajustar o layout?"), ["manter assim", "ajustar o layout"]);
  assert.deepEqual(suggestFromText("Quer que eu abra o PR ou rode os testes antes?"), ["abra o PR", "rode os testes antes"]);
  assert.equal(suggestFromText("Corrigi o bug e rodei os testes."), null, "sem opções: nada");
  assert.equal(suggestFromText("1. só um item"), null);
  assert.equal(suggestFromText("- a\n- b\n- c\n- d\n- e"), null, "mais de 4");
  assert.equal(suggestFromText(`- ${"x".repeat(61)}\n- curto`), null, "item longo");
  assert.equal(suggestFromText("Lista:\n- a1\n- b1\n\nDepois eu sigo com o resto."), null, "lista no meio, não no fim");
  assert.equal(suggestFromText("Isso é A, B ou C?"), null, "não é A ou B");
  assert.equal(suggestFromText(""), null);
  const ev = (agent: string, type: string, text: string) => ({ agent, type, text });
  assert.equal(suggestedSinceUser([ev("Você", "note", "Você: oi"), ev("Vega", "suggest", "[]")]), true);
  assert.equal(suggestedSinceUser([ev("Vega", "suggest", "[]"), ev("Você", "note", "Você: oi"), ev("Vega", "done", "x")]), false);
  assert.equal(suggestedSinceUser([]), false);
});

test("hook Stop: fala com opções e sem suggest_replies → evento suggest; com suggest do agente → nada a mais", async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    await orch.createTask(spec("ch"));
    orch.close();
    const stop = (msg: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "hook", "Stop", "--starfork-task", "ch", "--repo", f.repo], { encoding: "utf8", input: JSON.stringify({ last_assistant_message: msg }), env: { ...process.env, HOME: f.home, CARDUME_NOTIFY: "0", CARDUME_DB: f.db } });
    const sug = () => { const s = new Store(f.db); try { return s.eventsForTask("ch").filter((e) => e.type === "suggest").map((e) => e.text); } finally { s.close(); } };
    const you = (t: string) => { const s = new Store(f.db); try { s.addEvent("ch", "Você", "note", `Você: ${t}`, true); } finally { s.close(); } };
    you("o que foi feito?");
    stop("Fiz X.\n1. Ver o diff\n2. Abrir o PR");
    assert.deepEqual(sug(), [JSON.stringify(["Ver o diff", "Abrir o PR"])]);
    you("e agora?");
    stop("Só isso, sem opções.");
    assert.equal(sug().length, 1, "sem opções: nada");
    you("ok");
    assert.equal(sf(f, "ch", ["sugerir", "pode seguir", "mostra o diff"]).code, 0);
    stop("Feito.\n- a1\n- b1");
    assert.equal(sug().length, 2, "o agente já sugeriu: sem reserva");
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("retomada QUIETA (abrir a tarefa = terminal vivo): --quieto no shell, sem kickoff/1ª mensagem, status e feed intocados, nasce livre; mensagem desliga o quieto", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const orch = new Orchestrator(f.repo);
  try {
    const t = await orch.createTask(spec("q", { roles: [{ role: "builder", name: "Vega", engine: "claude", model: "sonnet" }] }));
    orch.store.setStatus("q", "review");
    const evs0 = orch.store.eventsForTask("q").length;
    const L = withEnv({ HOME: f.home, SHELL: "/bin/bash", CARDUME_NOTIFY: "0" }, () => termPrep(orch, "q", { resume: true, quiet: true }));
    assert.equal(L.args[3], `'${join(t.worktree, TERM_BIN_REL, "starfork")}' ia claude --modelo sonnet --resume --quieto; '/bin/bash' -l -i; :`);
    assert.equal(L.busy, false, "quieto: nasce livre (nada foi pedido)");
    assert.equal(orch.store.eventsForTask("q").length, evs0, "sem nota de 'abrindo o terminal' a cada visita");
    assert.equal(orch.store.getTask("q")!.status, "review", "abrir pra olhar não muda o status");
    // mensagem = pedido explícito: o quieto não vale (vai pelos portões de sempre)
    const M = withEnv({ HOME: f.home, SHELL: "/bin/bash", CARDUME_NOTIFY: "0" }, () => termPrep(orch, "q", { resume: true, quiet: true, message: "faz X" }));
    assert.ok(!M.args[3].includes("--quieto") && M.args[3].includes("--msg-file") && M.busy, M.args[3]);
    // direto (Windows / motor antigo): a IA sem kickoff
    const D = withEnv({ HOME: f.home, CARDUME_NOTIFY: "0", CARDUME_AI_BIN_claude: fakeBin(join(f.root, "bins"), "claude") }, () => termPrep(orch, "q", { resume: true, quiet: true, direct: true }));
    assert.ok(!D.args.some((a) => /Comece: leia \.cardume\/TASK\.yaml/.test(a)), "direto: sem kickoff");
    assert.equal(D.busy, false);
    orch.store.setStatus("q", "review");
    orch.close();
    // ia-prep --quieto (o shim): sem kickoff, sem status, livre
    const bins = join(f.root, "bins");
    const env = { CARDUME_AI_BIN_claude: fakeBin(bins, "claude"), CARDUME_AI_BIN_codex: fakeBin(bins, "codex") };
    const r = sf(f, "q", ["ia-prep", "claude", "--resume", "--quieto"], env);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes("Comece: leia .cardume/TASK.yaml"), "quieto: nada de kickoff (não gasta até a pessoa mandar)");
    const c = sf(f, "q", ["ia-prep", "codex", "--resume", "--quieto"], env);
    assert.equal(c.code, 0, c.err);
    assert.ok(!/Neste terminal você TEM as ferramentas do Starfork/.test(c.out), "codex quieto: sem 1ª mensagem");
    const s = new Store(f.db);
    try {
      assert.equal(s.getTask("q")!.status, "review", "status intocado");
      assert.equal(s.termGet("q")!.busy, 0);
      assert.ok(!s.eventsForTask("q").some((e) => /abrindo o terminal \((claude|codex)\)/.test(e.text)), "sem nota de abertura");
    } finally { s.close(); }
    // sem --quieto, o mesmo caminho continua com o kickoff (nada mudou pra quem pede)
    const k = sf(f, "q", ["ia-prep", "claude"], env);
    assert.ok(k.out.includes("Comece: leia .cardume/TASK.yaml"));
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});
