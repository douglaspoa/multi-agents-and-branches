// Formato da pergunta ao humano (src/ask-style.ts): a regra única chega em todo prompt que pergunta e o ask_human aceita
// `context` sem quebrar a chamada antiga (só question + options). `node --test src/ask-style.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_STYLE, askContextText, askPending } from "./ask-style.ts";
import { callTool, TOOLS } from "./mcp/tools.ts";
import { Store } from "./store.ts";
import { INTEGRADO_RULE, shellInstructions } from "./terminal-integrado.ts";

test("regra única: 1 frase com '?', contexto em 3–5 tópicos, opção = rótulo + descrição", () => {
  assert.match(ASK_STYLE, /UMA frase curta terminando em '\?'/);
  assert.match(ASK_STYLE, /3–5 tópicos curtos/);
  assert.match(ASK_STYLE, /`label` \+ `description`/);
  assert.match(ASK_STYLE, /'Rótulo — descrição'/);
});

test("a regra está em todo lugar que manda perguntar: motor Claude, DeepSeek, conversa, terminal integrado, tool", () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(src("./engine/claude.ts"), /fora do seu escopo\)\.\$\{ASK_STYLE\}/);
  assert.match(src("./engine/dsh.ts"), /sem um requisito\." \+ ASK_STYLE;/);
  assert.match(src("./orchestrator.ts"), /CHAT_RULE_ASK =\n[^\n]*" \+ ASK_STYLE;/);
  assert.ok(INTEGRADO_RULE.includes(ASK_STYLE), "CLAUDE (append-system-prompt) do terminal");
  assert.ok(shellInstructions().includes(ASK_STYLE), "AGENTS.md / GEMINI.md");
  const ask = TOOLS.find((t) => t.name === "ask_human")!;
  assert.match(ask.description, /UMA frase curta terminando em '\?'/);
  assert.deepEqual(ask.inputSchema.required, ["question"], "context/options seguem opcionais");
  assert.equal((ask.inputSchema.properties as unknown as Record<string, { type: string }>).context.type, "string");
});

test("askPending: sem contexto = a pergunta de sempre (sem meta); com contexto = pergunta, linha em branco, tópicos + meta.question", () => {
  assert.deepEqual(askPending("  Qual banco?  "), { prompt: "Qual banco?" });
  assert.deepEqual(askPending("Qual banco?", "  "), { prompt: "Qual banco?" });
  assert.deepEqual(askPending("Qual banco?", { x: 1 }), { prompt: "Qual banco?" }, "tipo estranho = sem contexto");
  assert.deepEqual(askPending("Rodo de novo?", "- a migration falhou\n- log em .cardume/tmp/m.log"), { prompt: "Rodo de novo?\n\n- a migration falhou\n- log em .cardume/tmp/m.log", meta: { src: "ask", question: "Rodo de novo?" } });
  assert.equal(askContextText(["falhou", "- já tentei 2x", "", 3]), "- falhou\n- já tentei 2x");
});

test("ask_human e `starfork perguntar --contexto` gravam pergunta + contexto + meta no pending (sem bullet duplo)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-ask-"));
  const keys = ["CARDUME_DB", "CARDUME_TASK", "CARDUME_AGENT", "CARDUME_AUTOPILOT"] as const;
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    const db = join(dir, "state.sqlite");
    new Store(db).close();
    Object.assign(process.env, { CARDUME_DB: db, CARDUME_TASK: "t1", CARDUME_AGENT: "Íris", CARDUME_AUTOPILOT: "1" });
    const { starforkCli } = await import("./starfork-cli.ts");
    const outs: string[] = [];
    assert.equal(await starforkCli(["perguntar", "Rodo de novo?", "--contexto", "a migration falhou", "--contexto", "- log em m.log", "--opcao", "Rodar — tenta mais 1x"], { out: (s) => outs.push(s), err: (s) => outs.push(s) }), 0, outs.join("\n"));
    const st = new Store(db);
    try {
      const row = st.db.prepare("SELECT prompt, options, meta FROM pending ORDER BY id DESC LIMIT 1").get() as { prompt: string; options: string; meta: string };
      assert.equal(row.prompt, "Rodo de novo?\n\n- a migration falhou\n- log em m.log");
      assert.deepEqual(JSON.parse(row.meta), { src: "ask", question: "Rodo de novo?" });
      assert.deepEqual(JSON.parse(row.options), ["Rodar — tenta mais 1x"]);
      const ctx = { store: st, db, task: "t1", agent: "Íris", role: "builder", orch: async () => { throw new Error("sem orq"); } };
      await callTool(ctx as never, "ask_human", { question: "Qual banco?", options: ["pg"] });
      const plain = st.db.prepare("SELECT prompt, meta FROM pending ORDER BY id DESC LIMIT 1").get() as { prompt: string; meta: string | null };
      assert.deepEqual([plain.prompt, plain.meta], ["Qual banco?", null], "chamada antiga: igual a antes");
    } finally { st.close(); }
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
