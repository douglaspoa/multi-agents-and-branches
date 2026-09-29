// node --test src/agent-edits.test.ts  (npm test)
// O agente muda a SPEC de outra tarefa / do épico SEM acionar ninguém (src/agent-edits.ts, CLI task/epic edit,
// MCP edit_task/edit_epic). Remoção vira PROPOSTA; revisor não edita. Pastas TEMPORÁRIAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import { decideProposal, editEpic, editTask, nextDoneId, syncEpicDoneWhen, undoTaskEdit } from "./agent-edits.ts";

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
const instr = (s: Store, id: string, st: string) => (s.db.prepare("SELECT COUNT(*) AS n FROM instruction WHERE task_id = ? AND status = ?").get(id, st) as { n: number }).n;
const B = { agent: "Orion", taskId: "autor", taskTitle: "Tarefa autor", role: "builder" };

test("irmã parada: acrescentar/reescrever aplica (spec, colunas, TASK.yaml, rastro); remoção vira PROPOSTA; nenhum turno", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const wt = e.add("irma", "review", { epicId: EPIC });
    const r = editTask({
      store: e.store, cardumeDir: e.dir, targetId: "irma", epicId: EPIC, by: B,
      input: { objective: "objetivo NOVO", reqAdd: ["req C"], reqRemove: ["req a"], note: "a API mudou de formato" },
    });
    assert.equal(r.ok && r.mode, "applied");
    assert.ok(r.ok && r.proposalId, "remoção gerou proposta");
    const sp = specOf(e.store, "irma");
    assert.equal(sp.objective, "objetivo NOVO");
    assert.deepEqual(sp.requirements, ["req A", "req B", "req C"], "req A NÃO sai sem aprovação");
    assert.equal(e.store.getTask("irma")!.objective, "objetivo NOVO");
    assert.equal(sp.agentEdits![0].changes.find((c) => c.field === "objective")!.before, "objetivo antigo de irma");
    assert.deepEqual(sp.agentProposals![0].remove, { requirements: ["req A"] });
    assert.equal(sp.agentProposals![0].status, "open");
    const yaml = readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8");
    assert.match(yaml, /objetivo NOVO/);
    assert.match(yaml, /req A/);
    const evs = e.store.eventsForTask("irma");
    assert.match(evs.find((x) => x.type === "spec-edit")!.text, /^Orion \(tarefa Tarefa autor\) atualizou esta tarefa: .*motivo: a API mudou de formato · edição [0-9a-f-]{36}$/);
    assert.match(evs.find((x) => x.type === "spec-proposal")!.text, /propõe remover desta tarefa: requisito "req A" — motivo: .* · proposta [0-9a-f-]{36}$/);
    assert.equal(queued(e.store, "irma"), 0, "NUNCA vira turno do agente");
    assert.equal(e.store.getTask("irma")!.status, "review");
  } finally { e.done(); }
});

test("proposta: aprovar aplica (desfazível); recusar registra e avisa o autor; estreitar owns também é proposta", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    e.add("irma", "review", { epicId: EPIC });
    const r = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by: B, input: { reqRemove: ["req B"], owns: ["src/b/**"], note: "B virou outra tarefa" } });
    assert.equal(r.ok && r.mode, "applied", "o acréscimo em owns aplicou");
    assert.ok(r.ok && r.proposalId);
    assert.deepEqual(specOf(e.store, "irma").scope.owns, ["src/a/**", "src/b/**"], "ampliar vale na hora");
    const p = specOf(e.store, "irma").agentProposals![0];
    assert.deepEqual(p.remove, { requirements: ["req B"], owns: ["src/a/**"] });
    const ok = decideProposal({ store: e.store, targetId: "irma", proposalId: p.id, approve: true, by: { agent: "Douglas" } });
    assert.equal(ok.ok, true);
    const sp = specOf(e.store, "irma");
    assert.deepEqual(sp.requirements, ["req A"]);
    assert.deepEqual(sp.scope.owns, ["src/b/**"]);
    assert.equal(sp.agentProposals![0].status, "approved");
    const rec = sp.agentEdits!.at(-1)!;
    assert.equal(rec.approvedBy, "Douglas");
    assert.equal(undoTaskEdit({ store: e.store, targetId: "irma", editId: rec.id, by: { agent: "Douglas" } }).ok, true);
    assert.deepEqual(specOf(e.store, "irma").requirements, ["req A", "req B"]);
    // recusar
    const r2 = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by: B, input: { reqRemove: ["req A"], note: "difícil" } });
    assert.equal(r2.ok && r2.mode, "proposed", "só remoção = só proposta");
    const no = decideProposal({ store: e.store, targetId: "irma", proposalId: r2.ok ? r2.proposalId! : "", approve: false, by: { agent: "Douglas" }, msg: "o requisito fica" });
    assert.equal(no.ok, true);
    assert.equal(specOf(e.store, "irma").agentProposals!.at(-1)!.status, "rejected");
    assert.deepEqual(specOf(e.store, "irma").requirements, ["req A", "req B"]);
    assert.ok(e.store.eventsForTask("autor").some((x) => /foi recusada/.test(x.text)));
    assert.equal(instr(e.store, "autor", "open"), 1, "autor rodando fica sabendo no próximo turno");
  } finally { e.done(); }
});

test("irmã RODANDO: recado pro próximo turno; desfazer CANCELA o recado ainda não entregue", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    e.add("irma", "running", { epicId: EPIC });
    const r = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by: B, input: { title: "Título novo", note: "nome melhor" } });
    assert.equal(r.ok && r.mode, "queued");
    assert.equal(instr(e.store, "irma", "open"), 1);
    assert.equal(queued(e.store, "irma"), 0);
    const u = undoTaskEdit({ store: e.store, targetId: "irma", editId: r.ok ? r.id! : "", by: { agent: "Você" } });
    assert.equal(u.ok, true);
    assert.equal(instr(e.store, "irma", "open"), 0, "o recado cancelado não chega ao agente");
    assert.equal(instr(e.store, "irma", "cancelled"), 1);
    assert.equal(e.store.getTask("irma")!.title, "Tarefa irma");
  } finally { e.done(); }
});

test("guarda-corpos: papel, mergeada/concluída, motivo, segredo, tamanho, spec ilegível, sem mudança", () => {
  const e = setup();
  try {
    e.add("m", "merged");
    e.add("d", "done");
    e.add("x", "draft");
    const by = { agent: "Orion" };
    const rev = editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by: { agent: "Nyx", role: "reviewer" }, input: { objective: "y", note: "z" } });
    assert.equal(rev.ok, false);
    assert.match(rev.message, /revisor não muda spec/);
    assert.equal(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by: { agent: "Vega", role: "planner" }, input: { objective: "pelo planner", note: "z" } }).ok, true);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "m", by, input: { objective: "y", note: "z" } }).message, /mergeada/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "d", by, input: { objective: "y", note: "z" } }).message, /concluída/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "y" } }).message, /PORQUÊ/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { reqAdd: ["API_KEY=sk_live_abcdefgh12345"], note: "z" } }).message, /segredo/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "a".repeat(2001), note: "z" } }).message, /longo demais/);
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { reqAdd: "solto" as unknown as string[], note: "z" } }).message, /lista de textos/);
    const same = editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "pelo planner", note: "z" } });
    assert.equal(same.ok && same.mode, "unchanged");
    e.store.db.prepare("UPDATE task SET spec_json = '{quebrado' WHERE id = 'x'").run();
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "x", by, input: { objective: "y", note: "z" } }).message, /ilegível/);
    assert.equal(e.store.getTask("x")!.spec_json, "{quebrado", "não grava por cima");
  } finally { e.done(); }
});

test("id da fila (editId): aplica uma vez só, mesmo depois de o rastro cortar a edição", () => {
  const e = setup();
  try {
    e.add("irma", "review");
    const by = { agent: "Orion" };
    const a = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, editId: "fila-1", input: { reqAdd: ["X"], note: "n" } });
    assert.equal(a.ok && a.mode, "applied");
    for (let i = 0; i < 12; i++) editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, input: { objective: "v" + i, note: "n" } });
    assert.ok(!specOf(e.store, "irma").agentEdits!.some((r) => r.id === "fila-1"), "saiu do rastro exibido");
    const b = editTask({ store: e.store, cardumeDir: e.dir, targetId: "irma", by, editId: "fila-1", input: { reqAdd: ["X"], note: "n" } });
    assert.equal(b.ok && b.mode, "unchanged");
    assert.match(b.message, /já tinha sido aplicada/);
  } finally { e.done(); }
});

test("irmã só na nuvem: pendência de cartão; dedup só contra PENDENTE (depois de tratada, o mesmo pedido entra de novo)", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const input = { objective: "outro jeito", note: "descobri X" };
    const T = "aaaaaaaa-0000-0000-0000-000000000001";
    const a = editTask({ store: e.store, cardumeDir: e.dir, targetId: T, by: B, input, epicId: EPIC });
    const b = editTask({ store: e.store, cardumeDir: e.dir, targetId: T, by: B, input, epicId: EPIC });
    assert.equal(a.ok && a.mode, "pending");
    assert.equal(a.ok && a.id, b.ok && b.id);
    const f = join(e.dir, "agent-edits", `card-${T}.jsonl`);
    assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 1);
    const row = JSON.parse(readFileSync(f, "utf8").trim());
    assert.equal(row.kind, "card");
    assert.equal(row.by.role, "builder");
    appendFileSync(join(e.dir, "agent-edits", "applied.jsonl"), JSON.stringify({ id: row.id, outcome: "applied" }) + "\n");
    const c = editTask({ store: e.store, cardumeDir: e.dir, targetId: T, by: B, input, epicId: EPIC });
    assert.notEqual(c.ok && c.id, row.id);
    assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 2);
    assert.ok(!existsSync(join(e.dir, "agent-edits", ".lock")), "trava liberada");
    assert.match(editTask({ store: e.store, cardumeDir: e.dir, targetId: "nao-existe", by: { agent: "Orion" }, input }).message, /não encontrada/);
  } finally { e.done(); }
});

test("épico: pendência (remoção = proposta, NÃO sai da cópia local); acréscimo local com D max+1 que não reusa id removido", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC, epicDoneWhen: ["D1: login funciona", "D2: logout funciona"] });
    const wt = e.add("irma", "running", { epicId: EPIC, epicDoneWhen: ["D1: login funciona", "D2: logout funciona"], epicDoneWhenSeq: 3 });
    e.add("velha", "merged", { epicId: EPIC, epicDoneWhen: ["D1: login funciona"] });
    const input = { description: "agora com SSO", doneWhenAdd: ["SSO funciona"], doneWhenRemove: ["d2"], note: "o time decidiu SSO" };
    const r = editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by: B, input });
    assert.equal(r.ok && r.mode, "pending");
    assert.match(r.ok ? r.message : "", /PROPOSTA/);
    const f = join(e.dir, "agent-edits", `epic-${EPIC}.jsonl`);
    const row = JSON.parse(readFileSync(f, "utf8").trim());
    assert.deepEqual(row.epic.doneWhenRemove, ["D2"]);
    assert.deepEqual(specOf(e.store, "autor").epicDoneWhen, ["D1: login funciona", "D2: logout funciona", "D3: SSO funciona"]);
    assert.deepEqual(specOf(e.store, "irma").epicDoneWhen, ["D1: login funciona", "D2: logout funciona", "D4: SSO funciona"], "D3 já existiu (seq): não volta");
    assert.match(readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8"), /D4: SSO funciona/);
    assert.match(e.store.eventsForTask("irma").find((x) => x.type === "spec-edit")!.text, /· edição [0-9a-f-]{36}$/);
    assert.equal(instr(e.store, "irma", "open"), 1);
    assert.deepEqual(specOf(e.store, "velha").epicDoneWhen, ["D1: login funciona"]);
    const again = editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by: B, input });
    assert.equal(again.ok && again.id, r.ok && r.id);
    assert.equal(instr(e.store, "irma", "open"), 1, "repetido não reaplica");
    assert.match(editEpic({ store: e.store, cardumeDir: e.dir, epicId: "outro-epico", by: B, input }).message, /não é deste projeto/);
    assert.match(editEpic({ store: e.store, cardumeDir: e.dir, epicId: EPIC, by: { ...B, role: "reviewer" }, input }).message, /revisor/);
    // o app devolve a lista OFICIAL → cópias locais iguais (idempotente)
    const s1 = syncEpicDoneWhen({ store: e.store, epicId: EPIC, doneWhen: ["D1: login funciona", "D4: SSO funciona"], seq: 4, by: { agent: "Starfork" } });
    assert.equal(s1.ok && s1.mode, "applied");
    assert.deepEqual(specOf(e.store, "irma").epicDoneWhen, ["D1: login funciona", "D4: SSO funciona"]);
    assert.equal(specOf(e.store, "irma").epicDoneWhenSeq, 4);
    const s2 = syncEpicDoneWhen({ store: e.store, epicId: EPIC, doneWhen: ["D1: login funciona", "D4: SSO funciona"], seq: 4, by: { agent: "Starfork" } });
    assert.equal(s2.ok && s2.mode, "unchanged");
  } finally { e.done(); }
});

test("D-id: motor e app alocam o MESMO próximo id (max+1 da lista original, sem reusar removido)", () => {
  const src = readFileSync(new URL("../app/src/js/47-edicoes-agente.js", import.meta.url), "utf8");
  const ctx: Record<string, unknown> = { tickLoop: () => {}, document: { addEventListener: () => {} }, window: {}, state: {}, IC: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.api={ aeNextDoneId, aeApplyEpic };", ctx);
  const api = ctx.api as { aeNextDoneId: (sp: unknown) => number; aeApplyEpic: (sp: unknown, e: unknown, now: string, st: string) => { spec: { doneWhen: { id: string }[] } } };
  const cases: [string[], number][] = [[[], 0], [["D1: a", "D2: b"], 0], [["D1: a", "D2: b"], 3], [["D1: a", "D7: z"], 2]];
  for (const [lines, seq] of cases) {
    const cloud = { doneWhen: lines.map((l) => ({ id: l.split(":")[0], text: l.slice(4) })), doneWhenSeq: seq };
    assert.equal(api.aeNextDoneId(cloud), nextDoneId(lines, seq), JSON.stringify(lines) + " seq " + seq);
  }
  // removido no histórico da nuvem conta como "já visto" (o motor recebe via seq no sync)
  const hist = { doneWhen: [{ id: "D1", text: "a" }], history: [{ changes: [{ field: "doneWhen", op: "remove", item: { id: "D2", text: "b" } }] }] };
  assert.equal(api.aeNextDoneId(hist), 3);
  const r = api.aeApplyEpic(hist, { id: "e", by: { agent: "O" }, epic: { doneWhenAdd: ["c"] }, note: "n" }, "t", "open");
  assert.equal(r.spec.doneWhen.at(-1)!.id, "D3");
});

test("desfazer: campo que mudou de novo depois → recusa", () => {
  const e = setup();
  try {
    e.add("irma", "review");
    const by = { agent: "Orion" };
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
    return { code: 0, out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", env: { ...process.env, CARDUME_ROLE: "", ...env } }) };
  } catch (err) {
    const x = err as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: x.stdout + x.stderr };
  }
};

test("CLI: task edit / epic edit / epic sync; --patch com formato errado é recusado sem apagar listas; approve/reject", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC, epicDoneWhen: ["D1: a"] });
    e.add("irma", "draft", { epicId: EPIC });
    e.add("m", "merged");
    e.store.close();
    const env = { CARDUME_AGENT: "Orion", CARDUME_TASK: "autor", CARDUME_ROLE: "builder" };
    const ok = node(["task", "edit", "irma", "--objective", "via CLI", "--req-add", "novo req", "--req-remove", "req A", "--note", "ideia mudou", "--json", "--repo", e.repo], env);
    const j = JSON.parse(ok.out.trim());
    assert.equal(j.ok, true, ok.out);
    assert.equal(j.mode, "applied");
    assert.ok(j.proposalId);
    const bad = node(["task", "edit", "m", "--objective", "x", "--note", "y", "--repo", e.repo], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /mergeada/);
    const rev = node(["task", "edit", "irma", "--objective", "x", "--note", "y", "--json", "--repo", e.repo], { ...env, CARDUME_ROLE: "reviewer" });
    assert.match(JSON.parse(rev.out.trim()).message, /revisor/);
    const shape = node(["task", "edit", "irma", "--patch", JSON.stringify({ reqAdd: "solto", deliverables: 3, note: "x" }), "--json", "--repo", e.repo]);
    assert.equal(JSON.parse(shape.out.trim()).ok, false);
    assert.equal(shape.code, 1);
    const junk = node(["task", "edit", "irma", "--patch", "{nao json", "--json", "--repo", e.repo]);
    assert.match(JSON.parse(junk.out.trim()).message, /JSON válido/);
    const ep = node(["epic", "edit", EPIC, "--done-when-add", "b funciona", "--note", "faltava", "--repo", e.repo], env);
    assert.equal(ep.code, 0, ep.out);
    assert.ok(existsSync(join(e.dir, "agent-edits", `epic-${EPIC}.jsonl`)));
    let s = new Store(join(e.dir, "state.sqlite"));
    let sp = specOf(s, "irma");
    s.close();
    assert.equal(sp.objective, "via CLI");
    assert.deepEqual(sp.requirements, ["req A", "req B", "novo req"]);
    assert.ok(sp.deliverables.length, "patch errado não apagou entregáveis");
    const ap = node(["task", "edit", "irma", "--approve", j.proposalId, "--json", "--repo", e.repo]);
    assert.equal(JSON.parse(ap.out.trim()).ok, true, ap.out);
    const p2 = node(["task", "edit", "irma", "--patch", JSON.stringify({ deliverables: ["X", "Y"], note: "reorganizei" }), "--edit-id", "fila-9", "--json", "--repo", e.repo], env);
    assert.equal(JSON.parse(p2.out.trim()).mode, "applied");
    const p3 = node(["task", "edit", "irma", "--patch", JSON.stringify({ deliverables: ["X", "Y"], note: "reorganizei" }), "--edit-id", "fila-9", "--json", "--repo", e.repo], env);
    assert.equal(JSON.parse(p3.out.trim()).mode, "unchanged");
    const sy = node(["epic", "sync", EPIC, "--patch", JSON.stringify({ doneWhen: ["D1: a", "D3: c"], seq: 3 }), "--json", "--repo", e.repo]);
    assert.equal(JSON.parse(sy.out.trim()).ok, true, sy.out);
    s = new Store(join(e.dir, "state.sqlite"));
    sp = specOf(s, "irma");
    assert.deepEqual(sp.requirements, ["req B", "novo req"], "aprovada: req A saiu");
    assert.deepEqual(sp.deliverables, ["X", "Y"]);
    assert.deepEqual(specOf(s, "autor").epicDoneWhen, ["D1: a", "D3: c"]);
    assert.equal(s.getTask("irma")!.status, "draft");
    assert.equal(queued(s, "irma"), 0);
    s.close();
  } finally { e.done(); }
});

test("MCP: edit_task (requirements_remove por texto, deliverables_add) e edit_epic (done_when_remove) pelo servidor do agente; revisor barrado", async () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    e.add("irma", "review", { epicId: EPIC });
    const run = async (role: string, calls: [string, unknown][]) => {
      const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./mcp/server.ts", import.meta.url))], {
        env: { ...process.env, CARDUME_DB: join(e.dir, "state.sqlite"), CARDUME_TASK: "autor", CARDUME_AGENT: "Orion", CARDUME_ROLE: role },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let buf = "";
      const replies: Record<number, any> = {};
      srv.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* */ } }
      });
      const out: any[] = [];
      let id = 0;
      for (const [method, params] of calls) {
        const my = ++id;
        srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
        for (let k = 0; k < 100 && !replies[my]; k++) await new Promise((r) => setTimeout(r, 50));
        out.push(replies[my]);
      }
      srv.stdin.end();
      await new Promise((r) => srv.on("close", r));
      return out;
    };
    const [list, t1, t2] = await run("builder", [
      ["tools/list", {}],
      ["tools/call", { name: "edit_task", arguments: { task_id: "irma", objective: "pelo MCP", requirements_remove: ["req B"], deliverables_add: ["doc nova"], note: "ajuste" } }],
      ["tools/call", { name: "edit_epic", arguments: { epic_id: EPIC, description: "nova", done_when_remove: ["D2"], note: "ajuste" } }],
    ]);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("edit_task") && names.includes("edit_epic"));
    assert.equal(t1.result.isError, false, JSON.stringify(t1));
    assert.equal(t2.result.isError, false, JSON.stringify(t2));
    const sp = specOf(e.store, "irma");
    assert.equal(sp.objective, "pelo MCP");
    assert.deepEqual(sp.deliverables, ["entrega irma", "doc nova"]);
    assert.deepEqual(sp.agentProposals![0].remove, { requirements: ["req B"] });
    assert.equal(sp.agentEdits![0].byTask, "autor");
    const f = readdirSync(join(e.dir, "agent-edits")).find((x) => x.startsWith("epic-"))!;
    assert.deepEqual(JSON.parse(readFileSync(join(e.dir, "agent-edits", f), "utf8").trim()).epic.doneWhenRemove, ["D2"]);
    const [r] = await run("reviewer", [["tools/call", { name: "edit_task", arguments: { task_id: "irma", objective: "x", note: "y" } }]]);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /revisor/);
  } finally { e.done(); }
});


test("prompt: a regra de editar spec só vai pra builder/planner de tarefa de épico", async () => {
  const { specEditRule } = await import("./engine/claude.ts");
  assert.match(specEditRule({ role: "builder", spec: { epicId: EPIC } }), /edit_task.*edit_epic.*PROPOSTA/s);
  assert.match(specEditRule({ role: "planner", spec: { epicId: EPIC } }), new RegExp(EPIC));
  assert.equal(specEditRule({ role: "reviewer", spec: { epicId: EPIC } }), "");
  assert.equal(specEditRule({ role: "builder", spec: {} }), "");
});
