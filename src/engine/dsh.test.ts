// node --test src/engine/dsh.test.ts  (npm test)
// Motor DeepSeek Harness (beta): eventos do `dsh --profile headless --json` (fixtures capturadas do dsh 0.2.0-rc.2),
// patch do Starfork, argv/env, ciclo de vida com um dsh FALSO e — se o dsh estiver instalado — o dsh REAL
// apontado pra um servidor OpenAI-compatível FALSO local (edita arquivo, pergunta ao humano via MCP, retoma sessão).
// HOME e DSH_HOME temporários: nunca toca ~/.dsh nem ~/.constellation de verdade, nunca chama a DeepSeek.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  basePatchYaml, buildDshPrompt, DSH_CAPABLE_MODEL, DSH_KEY_MSG, DSH_MISSING_MSG, dshArgs, dshEnv, dshErrText, dshNodeOk,
  DshEngine, dshModelFor, dshVersionCmp, dshVersionOk, mapDshLine, newDshState, nodeToolBin, resolveDsh, runPatchYaml, writeBasePatch,
} from "./dsh.ts";
import { statSync } from "node:fs";
import { engineKind } from "../orchestrator.ts";
import { binExists } from "../ai-once.ts";
import { Store } from "../store.ts";
import type { AgentEvent, RunInput } from "./types.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : false };
// DshEngine.run/dshRun checam o node (^22.19 ou ≥24) ANTES de rodar o dsh falso: em node mais velho, pula
const POSIX_NODE = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : !dshNodeOk() ? `node ${process.versions.node} < 22.19 (o dsh não roda)` : false };
const goldenDir = new URL("../../tests/fixtures/ai-once-golden/", import.meta.url);

// saída REAL do dsh 0.2.0-rc.2 (headless --json) numa tarefa que cria um arquivo
const REAL_RUN = [
  { type: "session", sessionId: "session-7985", cwd: "/tmp/wt" },
  { type: "status", phase: "turn_start", turn: 1 },
  { type: "status", phase: "step_start", turn: 1, step: 1 },
  { type: "thinking", text: "vou criar o arquivo" },
  { type: "tool_call", callId: "call_1", tool: "write", input: { file_path: "hello.txt", content: "oi\n" } },
  { type: "tool_result", callId: "call_1", status: "completed", result: "<path>/tmp/wt/hello.txt</path>\nCreated file" },
  { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "status", phase: "step_start", turn: 1, step: 2 },
  { type: "text", text: "pronto" },
  { type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } },
  { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
  { type: "final", text: "pronto" },
].map((o) => JSON.stringify(o));

const sessionMissing = (t: string) => /no conversation found|session (id )?.{0,60}not found|could not find session/i.test(t); // = Orchestrator.sessionMissing

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

function sandbox(llmEnv = "DEEPSEEK_API_KEY=sk-ds-teste\nLGCX_API_KEY=lgcx-segredo\n") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-dsh-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".constellation"), { recursive: true });
  writeFileSync(join(home, ".constellation", "llm.env"), llmEnv);
  writeFileSync(join(home, ".constellation", "settings.json"), "{}");
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".cardume"), { recursive: true });
  const input: RunInput = {
    cwd: wt,
    spec: { id: "t-ds", title: "t", objective: "crie hello.txt", deliverables: [], requirements: [], scope: { owns: [], offLimits: [] } } as never,
    systemContext: "CTX-BARRAMENTO", role: "builder", agentName: "Onda", dbFile: join(root, "state.sqlite"),
  };
  return { root, home, wt, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function collect(engine: DshEngine, input: RunInput): Promise<AgentEvent[]> {
  const evs: AgentEvent[] = [];
  for await (const ev of engine.run(input)) evs.push(ev);
  return evs;
}

test("eventos do headless → think/write/note/done com tokens somados; sessão capturada", () => {
  const st = newDshState();
  const evs = REAL_RUN.flatMap((l) => mapDshLine(l, st));
  assert.deepEqual(evs.map((e) => e.type), ["session", "think", "write", "note", "done"]);
  assert.equal(evs[0].text, "session-7985");
  assert.equal(evs[2].text, "hello.txt");
  const done = evs.at(-1)!;
  assert.equal(done.status, "review");
  assert.deepEqual(done.cost, { usd: 0, inTok: 30, outTok: 7 });
  // bash, ask_human e claim do MCP do Starfork viram os mesmos eventos do Claude
  assert.deepEqual(mapDshLine(JSON.stringify({ type: "tool_call", tool: "bash", input: { command: "npm test" } })).map((e) => [e.type, e.text]), [["bash", "npm test"]]);
  assert.match(mapDshLine(JSON.stringify({ type: "tool_call", tool: "mcp__cardume__ask_human", input: { question: "qual cor?" } }))[0].text, /perguntou ao humano: qual cor\?/);
  assert.equal(mapDshLine(JSON.stringify({ type: "tool_call", tool: "mcp__cardume__claim", input: { path: "src/a.ts", mode: "write" } }))[0].type, "claim");
  assert.deepEqual(mapDshLine("lixo não-json").map((e) => e.type), ["note"]);
});

test("turno que falha: erro com o motivo e SEM done (o final vazio não vira 'concluído')", () => {
  const st = newDshState();
  const evs = [
    { type: "session", sessionId: "s1" },
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { code: "RATE_LIMITED", message: "429 Too Many Requests" } } },
    { type: "final", text: "" },
  ].flatMap((o) => mapDshLine(JSON.stringify(o), st));
  assert.deepEqual(evs.map((e) => e.type), ["session", "error"]);
  assert.match(evs[1].text, /RATE_LIMITED: 429/);
  // max-tokens cai na regra de "estourou tokens" do orquestrador (retoma sozinho)
  assert.match(mapDshLine(JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "max-tokens" } }))[0].text, /token limit/);
  assert.match(mapDshLine(JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "aborted" } }))[0].text, /aborted/);
});

test("--session-id desconhecido → texto que o orquestrador trata como sessão perdida (turno novo + aviso)", () => {
  const real = 'session "session-x" does not exist; omit --session-id to start a new Session';
  const ev = mapDshLine(JSON.stringify({ type: "error", message: real }))[0];
  assert.equal(ev.type, "error");
  assert.ok(sessionMissing(ev.text), ev.text);
  assert.ok(sessionMissing(dshErrText('session "s" was recorded in "/a", not "/b"')));
  assert.match(dshErrText("MISSING_CREDENTIAL: no key"), /Conta → Chaves de modelo/);
});

test("golden: patch fixo e patch de modelo idênticos aos do Rust (mesma ordem de chaves)", () => {
  const g = JSON.parse(readFileSync(new URL("dsh-patch.json", goldenDir), "utf8"));
  assert.equal(basePatchYaml(), g.base);
  assert.equal(runPatchYaml({ model: g.model }), g.modelPatch);
});

test("patch fixo: grava só se mudou, rename atômico, 0600 (um dsh em paralelo nunca lê vazio)", POSIX, async () => {
  const S = sandbox();
  try {
    await withEnv({ HOME: S.home, USERPROFILE: S.home }, async () => {
      const p = writeBasePatch();
      assert.equal(readFileSync(p, "utf8"), basePatchYaml());
      assert.equal(statSync(p).mode & 0o777, 0o600);
      const ino = statSync(p).ino;
      writeBasePatch();
      assert.equal(statSync(p).ino, ino, "conteúdo igual → não reescreve");
      writeFileSync(p, "", { mode: 0o644 });
      writeBasePatch();
      assert.equal(readFileSync(p, "utf8"), basePatchYaml());
      assert.notEqual(statSync(p).ino, ino, "conteúdo diferente → arquivo novo via rename");
      assert.equal(statSync(p).mode & 0o777, 0o600);
    });
  } finally { S.cleanup(); }
});

test("busca do dsh = a do Rust: CARDUME_NODE e pastas do nvm (mais novo primeiro)", POSIX, async () => {
  const S = sandbox();
  try {
    const mk = (d: string) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "dsh"), "#!/bin/sh\n"); return join(d, "dsh"); };
    const old = mk(join(S.home, ".nvm/versions/node/v22.19.0/bin"));
    const nov = mk(join(S.home, ".nvm/versions/node/v24.1.0/bin"));
    writeFileSync(join(dirname(old), "node"), ""); writeFileSync(join(dirname(nov), "node"), "");
    const fromNvm = await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH: undefined, CARDUME_NODE: undefined }, async () => nodeToolBin("CARDUME_DSH", "dsh"));
    // ao lado do node que roda o teste pode existir um dsh real — ele vem antes (é o node escolhido)
    if (!existsSync(join(dirname(process.execPath), "dsh"))) assert.equal(fromNvm, nov);
    const forced = mk(join(S.root, "meunode"));
    writeFileSync(join(S.root, "meunode", "node"), "");
    assert.equal(await withEnv({ HOME: S.home, CARDUME_DSH: undefined, CARDUME_NODE: join(S.root, "meunode", "node") }, async () => nodeToolBin("CARDUME_DSH", "dsh")), forced);
  } finally { S.cleanup(); }
});

test("patch do Starfork: upload de logs e OTel desligados; modelo + MCP stdio em JSON (sem !!js)", () => {
  const b = basePatchYaml();
  assert.match(b, /- id: session-log-deepseek\n {2}config:\n {4}enabled: false/);
  assert.match(b, /- id: session-telemetry-otel\n {2}disabled: true/);
  const r = runPatchYaml({ model: "deepseek-flash", mcp: { command: "/n/node", args: ["/x y/server.ts"], env: { CARDUME_DB: '/a"b', CARDUME_TASK: "t1" }, cwd: "/wt" } });
  assert.match(r, /- id: agent-default-model\n {2}config: \{"provider":"deepseek-official","model":"deepseek-flash"\}/);
  assert.match(r, /name: '@deepseek-ai\/dsh-mcp-client'/);
  const cfg = JSON.parse(r.split("\n").find((l) => l.includes('"serverName"'))!.replace(/^\s*config: /, ""));
  assert.equal(cfg.serverName, "cardume");
  assert.equal(cfg.transport, "stdio");
  assert.equal(cfg.env.CARDUME_DB, '/a"b');
  assert.ok(cfg.toolCallTimeoutMs >= 3600_000, "ask_human espera o humano — 60s padrão cortaria a pergunta");
  assert.ok(!r.includes("!!js") && !b.includes("!!js"));
  assert.ok(!runPatchYaml({ model: "m" }).includes("mcp-client"), "auxiliar: sem MCP");
});

test("argv/env: prompt fora do argv, chave só no env, só a chave da DeepSeek, node escolhido na frente do PATH", () => {
  assert.deepEqual(dshArgs(["/a.yml", "/b.yml"]), ["--patch", "/a.yml", "--patch", "/b.yml", "--profile", "headless", "--json"]);
  assert.deepEqual(dshArgs(["/a.yml"], "session-1").slice(-2), ["--session-id", "session-1"]);
  const env = dshEnv("/opt/x/bin/dsh", "sk-ds", "read-only", {
    PATH: `/usr/bin${delimiter}${dirname(process.execPath)}`, LGCX_API_KEY: "herdada", OPENAI_API_KEY: "o",
    ANTHROPIC_API_KEY: "a", GH_TOKEN: "g", AWS_SECRET: "s", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", DEEPSEEK_API_KEY: "herdada-ds", HOME_DIR: "fica",
  }, { LGCX_API_KEY: "l" });
  assert.equal(env.DEEPSEEK_API_KEY, "sk-ds", "a da conta vence a herdada");
  for (const k of ["LGCX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "AWS_SECRET", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) assert.equal(env[k], undefined, `${k} herdada não chega no agente`);
  assert.equal(env.HOME_DIR, "fica");
  assert.equal(env.DSH_PERMISSION_MODE, "read-only");
  assert.equal(env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(env.PATH!.split(delimiter)[0], dirname(process.execPath));
  assert.ok(env.DSH_HOME && !env.DSH_HOME.endsWith("/.dsh"), "nunca o ~/.dsh do usuário");
  assert.equal(dshNodeOk("22.19.0"), true);
  assert.equal(dshNodeOk("v22.18.1"), false);
  assert.equal(dshNodeOk("23.4.0"), false);
  assert.equal(dshNodeOk("24.0.0"), true);
  assert.equal(engineKind("deepseek"), "deepseek");
  assert.equal(engineKind("DeepSeek · deepseek-flash"), "deepseek");
  assert.equal(engineKind("dsh"), "deepseek");
  assert.equal(engineKind("dsh-flash"), "deepseek");
  assert.equal(engineKind("dshx"), "claude");
  // alias do Claude (o #ntModel oferece opus/sonnet/haiku) nunca vai pro deepseek-official
  assert.equal(dshModelFor("sonnet", "capaz"), DSH_CAPABLE_MODEL);
  assert.equal(dshModelFor("claude-opus-5-5", "rapido"), "deepseek-flash");
  assert.equal(dshModelFor("", "capaz"), DSH_CAPABLE_MODEL);
  assert.equal(dshModelFor("deepseek-flash", "capaz"), "deepseek-flash");
  // faixa suportada (ids dos patches vêm do 0.2.0-rc.2)
  assert.ok(dshVersionOk("0.2.0-rc.2") && dshVersionOk("0.2.0") && dshVersionOk("0.2.0-rc.10") && dshVersionOk("1.0.0"));
  assert.ok(!dshVersionOk("0.2.0-rc.1") && !dshVersionOk("0.1.9") && !dshVersionOk("0.2.0-beta.5"));
  assert.ok(dshVersionCmp("lixo", "0.2.0") === 0, "versão ilegível não bloqueia");
  assert.equal(engineKind("codex"), "codex", "os outros motores não mudam");
  const p = buildDshPrompt({ cwd: "/w", spec: { requirements: ["R1"] } as never, systemContext: "CTX", role: "builder", agentName: "a", dbFile: "" });
  assert.match(p, /mcp__cardume__ask_human/);
  assert.match(p, /CTX/);
});

/** dsh FALSO: grava argv, stdin, env e cwd; responde o JSONL real (ou o que mandarem). */
function fakeDsh(dir: string, body = REAL_RUN.join("\n"), exit = 0): string {
  const f = join(dir, "dsh");
  writeFileSync(f, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/argv.txt"
cat > "${dir}/stdin.txt"
echo "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" > "${dir}/env.txt"
echo "LGCX_API_KEY=$LGCX_API_KEY" >> "${dir}/env.txt"
echo "DSH_PERMISSION_MODE=$DSH_PERMISSION_MODE" >> "${dir}/env.txt"
pwd > "${dir}/cwd.txt"
cat <<'EOF'
${body}
EOF
exit ${exit}
`);
  chmodSync(f, 0o755);
  return f;
}

test("tarefa com dsh falso: patch na worktree, danger-full-access, prompt no stdin, eventos e tokens; resume por --session-id", POSIX_NODE, async () => {
  const S = sandbox();
  try {
    const bin = fakeDsh(S.root);
    const evs = await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome"), LGCX_API_KEY: "herdada" }, () => collect(new DshEngine({ bin }), S.input));
    assert.deepEqual(evs.map((e) => e.type), ["status", "session", "think", "write", "note", "done"]);
    assert.match(evs[0].text, new RegExp(DSH_CAPABLE_MODEL), "sem modelo escolhido → o capaz");
    assert.deepEqual({ ...evs.at(-1)!.cost, ms: 0 }, { usd: 0, inTok: 30, outTok: 7, ms: 0 });
    const argv = readFileSync(join(S.root, "argv.txt"), "utf8").trim().split("\n");
    assert.deepEqual(argv, ["--patch", join(S.home, ".constellation", "dsh", "starfork.patch.yml"), "--patch", join(S.wt, ".cardume", "dsh.patch.yml"), "--profile", "headless", "--json"]);
    assert.ok(!argv.join(" ").includes("sk-ds-teste"), "chave nunca no argv");
    const stdin = readFileSync(join(S.root, "stdin.txt"), "utf8");
    assert.match(stdin, /Leia \.cardume\/TASK\.yaml/);
    assert.match(stdin, /CTX-BARRAMENTO/);
    const env = readFileSync(join(S.root, "env.txt"), "utf8");
    assert.match(env, /DEEPSEEK_API_KEY=sk-ds-teste\nLGCX_API_KEY=\nDSH_PERMISSION_MODE=danger-full-access/);
    assert.equal(realpathSync(readFileSync(join(S.root, "cwd.txt"), "utf8").trim()), realpathSync(S.wt));
    const patch = readFileSync(join(S.wt, ".cardume", "dsh.patch.yml"), "utf8");
    assert.match(patch, /"CARDUME_TASK":"t-ds"/);
    assert.match(patch, /"model":"deepseek-v4-pro"/);
    assert.match(readFileSync(join(S.home, ".constellation", "dsh", "starfork.patch.yml"), "utf8"), /enabled: false/);

    // chat da tarefa: retoma a MESMA sessão
    await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") }, () =>
      collect(new DshEngine({ bin, model: "deepseek-flash" }), { ...S.input, resume: { sessionId: "session-7985", instruction: "agora mude a cor" } }));
    await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") }, () => collect(new DshEngine({ bin, model: "sonnet" }), S.input));
    assert.match(readFileSync(join(S.wt, ".cardume", "dsh.patch.yml"), "utf8"), /"model":"deepseek-v4-pro"/, "alias do Claude → modelo capaz do DeepSeek");
    // de volta pro flash pra conferência abaixo
    await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") }, () =>
      collect(new DshEngine({ bin, model: "deepseek-flash" }), { ...S.input, resume: { sessionId: "session-7985", instruction: "agora mude a cor" } }));
    const argv2 = readFileSync(join(S.root, "argv.txt"), "utf8").trim().split("\n");
    assert.deepEqual(argv2.slice(-2), ["--session-id", "session-7985"]);
    assert.match(readFileSync(join(S.root, "stdin.txt"), "utf8"), /^agora mude a cor/);
    assert.match(readFileSync(join(S.wt, ".cardume", "dsh.patch.yml"), "utf8"), /"model":"deepseek-flash"/);
  } finally { S.cleanup(); }
});

test("dsh saiu com erro (sessão desconhecida): erro humano, sem done", POSIX_NODE, async () => {
  const S = sandbox();
  try {
    const bin = fakeDsh(S.root, JSON.stringify({ type: "error", message: 'session "s-old" does not exist; omit --session-id to start a new Session' }), 1);
    const evs = await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") }, () =>
      collect(new DshEngine({ bin }), { ...S.input, resume: { sessionId: "s-old", instruction: "oi" } }));
    const errs = evs.filter((e) => e.type === "error");
    assert.equal(errs.length, 1, JSON.stringify(evs));
    assert.ok(sessionMissing(errs[0].text));
    assert.ok(!evs.some((e) => e.type === "done"));
  } finally { S.cleanup(); }
});

test("sem dsh / sem chave → mensagens humanas (instalar / Conta → Chaves de modelo)", POSIX_NODE, async () => {
  const S = sandbox();
  try {
    const missing = await withEnv({ HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") }, () => collect(new DshEngine({ bin: join(S.root, "nao-existe", "dsh") }), S.input));
    assert.equal(missing.at(-1)!.text, DSH_MISSING_MSG);
    assert.match(DSH_MISSING_MSG, /npm i -g @deepseek-ai\/dsh/);
    writeFileSync(join(S.home, ".constellation", "llm.env"), "OPENAI_API_KEY=x\n");
    const bin = fakeDsh(S.root);
    const nokey = await withEnv({ HOME: S.home, USERPROFILE: S.home, DEEPSEEK_API_KEY: undefined }, () => collect(new DshEngine({ bin }), S.input));
    assert.deepEqual(nokey.map((e) => e.type), ["status", "error"]);
    assert.equal(nokey[1].text, DSH_KEY_MSG);
    assert.match(DSH_KEY_MSG, /Conta → Chaves de modelo/);
    assert.ok(!existsSync(join(S.root, "argv.txt")), "sem chave o dsh nem é iniciado");
  } finally { S.cleanup(); }
});

test("esperando o humano (ask_human sem resposta) NÃO conta como inatividade; silêncio sem pergunta conta", POSIX_NODE, async () => {
  const S = sandbox();
  try {
    const f = join(S.root, "dsh-ask");
    writeFileSync(f, `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume(); process.stdin.on("end", () => {});
out({ type: "session", sessionId: "s-ask" });
out({ type: "tool_call", callId: "c1", tool: "mcp__cardume__ask_human", input: { question: "e aí?" } });
setTimeout(() => {
  out({ type: "tool_result", callId: "c1", status: "completed", result: "oi" });
  out({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
  out({ type: "final", text: "ok" });
  process.exit(0);
}, 4500); // silêncio bem maior que o idleMs: só passa se a pergunta aberta segurar o timer
`);
    chmodSync(f, 0o755);
    const env = { HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome") };
    const evs = await withEnv(env, () => collect(new DshEngine({ bin: f, idleMs: 2500 }), S.input));
    assert.ok(!evs.some((e) => e.type === "error"), JSON.stringify(evs));
    assert.equal(evs.at(-1)!.type, "done");
    const g = join(S.root, "dsh-mudo");
    writeFileSync(g, `#!${process.execPath}
process.stdout.write(JSON.stringify({ type: "session", sessionId: "s-mudo" }) + "\\n");
setInterval(() => {}, 1000);
`);
    chmodSync(g, 0o755);
    const evs2 = await withEnv(env, () => collect(new DshEngine({ bin: g, idleMs: 2500 }), S.input));
    assert.match(evs2.find((e) => e.type === "error")?.text ?? "", /inatividade/);
  } finally { S.cleanup(); }
});

// ---------- dsh REAL + servidor OpenAI-compatível FALSO (sem custo, sem DeepSeek) ----------

const realDsh = resolveDsh();
const REAL = { skip: process.platform === "win32" ? "POSIX-only" : !binExists(realDsh) ? "dsh não instalado (npm i -g @deepseek-ai/dsh)" : !dshNodeOk() ? `node ${process.versions.node} < 22.19` : false };

/** chat/completions em SSE: 1º pede ask_human (MCP do Starfork), 2º escreve o arquivo, 3º responde texto. */
function fakeOpenAi(opts: { ask?: boolean } = { ask: true }) {
  const reqs: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(b); } catch { /* corpo vazio */ }
      reqs.push(body);
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model" };
      const toolMsgs = (body.messages ?? []).filter((m: any) => m.role === "tool").length;
      const call = (name: string, args: object) => [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${toolMsgs}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      ];
      const text = (t: string) => [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 } },
      ];
      // sem o MCP do Starfork = chamada AUXILIAR (título, resumo de commit…) → só texto
      const agent = (body.tools ?? []).some((t: any) => t.function?.name === "mcp__cardume__ask_human");
      const steps: Array<() => object[]> = [
        ...(opts.ask ? [() => call("mcp__cardume__ask_human", { question: "Qual saudação usar?", options: ["oi", "olá"] })] : []),
        () => call("write", { file_path: "hello.txt", content: "oi do deepseek\n" }),
      ];
      const chunks = !agent ? text("resumo auxiliar") : toolMsgs < steps.length ? steps[toolMsgs]() : text("pronto: hello.txt criado");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ port: number; reqs: any[]; close: () => void }>((r) => srv.listen(0, "127.0.0.1", () => r({ port: (srv.address() as AddressInfo).port, reqs, close: () => srv.close() })));
}

test("dsh REAL + servidor falso: edita na worktree, ask_human pelo MCP aparece no app, tokens; --session-id retoma; id desconhecido avisa", { ...REAL, timeout: 180_000 }, async () => {
  const S = sandbox();
  const srv = await fakeOpenAi();
  try {
    // provider custom openai-completions apontado pro servidor falso — overlay POR ÚLTIMO (vence o modelo do Starfork)
    const prov = join(S.root, "fake-provider.yml");
    writeFileSync(prov, [
      "- id: llm-pi-ai", "  config:", "    providers:", "      fake:", "        apiKeyEnv: DEEPSEEK_API_KEY", "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${srv.port}/v1`, "        compat:", "          supportsDeveloperRole: false", "          maxTokensField: max_tokens",
      "        models:", "          - id: fake-model", "- id: agent-default-model", "  config:", "    provider: fake", "    model: fake-model", "",
    ].join("\n"));
    // o dsh INSTALADO aceita os ids do patch: --dump-config mostra upload/OTel/título desligados e a linha do MCP
    // (um id renomeado numa versão nova do dsh faz ESTE teste falhar em vez de rodar com upload ligado)
    {
      const base = await withEnv({ HOME: S.home, USERPROFILE: S.home }, async () => writeBasePatch());
      const run = join(S.root, "run.patch.yml");
      writeFileSync(run, runPatchYaml({ model: "deepseek-flash", mcp: { command: process.execPath, args: ["/x/server.ts"], env: { CARDUME_DB: "/x.db" }, cwd: S.wt } }));
      const dump = execFileSync(realDsh, ["--patch", base, "--patch", run, "--profile", "headless", "--dump-config"], {
        cwd: S.wt, encoding: "utf8", env: { ...process.env, DSH_HOME: join(S.root, "dshhome"), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
      });
      const row = (id: string) => { const i = dump.indexOf(`- id: ${id}\n`); assert.ok(i >= 0, `linha ${id} no --dump-config`); const j = dump.indexOf("\n- id: ", i + 1); return dump.slice(i, j < 0 ? undefined : j); };
      assert.match(row("session-log-deepseek"), /enabled: false/);
      assert.match(row("session-telemetry-otel"), /disabled: true/);
      assert.match(row("session-title-llm"), /disabled: true/);
      assert.match(row("starfork-mcp"), /@deepseek-ai\/dsh-mcp-client[\s\S]*serverName: cardume[\s\S]*transport: stdio/);
      assert.match(row("agent-default-model"), /model: deepseek-flash/);
    }
    const store = new Store(S.input.dbFile); // o MCP do Starfork grava a pergunta aqui; o "app" responde
    const env = { HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome"), CARDUME_DSH_PATCH: prov, CARDUME_NOTIFY: "0", DEEPSEEK_API_KEY: undefined };
    let asked = "";
    const answerer = setInterval(() => {
      const row = (store as any).db.prepare("SELECT id, prompt FROM pending WHERE task_id = ? AND status = 'open'").get("t-ds");
      if (row) { asked = row.prompt; store.answerPending(row.id, "oi"); }
    }, 200);
    let evs: AgentEvent[];
    try {
      evs = await withEnv(env, () => collect(new DshEngine({ model: "deepseek-flash" }), S.input));
    } finally { clearInterval(answerer); }
    const types = evs.map((e) => e.type);
    assert.ok(types.includes("session") && types.at(-1) === "done", JSON.stringify(evs, null, 1));
    assert.equal(readFileSync(join(S.wt, "hello.txt"), "utf8"), "oi do deepseek\n", "o agente editou a worktree");
    assert.equal(asked, "Qual saudação usar?", "a pergunta chegou no app (tabela pending) pelo MCP stdio");
    assert.ok(evs.some((e) => e.type === "note" && /perguntou ao humano/.test(e.text)));
    assert.ok(evs.some((e) => e.type === "write" && e.text === "hello.txt"));
    const done = evs.at(-1)!;
    assert.equal(done.cost!.inTok, 250);
    assert.equal(done.cost!.outTok, 23);
    const agentReq = srv.reqs.find((r) => (r.tools ?? []).length);
    const toolNames = agentReq.tools.map((t: any) => t.function?.name);
    assert.ok(toolNames.includes("mcp__cardume__ask_human") && toolNames.includes("mcp__cardume__claim"), toolNames.join(","));
    assert.ok(srv.reqs.every((r) => (r.tools ?? []).some((t: any) => t.function?.name === "mcp__cardume__ask_human")), "título por IA desligado: nenhuma chamada extra ao modelo");
    const answered = srv.reqs.find((r) => (r.messages ?? []).some((m: any) => m.role === "tool" && /oi/.test(JSON.stringify(m.content))));
    assert.ok(answered, "a resposta do humano voltou pro modelo como resultado da tool");
    assert.ok(!existsSync(join(S.home, ".dsh")), "nunca cria/edita o ~/.dsh do usuário");

    // chat da tarefa: --session-id retoma (o histórico anterior vai junto pro modelo)
    const sid = evs.find((e) => e.type === "session")!.text;
    const n0 = srv.reqs.length;
    const evs2 = await withEnv(env, () => collect(new DshEngine({ model: "deepseek-flash" }), { ...S.input, resume: { sessionId: sid, instruction: "obrigado" } }));
    assert.equal(evs2.at(-1)!.type, "done", JSON.stringify(evs2));
    assert.equal(evs2.find((e) => e.type === "session")!.text, sid);
    const resumed = srv.reqs.slice(n0).find((r) => (r.tools ?? []).length);
    assert.ok(JSON.stringify(resumed.messages).includes("hello.txt") && JSON.stringify(resumed.messages).includes("obrigado"), "a sessão anterior foi retomada");

    // id desconhecido → erro que o orquestrador trata como sessão perdida
    const evs3 = await withEnv(env, () => collect(new DshEngine({ model: "deepseek-flash" }), { ...S.input, resume: { sessionId: "session-nao-existe", instruction: "oi" } }));
    const err = evs3.find((e) => e.type === "error");
    assert.ok(err && sessionMissing(err.text), JSON.stringify(evs3));
  } finally { srv.close(); S.cleanup(); }
});

test("ACEITE: `cardume new --engine deepseek` com o dsh REAL — o agente edita a worktree e o app registra eventos e tokens", { ...REAL, timeout: 240_000 }, async () => {
  const S = sandbox();
  const srv = await fakeOpenAi({ ask: false });
  try {
    const prov = join(S.root, "fake-provider.yml");
    writeFileSync(prov, [
      "- id: llm-pi-ai", "  config:", "    providers:", "      fake:", "        apiKeyEnv: DEEPSEEK_API_KEY", "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${srv.port}/v1`, "        compat:", "          supportsDeveloperRole: false", "          maxTokensField: max_tokens",
      "        models:", "          - id: fake-model", "- id: agent-default-model", "  config:", "    provider: fake", "    model: fake-model", "",
    ].join("\n"));
    // IA auxiliar (resumo de commit etc.) TAMBÉM no DeepSeek: nenhum claude/codex pode rodar
    writeFileSync(join(S.home, ".constellation", "settings.json"), JSON.stringify({ aiEngine: "deepseek" }));
    const never = join(S.root, "never");
    writeFileSync(never, `#!/bin/sh\necho "$0" >> "${S.root}/never.log"\nexit 1\n`);
    chmodSync(never, 0o755);
    const repo = join(S.root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "base\n");
    g("add", "-A"); g("commit", "-q", "-m", "base");
    const cli = join(import.meta.dirname, "..", "cli.ts");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: S.home, USERPROFILE: S.home, CARDUME_DSH_HOME: join(S.root, "dshhome"), CARDUME_DSH_PATCH: prov, CARDUME_NOTIFY: "0", CARDUME_CLAUDE: never, CARDUME_CODEX: never };
    delete env.DEEPSEEK_API_KEY;
    // ASSÍNCRONO: o servidor falso mora neste processo (execFileSync travaria o event loop e o dsh esperaria pra sempre)
    await new Promise<void>((res, rej) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "new", "--repo", repo, "--id", "ds1", "--title", "criar hello", "--engine", "deepseek", "--model", "deepseek-flash", "--approve", "auto", "--no-overlap-check", "--light"], { env, timeout: 200_000 }, (err) => (err ? rej(err) : res())));
    const st = new Store(join(repo, ".cardume", "state.sqlite"));
    const db = (st as any).db;
    const evs = db.prepare("SELECT type, text FROM event WHERE task_id = 'ds1' ORDER BY id").all() as { type: string; text: string }[];
    assert.ok(evs.some((e) => e.type === "write" && e.text === "hello.txt"), JSON.stringify(evs, null, 1));
    assert.ok(evs.some((e) => e.type === "done"), JSON.stringify(evs, null, 1));
    assert.ok(!evs.some((e) => e.type === "error"), JSON.stringify(evs.filter((e) => e.type === "error")));
    const cost = db.prepare("SELECT SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(usd) AS u FROM cost WHERE task_id = 'ds1'").get() as { i: number; o: number; u: number };
    assert.ok(cost.i >= 150 && cost.o >= 13 && cost.u === 0, JSON.stringify(cost));
    const task = db.prepare("SELECT worktree, branch, session_id FROM task WHERE id = 'ds1'").get() as { worktree: string; branch: string; session_id: string };
    assert.match(task.session_id ?? "", /^session-/, "sessão gravada pro chat da tarefa");
    const inWt = existsSync(join(task.worktree, "hello.txt")) ? readFileSync(join(task.worktree, "hello.txt"), "utf8") : execFileSync("git", ["-C", repo, "show", `${task.branch}:hello.txt`], { encoding: "utf8" });
    assert.equal(inWt, "oi do deepseek\n", "o agente editou a worktree da tarefa");
    assert.ok(!existsSync(join(S.root, "never.log")), "nenhum claude nem codex iniciado: " + (existsSync(join(S.root, "never.log")) ? readFileSync(join(S.root, "never.log"), "utf8") : ""));
    st.close?.();
  } finally { srv.close(); S.cleanup(); }
});
