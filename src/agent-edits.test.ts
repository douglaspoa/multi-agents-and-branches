// node --test src/agent-edits.test.ts  (npm test)
// O agente muda a SPEC de outra tarefa / do épico SEM acionar ninguém (src/agent-edits.ts, CLI task/epic edit,
// MCP edit_task/edit_epic). Pastas TEMPORÁRIAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import { editEpic, editTask, undoTaskEdit } from "./agent-edits.ts";

const EPIC = "11111111-2222-3333-4444-555555555555";
const mk = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({
    id, title: "Tarefa " + id, objective: "objetivo antigo de " + id, agent: "Orion", roles: [], engine: "mock",
    deliverables: ["entrega " + id], requirements: ["req A", "req B"], scope: { owns: ["src/a/**"], offLimits: [] },
    autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "auto" },
    ...extra,
  }) as TaskSpec;

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "starfork-edit-"));
  const dir = join(repo, ".cardume");
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "state.sqlite"));
  const add = (id: string, status: string, extra: Partial<TaskSpec> = {}) => {
    const wt = join(dir, "worktrees", id);
    mkdirSync(join(wt, ".cardume"), { recursive: true });
    store.createTask(mk(id, extra), "feat/" + id, wt, "main");
    store.setStatus(id, status as never);
    return wt;
  };
  return { repo, dir, store, add, done: () => { try { store.close(); } catch { /* já fechado */ } rmSync(repo, { recursive: true, force: true }); } };
}
const specOf = (s: Store, id: string) => JSON.parse(s.getTask(id)!.spec_json) as TaskSpec;
const queued = (s: Store, id: string) => (s.db.prepare("SELECT COUNT(*) AS n FROM work_queue WHERE task_id = ?").get(id) as { n: number }).n;

test("irmã parada: spec + colunas + TASK.yaml mudam, rastro nas duas conversas, NENHUM turno enfileirado", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const wt = e.add("irma", "review", { epicId: EPIC });
    const r = editTask({
      store: e.store, cardumeDir: e.dir, targetId: "irma", epicId: EPIC,
      by: { agent: "Orion", taskId: "autor", taskTitle: "Tarefa autor" },
      input: { objective: "objetivo NOVO", reqAdd: ["req C"], reqRemove: [1], note: "a API mudou de formato" },
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.mode, "applied");
    const sp = specOf(e.store, "irma");
    assert.equal(sp.objective, "objetivo NOVO");
    assert.deepEqual(sp.requirements, ["req B", "req C"]);
    assert.equal(e.store.getTask("irma")!.objective, "objetivo NOVO", "coluna acompanha (a lista do app lê daqui)");
    assert.equal(sp.agentEdits?.length, 1);
    assert.equal(sp.agentEdits![0].by, "Orion");
    assert.equal(sp.agentEdits![0].note, "a API mudou de formato");
    assert.equal(sp.agentEdits![0].changes.find((c) => c.field === "objective")!.before, "objetivo antigo de irma");
    const yaml = readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8");
    assert.match(yaml, /objetivo NOVO/);
    assert.match(yaml, /req C/);
    const ev = e.store.eventsForTask("irma").find((x) => x.type === "spec-edit")!;
    assert.match(ev.text, /^Orion \(tarefa Tarefa autor\) atualizou esta tarefa: .*motivo: a API mudou de formato · edição [0-9a-f-]{36}$/);
    assert.ok(e.store.eventsForTask("autor").some((x) => /^tarefa atualizada/.test(x.text)));
    assert.equal(e.store.openInstructions("irma").length, 0, "parada: não precisa de recado");
    assert.equal(queued(e.store, "irma"), 0, "NUNCA vira turno do agente");
    assert.equal(e.store.getTask("irma")!.status, "review", "status intocado");
  } finally { e.done(); }
});

test("irmã RODANDO: mudança gravada + recado pro PRÓXIMO turno (instrução), sem fila de trabalho", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    e.add("irma", "running", { epicId: EPIC });
    const r = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by: { agent: "Orion", taskId: "autor" }, input: { title: "Título novo", note: "nome melhor" } });
    assert.equal(r.ok && r.mode, "queued");
    const ins = e.store.openInstructions("irma");
    assert.equal(ins.length, 1);
    assert.match(ins[0].text, /ATUALIZOU a spec.*Título novo.*releia/s);
    assert.equal(queued(e.store, "irma"), 0);
    assert.equal(e.store.getTask("irma")!.title, "Título novo");
    assert.equal(specOf(e.store, "irma").agentEdits![0].delivered, "queued");
  } finally { e.done(); }
});

test("guarda-corpos: mergeada/concluída recusada; sem motivo, segredo e texto longo recusados; mesmo valor = nada mudou", () => {
  const e = setup();
  try {
    e.add("m", "merged");
    e.add("d", "done");
    e.add("x", "draft");
    const by = { agent: "Orion" };
    const m = editTask({ store: e.store, cardumeDir: e.dir, targetId: "m", by, input: { objective: "y", note: "z" } });
    assert.equal(m.ok, false);
    assert.match(m.message, /mergeada/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "d", by, input: { objective: "y", note: "z" } }).message, /concluída/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "y" } }).message, /PORQUÊ/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { reqAdd: ["API_KEY=sk_live_abcdefgh12345"], note: "z" } }).message, /segredo/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "a".repeat(2001), note: "z" } }).message, /longo demais/);
    const same = editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "objetivo antigo de x", note: "z" } });
    assert.equal(same.ok && same.mode, "unchanged");
    assert.equal(specOf(e.store, "x").agentEdits, undefined);
    // rascunho (draft) edita normal
    assert.equal(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { owns: ["src/b/**"], note: "z" } }).ok, true);
    assert.deepEqual(specOf(e.store, "x").scope.owns, ["src/b/**"]);
  } finally { e.done(); }
});

test("irmã só na nuvem (backlog do time): vira pendência de cartão, idempotente; sem épico → erro", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const by = { agent: "Orion", taskId: "autor" };
    const input = { objective: "outro jeito", note: "descobri X" };
    const a = editTask({ store: e.store, cardumeDir: e.dir, targetId: "aaaaaaaa-0000-0000-0000-000000000001", by, input, epicId: EPIC });
    assert.equal(a.ok && a.mode, "pending");
    const b = editTask({ store: e.store, cardumeDir: e.dir, targetId: "aaaaaaaa-0000-0000-0000-000000000001", by, input, epicId: EPIC });
    assert.equal(a.ok && b.ok && a.id, b.ok && b.id, "mesmo pedido repetido não duplica");
    const f = join(e.dir, "agent-edits", "card-aaaaaaaa-0000-0000-0000-000000000001.jsonl");
    const lines = readFileSync(f, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.kind, "card");
    assert.equal(row.epicId, EPIC);
    assert.equal(row.task.objective, "outro jeito");
    assert.equal(row.by.agent, "Orion");
    const semEpico = editTask({ store: e.store, cardumeDir: e.dir, targetId: "nao-existe", by: { agent: "Orion" }, input });
    assert.equal(semEpico.ok, false);
    assert.match(semEpico.message, /não encontrada/);
  } finally { e.done(); }
});

test("épico: pendência pro app (idempotente) + cópia local do 'pronto quando' nas tarefas do épico; épico alheio recusado", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC, epicDoneWhen: ["D1: login funciona", "D2: logout funciona"] });
    const wt = e.add("irma", "running", { epicId: EPIC, epicDoneWhen: ["D1: login funciona", "D2: logout funciona"] });
    e.add("velha", "merged", { epicId: EPIC, epicDoneWhen: ["D1: login funciona", "D2: logout funciona"] });
    const by = { agent: "Orion", taskId: "autor", taskTitle: "Tarefa autor" };
    const input = { description: "agora com SSO", doneWhenAdd: ["SSO funciona"], doneWhenRemove: ["d2"], note: "o time decidiu SSO" };
    const r = editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by, input });
    assert.equal(r.ok && r.mode, "pending");
    const f = join(e.dir, "agent-edits", `epic-${EPIC}.jsonl`);
    const row = JSON.parse(readFileSync(f, "utf8").trim());
    assert.equal(row.kind, "epic");
    assert.equal(row.epic.description, "agora com SSO");
    assert.deepEqual(row.epic.doneWhenRemove, ["D2"]);
    assert.equal(row.note, "o time decidiu SSO");
    assert.deepEqual(specOf(e.store, "irma").epicDoneWhen, ["D1: login funciona", "D3: SSO funciona"]);
    assert.match(readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8"), /D3: SSO funciona/);
    assert.equal(e.store.openInstructions("irma").length, 1, "irmã rodando recebe no próximo turno");
    assert.equal(e.store.openInstructions("autor").length, 0, "quem editou não recebe recado de si mesmo");
    assert.deepEqual(specOf(e.store, "velha").epicDoneWhen, ["D1: login funciona", "D2: logout funciona"], "mergeada não muda");
    // repetir = nada novo
    const again = editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by, input });
    assert.equal(again.ok && again.id, r.ok && r.id);
    assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 1);
    assert.equal(e.store.openInstructions("irma").length, 1);
    const alheio = editEpic({ store: e.store, cardumeDir: e.dir, epicId: "outro-epico", by, input });
    assert.equal(alheio.ok, false);
    assert.match(alheio.message, /não é deste projeto/);
    assert.match(editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by, input: { doneWhenRemove: ["X9"], note: "z" } }).message, /id inválido/);
  } finally { e.done(); }
});

test("desfazer: volta o campo; campo que mudou de novo depois → recusa", () => {
  const e = setup();
  try {
    e.add("irma", "review");
    const by = { agent: "Orion", taskId: "autor" };
    const r1 = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, input: { objective: "v2", note: "a" } });
    const u = undoTaskEdit({ store: e.store, targetId: "irma", editId: r1.ok ? r1.id! : "", by: { agent: "Você" } });
    assert.equal(u.ok, true);
    assert.equal(specOf(e.store, "irma").objective, "objetivo antigo de irma");
    assert.equal(e.store.getTask("irma")!.objective, "objetivo antigo de irma");
    assert.ok(specOf(e.store, "irma").agentEdits![0].undone);
    const r2 = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, input: { objective: "v3", note: "b" } });
    editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, input: { objective: "v4", note: "c" } });
    const u2 = undoTaskEdit({ store: e.store, targetId: "irma", editId: r2.ok ? r2.id! : "", by: { agent: "Você" } });
    assert.equal(u2.ok, false);
    assert.match(u2.message, /mudou de novo/);
  } finally { e.done(); }
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const node = (args: string[], env: Record<string, string> = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } }) };
  } catch (err) {
    const x = err as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: x.stdout + x.stderr };
  }
};

test("CLI: `task edit` e `epic edit` gravam sem acionar agente; --json devolve o resultado; mergeada sai com erro", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC, epicDoneWhen: ["D1: a"] });
    e.add("irma", "draft", { epicId: EPIC });
    e.add("m", "merged");
    e.store.close();
    const env = { CARDUME_AGENT: "Orion", CARDUME_TASK: "autor" };
    const ok = node(["task", "edit", "irma", "--objective", "via CLI", "--req-add", "novo req", "--note", "ideia mudou", "--json", "--repo", e.repo], env);
    assert.equal(ok.code, 0, ok.out);
    const j = JSON.parse(ok.out.trim());
    assert.equal(j.ok, true);
    assert.equal(j.mode, "applied");
    const bad = node(["task", "edit", "m", "--objective", "x", "--note", "y", "--repo", e.repo], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /mergeada/);
    const ep = node(["epic", "edit", EPIC, "--done-when-add", "b funciona", "--note", "faltava", "--repo", e.repo], env);
    assert.equal(ep.code, 0, ep.out);
    assert.ok(existsSync(join(e.dir, "agent-edits", `epic-${EPIC}.jsonl`)));
    // --patch (o app manda a edição inteira) + --undo
    const s = new Store(join(e.dir, "state.sqlite"));
    const sp = specOf(s, "irma");
    s.close();
    assert.equal(sp.objective, "via CLI");
    assert.ok(sp.requirements.includes("novo req"));
    const u = node(["task", "edit", "irma", "--undo", sp.agentEdits![0].id, "--json", "--by-agent", "Você", "--repo", e.repo]);
    assert.equal(JSON.parse(u.out.trim()).ok, true, u.out);
    const p = node(["task", "edit", "irma", "--patch", JSON.stringify({ deliverables: ["X", "Y"], note: "reorganizei" }), "--json", "--repo", e.repo], env);
    assert.equal(JSON.parse(p.out.trim()).ok, true, p.out);
    const s2 = new Store(join(e.dir, "state.sqlite"));
    assert.deepEqual(specOf(s2, "irma").deliverables, ["X", "Y"]);
    assert.equal(specOf(s2, "irma").objective, "objetivo antigo de irma");
    assert.equal(s2.getTask("irma")!.status, "draft", "rascunho continua rascunho");
    assert.equal(queued(s2, "irma"), 0);
    s2.close();
  } finally { e.done(); }
});

test("MCP: tools edit_task/edit_epic listadas e funcionando pelo servidor do agente", async () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    e.add("irma", "review", { epicId: EPIC });
    const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./mcp/server.ts", import.meta.url))], {
      env: { ...process.env, CARDUME_DB: join(e.dir, "state.sqlite"), CARDUME_TASK: "autor", CARDUME_AGENT: "Orion", CARDUME_ROLE: "builder" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const replies: Record<number, any> = {};
    srv.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* */ } }
    });
    const call = async (id: number, method: string, params: unknown) => {
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      for (let k = 0; k < 100 && !replies[id]; k++) await new Promise((r) => setTimeout(r, 50));
      return replies[id];
    };
    const list = await call(1, "tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("edit_task") && names.includes("edit_epic"));
    const r = await call(2, "tools/call", { name: "edit_task", arguments: { task_id: "irma", objective: "pelo MCP", note: "ajuste" } });
    assert.equal(r.result.isError, false, JSON.stringify(r));
    const r2 = await call(3, "tools/call", { name: "edit_epic", arguments: { epic_id: EPIC, description: "nova", note: "ajuste" } });
    assert.equal(r2.result.isError, false, JSON.stringify(r2));
    srv.stdin.end();
    await new Promise((r) => srv.on("close", r));
    assert.equal(specOf(e.store, "irma").objective, "pelo MCP");
    assert.equal(specOf(e.store, "irma").agentEdits![0].byTask, "autor");
    assert.equal(readdirSync(join(e.dir, "agent-edits")).filter((f) => f.startsWith("epic-")).length, 1);
  } finally { e.done(); }
});
