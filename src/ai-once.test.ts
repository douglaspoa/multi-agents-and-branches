// node --test src/ai-once.test.ts  (npm test)
// IA auxiliar segue a IA padrão: roteamento claude/codex/gateway, fallback, parser do codex, gateway HTTP.
// Golden COMPARTILHADO com o Rust (tests/fixtures/ai-once-golden/). HOME TEMPORÁRIO, codex FALSO
// (script que grava argv/env/cwd/stdin) e servidor HTTP local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  aiOnce, claudeArgs, codexArgs, codexModelRefused, codexOutcome, codexPlan, CODEX_MISSING_MSG, gatewayPayload,
  NO_ENGINE_MSG, parseCodexJsonl, parseGateway, pickEngine, readAiPrefs, userModelFor,
  binExists, clearAvailCache, dshOutcome, dshPlan, parseDshJsonl,
} from "./ai-once.ts";
import { DSH_KEY_MSG, DSH_MISSING_MSG, dshNodeOk, resolveDsh } from "./engine/dsh.ts";
import { tempHome } from "./testing/temp-home.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : false };
const POSIX_NODE = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : !dshNodeOk() ? `node ${process.versions.node} < 22.19 (o dsh não roda)` : false };
const golden = (f: string) => JSON.parse(readFileSync(new URL("../tests/fixtures/ai-once-golden/" + f, import.meta.url), "utf8"));

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

/** codex falso: grava argv (um por linha), env, cwd e stdin; responde JSONL como o codex-cli 0.153. */
function fakeCodex(dir: string, jsonl: string, opts: { exit?: number; refuse?: boolean } = {}): string {
  const f = join(dir, "codex");
  const refused = JSON.stringify({ type: "turn.failed", error: { message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." } });
  writeFileSync(f, `#!/bin/sh
echo call >> "${dir}/calls.log"
printf '%s\\n' "$@" > "${dir}/codex-args.txt"
echo "OPENAI_API_KEY=$OPENAI_API_KEY" > "${dir}/codex-env.txt"
echo "LGCX_API_KEY=$LGCX_API_KEY" >> "${dir}/codex-env.txt"
pwd > "${dir}/codex-cwd.txt"
cat > "${dir}/codex-stdin.txt"
${opts.refuse ? `for a in "$@"; do if [ "$a" = "-m" ]; then echo '${refused}'; exit 1; fi; done` : ""}
cat <<'EOF'
${jsonl}
EOF
exit ${opts.exit ?? 0}
`);
  chmodSync(f, 0o755);
  return f;
}

/** claude falso: grava os args (prova que NÃO roda / roda com os args de antes). */
function fakeClaude(dir: string): string {
  const f = join(dir, "claude");
  writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/claude-args.txt"\necho "resposta do claude"\n`);
  chmodSync(f, 0o755);
  return f;
}

const OK_JSONL = '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Adicionar filtro por data"}}';

test("golden: pickEngine (mesmos casos do Rust)", () => {
  for (const c of golden("pick.json")) assert.equal(pickEngine(c.pref, c.avail), c.expect, JSON.stringify(c));
});

test("golden: JSONL do codex — texto, erro cru, recusa de modelo, mensagem humana", () => {
  for (const c of golden("codex.json")) {
    const o = codexOutcome(c.jsonl);
    assert.equal(o.text, c.text ?? undefined, c.name);
    if (c.rawError) assert.ok((o.raw ?? "").includes(c.rawError), `${c.name}: ${o.raw}`);
    assert.equal(codexModelRefused(o.raw ?? ""), c.refused, c.name);
    if (c.friendly) {
      const e = parseCodexJsonl(c.jsonl).error ?? "";
      assert.ok(e.includes(c.friendly) && !e.includes('{"'), `${c.name}: ${e}`);
    }
  }
  assert.equal(codexModelRefused("O Codex falhou: modelo"), false, "o texto amigável do app não dispara a recusa");
});

test("golden: respostas do gateway (partes, cortada, vazia, chave)", () => {
  for (const c of golden("gateway.json")) {
    const r = parseGateway(c.body);
    if (c.text !== undefined) assert.equal(r.text, c.text, c.name);
    else assert.ok((r.error ?? "").includes(c.error), `${c.name}: ${r.error}`);
  }
  assert.equal(JSON.parse(gatewayPayload("m", "oi")).max_tokens, 16000);
});

test("readAiPrefs / userModelFor / codexPlan / args", () => {
  const H = tempHome({ aiEngine: "codex", aiModel: "gpt-5" });
  try {
    assert.deepEqual(readAiPrefs(join(H.home, ".constellation", "settings.json")), { engine: "codex", model: "gpt-5" });
    assert.deepEqual(readAiPrefs(join(H.home, "nao-existe.json")), { engine: "claude", model: "" });
  } finally { H.cleanup(); }
  assert.equal(userModelFor("codex", "codex", "gpt-5"), "gpt-5");
  assert.equal(userModelFor("claude", "codex", "opus"), undefined, "fallback: aiModel é de outro motor");
  assert.equal(userModelFor("claude", "claude", "opus"), undefined, "claude mantém os modelos de antes");
  assert.equal(userModelFor("gateway", "gateway", "m; rm -rf"), undefined);
  assert.deepEqual(codexPlan("capaz"), { model: "gpt-5-codex", low: false });
  assert.deepEqual(codexPlan("rapido"), { model: undefined, low: true });
  assert.deepEqual(codexPlan("rapido", "o4-mini"), { model: "o4-mini", low: true });
  assert.deepEqual(claudeArgs("oi", "claude-haiku-4-5-20251001"), ["-p", "oi", "--model", "claude-haiku-4-5-20251001"]);
  assert.deepEqual(claudeArgs("oi"), ["-p", "oi"]);
  assert.deepEqual(codexArgs("gpt-5-codex"), ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-m", "gpt-5-codex", "-"]);
  assert.ok(codexArgs(undefined, true).includes('model_reasoning_effort="low"'));
});

test("padrão Codex sem claude: só-leitura, prompt no stdin, só a OPENAI_API_KEY; claude nunca é chamado", POSIX, async () => {
  const H = tempHome({ aiEngine: "codex" }, "OPENAI_API_KEY=sk-teste\nLGCX_API_KEY=lgcx-segredo\n");
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const codex = fakeCodex(bin, OK_JSONL);
    const cwd = join(H.home, "repo"); mkdirSync(cwd);
    const prompt = 'gere um título "com aspas"\ne quebra';
    const out = await withEnv({ HOME: H.home, LGCX_API_KEY: "herdada" }, () =>
      aiOnce(prompt, { tier: "capaz", claudeModel: "claude-sonnet-5", cwd, timeout: 10_000 }, { avail: { claude: false, codex: true }, codexBin: codex }));
    assert.equal(out, "Adicionar filtro por data");
    const args = readFileSync(join(bin, "codex-args.txt"), "utf8").trim().split("\n");
    assert.deepEqual(args, ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-m", "gpt-5-codex", "-"]);
    assert.equal(readFileSync(join(bin, "codex-stdin.txt"), "utf8"), prompt);
    assert.equal(readFileSync(join(bin, "codex-env.txt"), "utf8"), "OPENAI_API_KEY=sk-teste\nLGCX_API_KEY=\n");
    assert.equal(readFileSync(join(bin, "codex-cwd.txt"), "utf8").trim(), cwd);
    assert.ok(!existsSync(join(bin, "claude-args.txt")));
    // nível rápido: padrão do Codex (sem -m) com raciocínio low
    await withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 10_000 }, { avail: { claude: false, codex: true }, codexBin: codex }));
    const a2 = readFileSync(join(bin, "codex-args.txt"), "utf8").split("\n");
    assert.ok(!a2.includes("-m") && a2.includes('model_reasoning_effort="low"'));
  } finally { H.cleanup(); }
});

test("aiModel do Codex vale nos dois níveis", POSIX, async () => {
  const H = tempHome({ aiEngine: "codex", aiModel: "o4-mini" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const codex = fakeCodex(bin, OK_JSONL);
    await withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 10_000 }, { avail: { codex: true }, codexBin: codex }));
    const a = readFileSync(join(bin, "codex-args.txt"), "utf8").split("\n");
    assert.equal(a[a.indexOf("-m") + 1], "o4-mini");
  } finally { H.cleanup(); }
});

test("codex: turn.failed vira mensagem humana; modelo recusado → sem -m e lembra; ausente/timeout", POSIX, async () => {
  const H = tempHome({ aiEngine: "codex" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  const deps = (codexBin: string) => ({ avail: { claude: false, codex: true }, codexBin });
  try {
    const fail = fakeCodex(bin, JSON.stringify({ type: "turn.failed", error: { message: "429 rate limit exceeded" } }), { exit: 1 });
    await assert.rejects(withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 10_000 }, deps(fail))),
      (e: Error) => /sem cota/.test(e.message) && !e.message.includes("{"));
    const dir2 = join(H.home, "bin2"); mkdirSync(dir2);
    const refusing = fakeCodex(dir2, OK_JSONL, { refuse: true });
    await withEnv({ HOME: H.home, }, async () => {
      // modelo do usuário único pra este teste (a recusa fica guardada no processo)
      writeFileSync(join(H.home, ".constellation", "settings.json"), JSON.stringify({ aiEngine: "codex", aiModel: "modelo-recusado-teste-ts" }));
      assert.equal(await aiOnce("x", { tier: "capaz", timeout: 10_000 }, deps(refusing)), "Adicionar filtro por data");
      assert.equal(readFileSync(join(dir2, "calls.log"), "utf8").trim().split("\n").length, 2);
      assert.equal(await aiOnce("y", { tier: "capaz", timeout: 10_000 }, deps(refusing)), "Adicionar filtro por data");
      assert.equal(readFileSync(join(dir2, "calls.log"), "utf8").trim().split("\n").length, 3, "2ª chamada já sem -m");
    });
    await assert.rejects(withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 10_000 }, deps("/nao/existe/codex"))),
      (e: Error) => e.message === CODEX_MISSING_MSG);
  } finally { H.cleanup(); }
});

test("motor escolhido ausente → usa o claude (argumentos de antes)", POSIX, async () => {
  const H = tempHome({ aiEngine: "codex", aiModel: "gpt-5" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const claude = fakeClaude(bin);
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude }, () =>
      aiOnce("oi", { tier: "rapido", claudeModel: "claude-haiku-4-5-20251001", timeout: 10_000 }, { avail: { claude: true, codex: false } }));
    assert.equal(out, "resposta do claude");
    assert.deepEqual(readFileSync(join(bin, "claude-args.txt"), "utf8").trim().split("\n"), ["-p", "oi", "--model", "claude-haiku-4-5-20251001", "--output-format", "json"], "args de antes + o JSON do custo (livro de uso)");
  } finally { H.cleanup(); }
});

test("padrão gateway: HTTP chat/completions; aiModel vence ALT_AI_MODEL; erros humanos", async () => {
  let got: any = null, auth = "";
  let mode = "ok";
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      got = { url: req.url, body: JSON.parse(b) };
      auth = String(req.headers.authorization ?? "");
      res.setHeader("Content-Type", "application/json");
      if (mode === "ok") res.end(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: " resposta " }, { type: "text", text: "do gateway " }] }, finish_reason: "stop" }] }));
      else if (mode === "cut") res.end(JSON.stringify({ choices: [{ message: { content: "metade" }, finish_reason: "length" }] }));
      else { res.statusCode = 401; res.end(JSON.stringify({ error: { message: "Invalid API key" } })); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const H = tempHome({ aiEngine: "gateway" }, `ALT_AI_BASE_URL=http://127.0.0.1:${port}/v1/\nALT_AI_KEY=gw-key\nALT_AI_MODEL=modelo-interno\n`);
  const deps = { avail: { claude: false, codex: false, gateway: true } };
  try {
    const env = { HOME: H.home };
    assert.equal(await withEnv(env, () => aiOnce("oi gateway", { tier: "capaz", timeout: 10_000 }, deps)), "resposta do gateway");
    assert.equal(got.url, "/v1/chat/completions");
    assert.deepEqual(got.body, { model: "modelo-interno", max_tokens: 16000, stream: false, messages: [{ role: "user", content: "oi gateway" }] });
    assert.equal(auth, "Bearer gw-key");
    writeFileSync(join(H.home, ".constellation", "settings.json"), JSON.stringify({ aiEngine: "gateway", aiModel: "outro-modelo" }));
    await withEnv(env, () => aiOnce("oi", { tier: "rapido", timeout: 10_000 }, deps));
    assert.equal(got.body.model, "outro-modelo");
    mode = "cut";
    await assert.rejects(withEnv(env, () => aiOnce("oi", { tier: "rapido", timeout: 10_000 }, deps)), (e: Error) => /cortada \(limite de tokens\)/.test(e.message));
    mode = "401";
    await assert.rejects(withEnv(env, () => aiOnce("oi", { tier: "rapido", timeout: 10_000 }, deps)), (e: Error) => /recusou a chave/.test(e.message));
  } finally {
    srv.close();
    H.cleanup();
  }
});

test("nenhum motor: erro dizendo o que instalar/configurar", async () => {
  const H = tempHome({ aiEngine: "codex" }, "LGCX_API_KEY=\n");
  try {
    await assert.rejects(
      withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 5000 }, { avail: { claude: false, codex: false, gateway: false } })),
      (e: Error) => e.message === NO_ENGINE_MSG,
    );
  } finally { H.cleanup(); }
});

// ---------- DeepSeek Harness (beta) ----------

test("golden: JSONL do dsh — texto do final, erro cru, mensagem humana (mesmos casos do Rust)", () => {
  for (const c of golden("dsh.json")) {
    const o = dshOutcome(c.jsonl);
    assert.equal(o.text, c.text ?? undefined, c.name);
    if (c.rawError) assert.ok((o.raw ?? "").includes(c.rawError), `${c.name}: ${o.raw}`);
    if (c.friendly) {
      const e = parseDshJsonl(c.jsonl).error ?? "";
      assert.ok(e.includes(c.friendly) && !e.includes('{"'), `${c.name}: ${e}`);
    }
  }
  assert.equal(dshPlan("rapido"), "deepseek-flash");
  assert.equal(dshPlan("capaz"), "deepseek-v4-pro");
  assert.equal(dshPlan("rapido", "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(dshPlan("capaz", "sonnet"), "deepseek-v4-pro", "alias do Claude nunca vai pro deepseek-official");
  assert.equal(userModelFor("deepseek", "deepseek", "deepseek-flash"), "deepseek-flash");
  assert.equal(userModelFor("codex", "deepseek", "gpt-5"), undefined, "fallback: aiModel é de outro motor");
  assert.ok(NO_ENGINE_MSG.includes("@deepseek-ai/dsh"));
});

/** dsh falso: grava argv, env e stdin; responde o JSONL real do headless. */
function fakeDshAux(dir: string, final = "Título do DeepSeek"): string {
  const f = join(dir, "dsh");
  const jsonl = [{ type: "session", sessionId: "s1" }, { type: "status", phase: "turn_end", reason: { kind: "completed" } }, { type: "final", text: final }].map((o) => JSON.stringify(o)).join("\n");
  writeFileSync(f, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/dsh-args.txt"
echo "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" > "${dir}/dsh-env.txt"
echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> "${dir}/dsh-env.txt"
echo "DSH_PERMISSION_MODE=$DSH_PERMISSION_MODE" >> "${dir}/dsh-env.txt"
cat > "${dir}/dsh-stdin.txt"
cat <<'JSONL'
${jsonl}
JSONL
`);
  chmodSync(f, 0o755);
  return f;
}

test("padrão DeepSeek: dsh headless SÓ-LEITURA, prompt no stdin, só a DEEPSEEK_API_KEY; claude/codex nunca chamados", POSIX_NODE, async () => {
  const H = tempHome({ aiEngine: "deepseek" }, "DEEPSEEK_API_KEY=sk-ds\nOPENAI_API_KEY=sk-openai\n");
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const dsh = fakeDshAux(bin);
    const claude = fakeClaude(bin);
    const codex = fakeCodex(bin, OK_JSONL);
    const prompt = 'gere um título "com aspas"\ne quebra';
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_DSH_HOME: join(H.home, "dshhome") }, () =>
      aiOnce(prompt, { tier: "rapido", claudeModel: "claude-haiku-4-5-20251001", timeout: 10_000 }, { avail: { claude: true, codex: true, deepseek: true }, dshBin: dsh, codexBin: codex }));
    assert.equal(out, "Título do DeepSeek");
    const args = readFileSync(join(bin, "dsh-args.txt"), "utf8").trim().split("\n");
    assert.deepEqual(args.slice(-3), ["--profile", "headless", "--json"]);
    assert.equal(args.filter((a) => a === "--patch").length, 2);
    assert.ok(!args.join(" ").includes("título") && !args.join(" ").includes("sk-ds"), "prompt e chave fora do argv");
    assert.equal(readFileSync(join(bin, "dsh-stdin.txt"), "utf8"), prompt);
    assert.equal(readFileSync(join(bin, "dsh-env.txt"), "utf8"), "DEEPSEEK_API_KEY=sk-ds\nOPENAI_API_KEY=\nDSH_PERMISSION_MODE=read-only\n");
    assert.ok(!existsSync(join(bin, "claude-args.txt")) && !existsSync(join(bin, "codex-args.txt")), "nem claude nem codex");
    // o patch fixo fica (sem chave); o por chamada (com o modelo) é apagado
    const fixed = join(H.home, ".constellation", "dsh", "starfork.patch.yml");
    assert.equal(args[1], fixed);
    assert.ok(!readFileSync(fixed, "utf8").includes("sk-ds"));
    assert.ok(!existsSync(args[3]), "patch por chamada apagado");
  } finally { H.cleanup(); }
});

test("deepseek: sem dsh / sem chave → mensagens humanas (ordem binário → node → chave)", POSIX_NODE, async () => {
  const H = tempHome({ aiEngine: "deepseek" }, "OPENAI_API_KEY=x\n");
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    await assert.rejects(withEnv({ HOME: H.home, DEEPSEEK_API_KEY: undefined }, () => aiOnce("x", { tier: "rapido", timeout: 5_000 }, { avail: { deepseek: true }, dshBin: "/nao/existe/dsh" })),
      (e: Error) => e.message === DSH_MISSING_MSG);
    const dsh = fakeDshAux(bin);
    await assert.rejects(withEnv({ HOME: H.home, DEEPSEEK_API_KEY: undefined }, () => aiOnce("x", { tier: "rapido", timeout: 5_000 }, { avail: { deepseek: true }, dshBin: dsh })),
      (e: Error) => e.message === DSH_KEY_MSG);
    assert.ok(!existsSync(join(bin, "dsh-args.txt")), "sem chave o dsh nem é iniciado");
  } finally { H.cleanup(); }
});

test("disponibilidade REAL: aiEngine=deepseek mas sem chave → cai no claude (nunca o contrário)", POSIX, async () => {
  const H = tempHome({ aiEngine: "deepseek" }, "OPENAI_API_KEY=x\n");
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const dsh = fakeDshAux(bin);
    const claude = fakeClaude(bin);
    clearAvailCache();
    const out = await withEnv({ HOME: H.home, CARDUME_DSH: dsh, CARDUME_CLAUDE: claude, DEEPSEEK_API_KEY: undefined }, () =>
      aiOnce("oi", { tier: "rapido", timeout: 10_000 }));
    assert.equal(out, "resposta do claude");
    assert.ok(!existsSync(join(bin, "dsh-args.txt")), "dsh sem chave não roda");
  } finally { clearAvailCache(); H.cleanup(); }
});

test("DeepSeek NUNCA é fallback automático: IA padrão Claude ausente e só o DeepSeek pronto → erro, não DeepSeek", async () => {
  const H = tempHome({ aiEngine: "claude" }, "DEEPSEEK_API_KEY=k\n");
  try {
    await assert.rejects(withEnv({ HOME: H.home }, () => aiOnce("x", { tier: "rapido", timeout: 5_000 }, { avail: { claude: false, codex: false, gateway: false, deepseek: true }, dshBin: "/nao/existe/dsh" })),
      (e: Error) => e.message === NO_ENGINE_MSG);
  } finally { H.cleanup(); }
});

const REAL_DSH = { skip: process.platform === "win32" ? "POSIX-only" : !binExists(resolveDsh()) ? "dsh não instalado" : !dshNodeOk() ? "node < 22.19" : false, timeout: 120_000 };
test("dsh REAL (servidor OpenAI-compatível falso): título via auxiliar, sem claude nem codex", REAL_DSH, async () => {
  let n = 0;
  const srv = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      n++;
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Filtro por data na lista" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const H = tempHome({ aiEngine: "deepseek" }, "DEEPSEEK_API_KEY=sk-fake\n");
  const bin = join(H.home, "bin"); mkdirSync(bin);
  try {
    const prov = join(H.home, "prov.yml");
    writeFileSync(prov, [
      "- id: llm-pi-ai", "  config:", "    providers:", "      fake:", "        apiKeyEnv: DEEPSEEK_API_KEY", "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${port}/v1`, "        compat:", "          supportsDeveloperRole: false", "          maxTokensField: max_tokens",
      "        models:", "          - id: fake-model", "- id: agent-default-model", "  config:", "    provider: fake", "    model: fake-model", "",
    ].join("\n"));
    const claude = fakeClaude(bin);
    const codex = fakeCodex(bin, OK_JSONL);
    clearAvailCache(); // disponibilidade REAL do deepseek (binário + node + chave do HOME temporário), sem cache de outro teste
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_CODEX: codex, CARDUME_DSH_HOME: join(H.home, "dshhome"), CARDUME_DSH_PATCH: prov }, () =>
      aiOnce("gere um título curto para: filtro por data", { tier: "rapido", timeout: 60_000 }, { codexBin: codex }));
    assert.equal(out, "Filtro por data na lista");
    assert.equal(n, 1, "uma chamada só ao modelo (título por IA do dsh desligado)");
    assert.ok(!existsSync(join(bin, "claude-args.txt")) && !existsSync(join(bin, "calls.log")), "nenhum claude nem codex iniciado");
  } finally { srv.close(); clearAvailCache(); H.cleanup(); }
});
