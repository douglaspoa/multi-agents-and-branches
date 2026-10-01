// node --test src/usage-ledger.test.ts  (npm test)
// Livro de uso (aba Uso) no motor: esquema e normalização IGUAIS ao Rust (golden tests/fixtures/usage-golden/), tabela
// única de preço, turno de tarefa gravado no livro com o mesmo `at` do `cost`, retro/IA auxiliar gravando com custo do
// JSON do Claude (texto devolvido igual) e livro quebrado sem afetar a chamada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_SCHEMA, estimateUsd, normEngine, normSource, pricePerM, recordUsage, recordUsageIn } from "./usage-ledger.ts";
import { aiOnce, claudeOnceText } from "./ai-once.ts";
import { Store } from "./store.ts";
import { tempHome } from "./testing/temp-home.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (scripts falsos com shebang)" : false };
const golden = (f: string) => readFileSync(new URL("../tests/fixtures/usage-golden/" + f, import.meta.url), "utf8");
const rows = (file: string) => {
  const db = new DatabaseSync(file);
  try { return db.prepare("SELECT * FROM ai_usage ORDER BY id").all() as any[]; } finally { db.close(); }
};
const tmp = () => mkdtempSync(join(tmpdir(), "sf-usage-ts-"));

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test("esquema igual ao golden (≡ Rust)", () => {
  assert.equal(USAGE_SCHEMA.trim(), golden("schema.sql").trim());
});

test("normalização igual ao golden (≡ Rust)", () => {
  const d = tmp();
  try {
    const file = join(d, "u.sqlite");
    const g = JSON.parse(golden("normalize.json"));
    g.cases.forEach((c: any, i: number) => {
      const x = c.in;
      recordUsageIn(file, { at: 1000 + i, source: x.source, engine: x.engine, model: x.model, inTok: x.in_tok, outTok: x.out_tok, usd: x.usd, claudeSession: x.claude_session, claudeTotal: x.claude_total });
    });
    const got = rows(file);
    assert.equal(got.length, g.cases.length);
    got.forEach((r, i) => {
      const o = g.cases[i].out;
      assert.equal(r.source, o.source, `caso ${i}`);
      assert.equal(r.engine, o.engine, `caso ${i}`);
      assert.ok(Math.abs(r.usd - o.usd) < 1e-9, `caso ${i}: ${r.usd} vs ${o.usd}`);
      assert.equal(r.usd_estimated, o.usd_estimated, `caso ${i}`);
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("tabela de preço única (src/usage-prices.json)", () => {
  const p = JSON.parse(readFileSync(new URL("./usage-prices.json", import.meta.url), "utf8"));
  for (const e of ["claude", "codex", "deepseek", "gateway"]) assert.equal(pricePerM(e), p.perMillion[e]);
  assert.equal(pricePerM("outro-motor"), p.fallback);
  assert.equal(estimateUsd("deepseek", "", 500_000, 500_000), p.perMillion.deepseek);
  assert.equal(normSource("xyz"), "outros");
  assert.equal(normEngine("Codex (gpt-5)"), "codex");
  assert.equal(normEngine("dsh-flash"), "deepseek");
});

test("Store.addCost: turno da tarefa vai pro livro com o MESMO at do cost (projeto real só)", async () => {
  const d = tmp();
  try {
    const file = join(d, "u.sqlite");
    const repo = join(d, "proj");
    mkdirSync(join(repo, ".cardume"), { recursive: true });
    await withEnv({ CARDUME_USAGE_DB: file }, () => {
      const s = new Store(join(repo, ".cardume", "state.sqlite"));
      s.addCost("t1", "Coder", "builder", 0.25, 100, 20, 1500, "claude", "claude-sonnet-5");
      s.addCost("t1", "Revisor", "reviewer", 0, 3000, 1000, 800, "codex", "gpt-5-codex");
      const cost = s.db.prepare("SELECT created_at FROM cost ORDER BY id").all() as any[];
      s.close();
      const got = rows(file);
      assert.equal(got.length, 2);
      assert.deepEqual(got.map((r) => [r.source, r.task_id, r.role, r.engine, r.project, r.usd_estimated]), [
        ["tarefa", "t1", "Coder", "claude", repo, 0],
        ["tarefa", "t1", "Revisor", "codex", repo, 1],
      ]);
      assert.equal(got[0].usd, 0.25);
      assert.equal(got[1].usd, estimateUsd("codex", "gpt-5-codex", 3000, 1000));
      assert.deepEqual(got.map((r) => r.at), cost.map((c) => c.created_at), "mesmo at = a aba não duplica o histórico");
      // banco fora de .cardume (teste/temporário): não grava no livro
      const s2 = new Store(join(d, "solto.sqlite"));
      s2.addCost("t2", "A", "builder", 1, 1, 1, 1);
      s2.close();
      assert.equal(rows(file).length, 2);
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("claudeOnceText: mesmo texto do -p puro, custo do JSON", () => {
  const acc = { inTok: 0, outTok: 0, usd: 0 };
  assert.equal(claudeOnceText(`{"type":"result","is_error":false,"result":" ok \\n","total_cost_usd":0.01,"usage":{"input_tokens":3,"cache_read_input_tokens":7,"output_tokens":2}}`, acc), "ok");
  assert.deepEqual(acc, { inTok: 10, outTok: 2, usd: 0.01 });
  assert.equal(claudeOnceText("texto puro\n"), "texto puro");
  assert.throws(() => claudeOnceText(`{"is_error":true,"result":"Failed to authenticate"}`), /Failed to authenticate/);
});

test("aiOnce (retro) grava no livro com o custo informado pelo Claude; livro quebrado não muda o resultado", POSIX, async () => {
  const H = tempHome({ aiEngine: "claude" });
  const bin = join(H.home, "bin"); mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"SKIP","session_id":"s1","total_cost_usd":0.002,"usage":{"input_tokens":40,"output_tokens":3}}'\n`);
  chmodSync(claude, 0o755);
  const file = join(H.home, "usage.sqlite");
  try {
    const out = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_USAGE_DB: file }, () =>
      aiOnce("x", { tier: "capaz", claudeModel: "claude-sonnet-5", timeout: 10_000, usage: { source: "retro", project: "/repo/x", taskId: "t9" } }, { avail: { claude: true } }));
    assert.equal(out, "SKIP");
    const got = rows(file);
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].source, got[0].engine, got[0].model, got[0].task_id, got[0].project, got[0].in_tok, got[0].out_tok, got[0].usd, got[0].usd_estimated, got[0].ok],
      ["retro", "claude", "claude-sonnet-5", "t9", "/repo/x", 40, 3, 0.002, 0, 1]);
    // livro impossível de abrir: a chamada devolve o mesmo
    writeFileSync(join(H.home, "arquivo"), "x");
    const out2 = await withEnv({ HOME: H.home, CARDUME_CLAUDE: claude, CARDUME_USAGE_DB: join(H.home, "arquivo", "u.sqlite") }, () =>
      aiOnce("x", { tier: "capaz", timeout: 10_000, usage: { source: "retro" } }, { avail: { claude: true } }));
    assert.equal(out2, "SKIP");
    // sem CARDUME_USAGE_DB nos testes: nada é gravado no livro de verdade
    await withEnv({ CARDUME_USAGE_DB: undefined }, () => recordUsage({ source: "outros", engine: "claude" }));
  } finally { H.cleanup(); }
});
