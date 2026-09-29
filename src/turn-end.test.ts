// node --test src/turn-end.test.ts  (npm test)
// Pergunta órfã (29/09, logcomex-ai-v2): o agente perguntou, desistiu de esperar e fechou o turno — a pergunta
// seguiu 'open' e a resposta do humano ia pro vazio ("enviada · aguardando o agente" pra sempre).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import { mapTool } from "./engine/claude.ts";

const spec = (id: string) => ({ id, title: id, objective: "o", agent: "A", roles: [], engine: "mock" }) as unknown as TaskSpec;

test("fim do turno fecha só as PERGUNTAS abertas da tarefa (desempate de posse fica)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starfork-turn-"));
  const store = new Store(join(dir, "state.sqlite"));
  try {
    store.createTask(spec("t"), "b", dir, "main");
    store.createTask(spec("u"), "b", dir, "main");
    const q = store.addPending("t", "A", "question", "posso seguir?");
    const tb = store.addPending("t", "A", "tiebreak", "quem fica?", ["A", "B"]);
    const other = store.addPending("u", "A", "question", "e aqui?");
    assert.equal(store.closeOpenQuestions("t"), 1);
    assert.equal(store.getPending(q)!.status, "answered");
    assert.match(String(store.getPending(q)!.answer), /turno terminou/);
    assert.equal(store.getPending(tb)!.status, "open");
    assert.equal(store.getPending(other)!.status, "open", "não mexe na pergunta de outra tarefa");
    assert.equal(store.closeOpenQuestions("t"), 0, "idempotente");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busca/listagem/web viram frase (a faixa ao vivo diferencia de arquivo lido)", () => {
  assert.deepEqual(mapTool("Grep", { pattern: "use_cases", path: "backend" }), { type: "read", text: 'buscando "use_cases" em backend' });
  assert.deepEqual(mapTool("Grep", { pattern: "x" }), { type: "read", text: 'buscando "x"' });
  assert.deepEqual(mapTool("Glob", { pattern: "**/*.py" }), { type: "read", text: "listando **/*.py" });
  assert.equal(mapTool("WebFetch", { url: "https://a.b" }).text, "consultando https://a.b");
  assert.deepEqual(mapTool("Read", { file_path: "/r/app/main.py" }), { type: "read", text: "/r/app/main.py" });
  assert.equal(mapTool("Bash", { command: "npm test" }).type, "bash");
});
