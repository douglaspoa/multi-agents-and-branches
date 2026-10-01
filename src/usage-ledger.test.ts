// node --test src/usage-ledger.test.ts  (npm test)
// Livro de uso (aba Uso) no motor: esquema e normalização IGUAIS ao Rust (golden tests/fixtures/usage-golden/), tabela
// única de preço com entrada/cache/saída, turno de tarefa gravado no livro com o mesmo `at` do `cost`, IA auxiliar
// gravando claude/codex/deepseek/gateway (modelo usado, cache, estimado), erro do Claude em mensagem humana, base da
// sessão do Claude pelo transcript, banco antigo migrado, retenção e livro quebrado sem afetar a chamada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE_MIGRATION, USAGE_SCHEMA, closeUsageDbs, estimateUsd, normEngine, normProject, normSource, priceOf, pruneUsage,
  recordUsage, recordUsageIn, sessionCostBaselineIn,
} from "./usage-ledger.ts";
import { aiOnce, claudeOnceText } from "./ai-once.ts";
import { Store } from "./store.ts";
import { tempHome } from "./testing/temp-home.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : false };
const golden = (f: string) => readFileSync(new URL("../tests/fixtures/usage-golden/" + f, import.meta.url), "utf8");
const rows = (file: string) => {
  const db = new DatabaseSync(file);
  try { return db.prepare("SELECT * FROM ai_usage ORDER BY id").all() as any[]; } finally { db.close(); }
};
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sf-usage-ts-")));
const PRICES = JSON.parse(readFileSync(new URL("./usage-prices.json", import.meta.url), "utf8"));

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}
function script(dir: string, name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}`);
  chmodSync(f, 0o755);
  return f;
}

test("esquema + migração iguais ao golden (≡ Rust)", () => {
  assert.equal(`${USAGE_SCHEMA}-- migração (banco de antes de cached_tok):\n${USAGE_MIGRATION}`.trim(), golden("schema.sql").trim());
});

test("normalização igual ao golden (≡ Rust): preço por modelo/motor, cache, sessão e base do transcript, teste", () => {
  const d = tmp();
  try {
    const file = join(d, "u.sqlite");
    const g = JSON.parse(golden("normalize.json"));
    g.cases.forEach((c: any, i: number) => {
      const x = c.in;
      recordUsageIn(file, { at: Date.now() + i, source: x.source, engine: x.engine, model: x.model, inTok: x.in_tok, cachedTok: x.cached_tok, outTok: x.out_tok, usd: x.usd, claudeSession: x.claude_session, claudeTotal: x.claude_total, claudeBaseline: x.claude_baseline });
    });
    closeUsageDbs();
    const got = rows(file);
    assert.equal(got.length, g.cases.length);
    got.forEach((r, i) => {
      const o = g.cases[i].out;
      assert.equal(r.source, o.source, `caso ${i}`);
      assert.equal(r.engine, o.engine, `caso ${i}`);
      assert.ok(Math.abs(r.usd - o.usd) < 1e-9, `caso ${i}: ${r.usd} vs ${o.usd}`);
      assert.equal(r.usd_estimated, o.usd_estimated, `caso ${i}`);
      assert.equal(r.cached_tok, o.cached_tok, `caso ${i}`);
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("preço separado: entrada nova, cache e saída (src/usage-prices.json)", () => {
  assert.deepEqual(priceOf("codex"), PRICES.engines.codex);
  assert.deepEqual(priceOf("claude", "claude-haiku-4-5-20251001"), PRICES.models["claude-haiku"]);
  assert.deepEqual(priceOf("codex", "gpt-5-mini"), PRICES.models["gpt-5-mini"], "maior prefixo vence");
  assert.deepEqual(priceOf("outro-motor"), PRICES.fallback);
  // 1 M de entrada (900 mil do cache) + 100 mil de saída no codex
  assert.ok(Math.abs(estimateUsd("codex", "", 1_000_000, 900_000, 100_000) - 1.2375) < 1e-9);
  assert.ok(Math.abs(estimateUsd("codex", "", 10, 50, 0) - 10 * 0.125 / 1e6) < 1e-12, "cache maior que a entrada não fica negativo");
  assert.equal(normSource("teste"), "teste");
  assert.equal(normSource("xyz"), "outros");
  assert.equal(normEngine("Codex (gpt-5)"), "codex");
  assert.equal(normEngine("dsh-flash"), "deepseek");
  assert.equal(normProject("/nao/existe/"), "/nao/existe");
});

test("banco antigo sem cached_tok: migra na abertura; retenção roda no máximo 1×/dia", () => {
  const d = tmp();
  try {
    const file = join(d, "u.sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, project TEXT, task_id TEXT, role TEXT, engine TEXT NOT NULL, model TEXT, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, usd_estimated INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1)");
    old.close();
    recordUsageIn(file, { source: "retro", engine: "codex", inTok: 10, cachedTok: 4 });
    closeUsageDbs();
    assert.equal(rows(file)[0].cached_tok, 4);
    const db = new DatabaseSync(file);
    try {
      const DAY = 86_400_000, now = 1000 * DAY;
      db.prepare("INSERT INTO ai_usage (at, source, engine) VALUES (?, 'retro', 'claude'), (?, 'retro', 'claude')").run(now - 401 * DAY, now - 10 * DAY);
      db.exec("DELETE FROM ai_usage WHERE at > 1000 * 86400000; DELETE FROM usage_meta");
      pruneUsage(db, now);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_usage").get() as any).n, 1);
      db.prepare("INSERT INTO ai_usage (at, source, engine) VALUES (?, 'retro', 'claude')").run(now - 500 * DAY);
      pruneUsage(db, now + DAY / 2);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_usage").get() as any).n, 2, "mesmo dia: não roda de novo");
    } finally { db.close(); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("base da sessão do Claude pelo transcript (≡ Rust session_cost_baseline_in)", () => {
  const d = tmp();
  try {
    mkdirSync(join(d, "projects", "-x"), { recursive: true });
    writeFileSync(join(d, "projects", "-x", "sess-antiga-1234.jsonl"), '{"type":"cost-state","totalCostUSD":1.5}\n{"type":"cost-state","totalCostUSD":2.25}\n{"type":"cost-sta');
    assert.equal(sessionCostBaselineIn(d, "sess-antiga-1234"), 2.25);
    assert.equal(sessionCostBaselineIn(d, "../../etc"), 0);
    const file = join(d, "u.sqlite");
    const r = recordUsageIn(file, { source: "chat-projeto", engine: "claude", claudeSession: "sess-antiga-1234", claudeTotal: 2.4, claudeBaseline: 2.25 });
    assert.ok(Math.abs(r.usd - 0.15) < 1e-9, "primeira vez: total − base, não o acumulado inteiro");
    closeUsageDbs();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("Store.addCost: turno da tarefa vai pro livro com o MESMO at do cost (projeto real só) e com o cache", async () => {
  const d = tmp();
  try {
    const file = join(d, "u.sqlite");
    const repo = join(d, "proj");
    mkdirSync(join(repo, ".cardume"), { recursive: true });
    await withEnv({ CARDUME_USAGE_DB: file }, () => {
      const s = new Store(join(repo, ".cardume", "state.sqlite"));
      s.addCost("t1", "Coder", "builder", 0.25, 100, 20, 1500, "claude", "claude-sonnet-5", 60);
      s.addCost("t1", "Revisor", "reviewer", 0, 3000, 1000, 800, "codex", "gpt-5-codex", 2000);
      const cost = s.db.prepare("SELECT created_at FROM cost ORDER BY id").all() as any[];
      s.close();
      closeUsageDbs();
      const got = rows(file);
      assert.deepEqual(got.map((r) => [r.source, r.task_id, r.role, r.engine, r.project, r.usd_estimated, r.cached_tok]), [
        ["tarefa", "t1", "Coder", "claude", repo, 0, 60],
        ["tarefa", "t1", "Revisor", "codex", repo, 1, 2000],
      ]);
      assert.equal(got[0].usd, 0.25);
      assert.equal(got[1].usd, estimateUsd("codex", "gpt-5-codex", 3000, 2000, 1000));
      assert.deepEqual(got.map((r) => r.at), cost.map((c) => c.created_at), "mesmo at = a aba não duplica o histórico");
      const s2 = new Store(join(d, "solto.sqlite"));
      s2.addCost("t2", "A", "builder", 1, 1, 1, 1);
      s2.close();
      closeUsageDbs();
      assert.equal(rows(file).length, 2, "banco fora de .cardume não grava no livro");
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("claudeOnceText: mesmo texto do -p puro; envelope = última linha com {; erro humano (≡ Rust)", () => {
  const acc = { inTok: 0, cachedTok: 0, outTok: 0, usd: 0 } as any;
  assert.equal(claudeOnceText(`aviso\n{"type":"result","is_error":false,"result":" ok \\n","total_cost_usd":0.01,"usage":{"input_tokens":3,"cache_read_input_tokens":7,"output_tokens":2},"modelUsage":{"claude-haiku-4-5":{"costUSD":0.01}}}`, acc), "ok");
  assert.deepEqual(acc, { inTok: 10, cachedTok: 7, outTok: 2, usd: 0.01, model: "claude-haiku-4-5" });
  assert.equal(claudeOnceText("texto puro\n"), "texto puro");
  // resposta da IA que É um JSON em texto (a retro) passa como veio — não é envelope nem evento do protocolo
  assert.equal(claudeOnceText('{"notas":[{"title":"x"}],"skills":[]}\n'), '{"notas":[{"title":"x"}],"skills":[]}');
  assert.throws(() => claudeOnceText(`{"is_error":true,"result":"Failed to authenticate. API Error: 401"}`), (e: Error) => e.message.startsWith("Login do Claude Code expirou") && e.message.includes("401"));
  assert.throws(() => claudeOnceText(`{"is_error":true,"result":"API Error: 429 rate limit"}`), /sem cota\/limite/);
  assert.throws(() => claudeOnceText(`{"type":"result","is_error":false,"session_id":"s"}`), (e: Error) => e.message.startsWith("O Claude Code terminou sem resposta") && !e.message.includes("session_id"));
  assert.throws(() => claudeOnceText(`{"type":"system","subtype":"init"}`), (e: Error) => !e.message.includes("subtype"));
});

test("aiOnce: claude (custo informado), codex com retry sem -m (modelo USADO), deepseek e gateway (cache + estimado)", POSIX, async () => {
  const H = tempHome({ aiEngine: "claude" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  const file = join(H.home, "usage.sqlite");
  const claude = script(bin, "claude", `echo '{"type":"result","is_error":false,"result":"SKIP","session_id":"s1","total_cost_usd":0.002,"usage":{"input_tokens":40,"output_tokens":3}}'\n`);
  const refused = JSON.stringify({ type: "turn.failed", error: { message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." } });
  const codex = script(bin, "codex", `cat > /dev/null
for a in "$@"; do if [ "$a" = "-m" ]; then echo '${refused}'; exit 1; fi; done
echo '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"resposta do codex"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":50}}'
`);
  const dsh = script(bin, "dsh", `cat > /dev/null
echo '{"type":"session","sessionId":"s1"}'
echo '{"type":"status","phase":"step_end","usage":{"inputTokens":700,"outputTokens":10}}'
echo '{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}'
echo '{"type":"final","text":"resposta do deepseek"}'
`);
  const srv = createServer((req, res) => {
    req.on("data", () => {}); req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "resposta do gateway" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 500 } } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const settings = (o: object) => writeFileSync(join(H.home, ".constellation", "settings.json"), JSON.stringify(o));
  try {
    await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_USAGE_DB: file, CARDUME_DSH_HOME: join(H.home, "dshhome"), DEEPSEEK_API_KEY: "sk-ds" }, async () => {
      assert.equal(await aiOnce("x", { tier: "capaz", claudeModel: "claude-sonnet-5", timeout: 10_000, usage: { source: "retro", project: "/repo/x/", taskId: "t9" } }, { avail: { claude: true } }), "SKIP");
      settings({ aiEngine: "codex" });
      assert.equal(await aiOnce("x", { tier: "capaz", claudeModel: "claude-sonnet-5", timeout: 10_000, usage: { source: "commit-pr" } }, { avail: { codex: true }, codexBin: codex }), "resposta do codex");
      settings({ aiEngine: "deepseek" });
      assert.equal(await aiOnce("x", { tier: "rapido", claudeModel: "claude-haiku-4-5-20251001", timeout: 10_000, usage: { source: "retro" } }, { avail: { deepseek: true }, dshBin: dsh }), "resposta do deepseek");
      settings({ aiEngine: "gateway" });
      writeFileSync(join(H.home, ".constellation", "llm.env"), `ALT_AI_BASE_URL=http://127.0.0.1:${port}/v1\nALT_AI_KEY=gw\nALT_AI_MODEL=m-gw\n`);
      assert.equal(await aiOnce("x", { tier: "capaz", claudeModel: "claude-sonnet-5", timeout: 10_000, usage: { source: "retro" } }, { avail: { gateway: true } }), "resposta do gateway");
      // codex ausente: linha de falha com o modelo do CODEX, nunca o do Claude
      settings({ aiEngine: "codex" });
      await assert.rejects(aiOnce("x", { tier: "capaz", claudeModel: "claude-sonnet-5", timeout: 10_000, usage: { source: "retro" } }, { avail: { codex: true }, codexBin: "/nao/existe/codex" }));
    });
    closeUsageDbs();
    const got = rows(file);
    assert.equal(got.length, 5);
    const pick = (r: any) => [r.source, r.engine, r.model, r.in_tok, r.cached_tok, r.out_tok, r.usd_estimated, r.ok];
    assert.deepEqual(pick(got[0]), ["retro", "claude", "claude-sonnet-5", 40, 0, 3, 0, 1]);
    assert.equal(got[0].usd, 0.002);
    assert.equal(got[0].project, "/repo/x");
    assert.equal(got[0].task_id, "t9");
    assert.deepEqual(pick(got[1]), ["commit-pr", "codex", null, 5000, 4000, 50, 1, 1], "retry sem -m: modelo usado = padrão do Codex (null)");
    assert.equal(got[1].usd, estimateUsd("codex", "", 5000, 4000, 50));
    assert.deepEqual(pick(got[2]).slice(0, 2), ["retro", "deepseek"]);
    assert.deepEqual(pick(got[2]).slice(3), [700, 0, 10, 1, 1]);
    assert.ok(String(got[2].model).startsWith("deepseek"));
    assert.deepEqual(pick(got[3]), ["retro", "gateway", "m-gw", 900, 500, 30, 1, 1]);
    assert.equal(got[3].usd, estimateUsd("gateway", "m-gw", 900, 500, 30));
    // (o gpt-5-codex já foi recusado neste processo → o planejado agora é o padrão do Codex)
    assert.deepEqual([got[4].engine, got[4].ok], ["codex", 0]);
    assert.notEqual(got[4].model, "claude-sonnet-5", "falha de outro motor nunca leva o modelo do Claude");
  } finally { srv.close(); H.cleanup(); }
});

test("livro quebrado não muda o resultado; sem CARDUME_USAGE_DB nos testes nada é gravado", POSIX, async () => {
  const H = tempHome({ aiEngine: "claude" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  const claude = script(bin, "claude", `echo '{"type":"result","is_error":false,"result":"SKIP"}'\n`);
  try {
    writeFileSync(join(H.home, "arquivo"), "x");
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_USAGE_DB: join(H.home, "arquivo", "u.sqlite") }, () =>
      aiOnce("x", { tier: "capaz", timeout: 10_000, usage: { source: "retro" } }, { avail: { claude: true } }));
    assert.equal(out, "SKIP");
    await withEnv({ CARDUME_USAGE_DB: undefined }, () => recordUsage({ source: "outros", engine: "claude" }));
  } finally { H.cleanup(); }
});
