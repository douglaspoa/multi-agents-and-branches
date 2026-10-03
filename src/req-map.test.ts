// Mapa requisito → trechos (Revisão por requisito): `node --test src/req-map.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCode, cleanTests, mergeReqMap, normFile, normLines } from "./req-map.ts";

test("normLines aceita faixa, linha única e lista; recusa lixo", () => {
  assert.equal(normLines("12-30"), "12-30");
  assert.equal(normLines("12 – 30"), "12-30");
  assert.equal(normLines("7"), "7");
  assert.equal(normLines([3, 9]), "3-9");
  assert.equal(normLines(""), "");
  assert.equal(normLines(undefined), "");
  assert.equal(normLines("30-12"), null, "fim antes do início");
  assert.equal(normLines("linhas 3 a 9"), null);
});
test("normFile tira ./ e recusa absoluto e ..", () => {
  assert.equal(normFile("./src/a.ts"), "src/a.ts");
  assert.equal(normFile("/etc/passwd"), null);
  assert.equal(normFile("src/../../x"), null);
  assert.deepEqual(cleanCode([{ file: "./a.ts", lines: "1-2" }, { file: "b.ts" }, { file: "/x" }, { file: "c.ts", lines: "zz" }]), [{ file: "a.ts", lines: "1-2" }, { file: "b.ts" }]);
  assert.deepEqual(cleanTests([{ name: " t1 ", status: "pass" }, { name: "t2", status: "??" }, { name: "" }]), [{ name: "t1", status: "pass" }, { name: "t2", status: "missing" }]);
});
test("mergeReqMap casa pelo texto e não mexe na prova", () => {
  const cur = [{ req: "Botão remarcar em cada aula", status: "done", evidence: ["p.png"], note: "ok" }];
  const { list, entry } = mergeReqMap(cur, { req: "botão REMARCAR em cada aula", did: "pus o botão", code: [{ file: "src/A.tsx", lines: "84-88" }], tests: [{ name: "a › b", status: "pass" }] });
  assert.equal(list.length, 1);
  assert.equal(entry.status, "done");
  assert.deepEqual(entry.evidence, ["p.png"]);
  assert.equal(entry.did, "pus o botão");
  assert.deepEqual(entry.code, [{ file: "src/A.tsx", lines: "84-88" }]);
  // requisito ainda não listado entra como "pending" (sem prova — o portão continua cobrando)
  const r2 = mergeReqMap(list, { req: "Aviso de confirmação", code: [] });
  assert.equal(r2.list.length, 2);
  assert.equal(r2.entry.status, "pending");
  assert.deepEqual(r2.entry.evidence, []);
  // arquivo lixo vira lista vazia, não quebra
  assert.deepEqual(mergeReqMap("lixo", { req: "x", code: [{ file: "a" }] }).list.length, 1);
});

// ---- a tool MCP de verdade (servidor do agente): grava o mapa SEM apagar as provas dos outros requisitos ----
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";

async function mcpCalls(db: string, calls: [string, unknown][]) {
  const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./mcp/server.ts", import.meta.url))], {
    env: { ...process.env, CARDUME_DB: db, CARDUME_TASK: "t1", CARDUME_AGENT: "Íris", CARDUME_ROLE: "builder" }, stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = ""; const replies: Record<number, any> = {};
  srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* */ } } });
  const out: any[] = []; let id = 0;
  for (const [method, params] of calls) {
    const my = ++id; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    for (let k = 0; k < 100 && !replies[my]; k++) await new Promise((r) => setTimeout(r, 50));
    out.push(replies[my]);
  }
  srv.stdin.end(); await new Promise((r) => srv.on("close", r));
  return out;
}

test("MCP map_requirement: preserva status/evidência, recusa requisito que não existe e JSON quebrado, aceita a forma {list}", async () => {
  const repo = mkdtempSync(join(tmpdir(), "starfork-reqmap-"));
  try {
    const dir = join(repo, ".cardume"); mkdirSync(dir, { recursive: true });
    const store = new Store(join(dir, "state.sqlite"));
    const wt = join(dir, "worktrees", "t1"); mkdirSync(join(wt, ".cardume", "artifacts"), { recursive: true });
    store.createTask({ id: "t1", title: "T", objective: "o", agent: "Íris", roles: [], engine: "mock", deliverables: [], requirements: ["Botão remarcar", "Aviso por e-mail"], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "auto" } } as unknown as TaskSpec, "feat/t1", wt, "main");
    store.close();
    const file = join(wt, ".cardume", "artifacts", "requirements.json");
    writeFileSync(file, JSON.stringify([{ req: "Botão remarcar", status: "done", evidence: ["p.png"] }, { req: "Aviso por e-mail", status: "done", evidence: ["e.png"] }]));
    const db = join(dir, "state.sqlite");
    const [list, ok, bad] = await mcpCalls(db, [
      ["tools/list", {}],
      ["tools/call", { name: "map_requirement", arguments: { req: "botão REMARCAR", did: "pus o botão", code: [{ file: "src/A.tsx", lines: "84-88" }], tests: [{ name: "a › b", status: "pass" }] } }],
      ["tools/call", { name: "map_requirement", arguments: { req: "Requisito inventado", code: [] } }],
    ]);
    assert.ok(list.result.tools.some((t: { name: string }) => t.name === "map_requirement"));
    assert.equal(ok.result.isError, false, JSON.stringify(ok));
    assert.equal(bad.result.isError, true, "requisito que não existe é recusado");
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.length, 2, "não criou entrada pro requisito inventado");
    assert.deepEqual(after[0], { req: "Botão remarcar", status: "done", evidence: ["p.png"], did: "pus o botão", code: [{ file: "src/A.tsx", lines: "84-88" }], tests: [{ name: "a › b", status: "pass" }] });
    assert.deepEqual(after[1], { req: "Aviso por e-mail", status: "done", evidence: ["e.png"] }, "a prova do outro requisito ficou intacta");
    // JSON quebrado: não sobrescreve
    writeFileSync(file, "{ quebrado");
    const [broken] = await mcpCalls(db, [["tools/call", { name: "map_requirement", arguments: { req: "Aviso por e-mail", code: [] } }]]);
    assert.equal(broken.result.isError, true);
    assert.equal(readFileSync(file, "utf8"), "{ quebrado");
    // forma { list: [...] } (o orquestrador também lê assim): mantém a forma
    writeFileSync(file, JSON.stringify({ list: [{ req: "Aviso por e-mail", status: "blocked", evidence: [] }] }));
    const [wrapped] = await mcpCalls(db, [["tools/call", { name: "map_requirement", arguments: { req: "Aviso por e-mail", code: [{ file: "src/api.ts" }] } }]]);
    assert.equal(wrapped.result.isError, false, JSON.stringify(wrapped));
    const w = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(w.list[0].status, "blocked"); assert.deepEqual(w.list[0].code, [{ file: "src/api.ts" }]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
