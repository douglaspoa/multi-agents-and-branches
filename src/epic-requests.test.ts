// node --test src/epic-requests.test.ts  (npm test)
// Criar épico e vincular/desvincular tarefas EXISTENTES pelo terminal (src/epic-requests.ts): o motor grava o
// PEDIDO, o app executa e responde. Aqui o "app" é simulado escrevendo o <id>.result.json. Pastas TEMPORÁRIAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import {
  applyLocalLink, epicRequestFlow, flowText, listRequests, pendingRequests, requestsDir, requestStatusText, resolveEpicRef, resolveTaskRefs, validateNewEpic,
} from "./epic-requests.ts";
import { renderEpicMd, writeEpicContext } from "./epic-context.ts";

const EPIC = "11111111-2222-3333-4444-555555555555";
const EPIC2 = "99999999-2222-3333-4444-555555555555";
const mk = (id: string, title: string, extra: Partial<TaskSpec> = {}) =>
  ({
    id, title, objective: "obj " + id, agent: "Orion", roles: [], engine: "mock", deliverables: ["d"], requirements: ["r"],
    scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "auto" }, ...extra,
  }) as TaskSpec;
function setup() {
  const repo = mkdtempSync(join(tmpdir(), "starfork-epreq-"));
  const dir = join(repo, ".cardume");
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "state.sqlite"));
  const add = (id: string, title: string, status: string, extra: Partial<TaskSpec> = {}) => {
    const wt = join(dir, "worktrees", id);
    mkdirSync(join(wt, ".cardume"), { recursive: true });
    store.createTask(mk(id, title, extra), "feat/" + id, wt, "main");
    store.setStatus(id, status as never);
    return wt;
  };
  return { repo, dir, store, add, done: () => { try { store.close(); } catch { /* */ } rmSync(repo, { recursive: true, force: true }); } };
}
const B = { agent: "Orion", taskId: "autor", taskTitle: "Autor", role: "builder" };
const specOf = (s: Store, id: string) => JSON.parse(s.getTask(id)!.spec_json) as TaskSpec;
/** "app" de mentira: responde o 1º pedido pendente com `res` assim que ele aparece. */
function fakeApp(dir: string, res: (id: string) => object, delay = 150) {
  const t = setInterval(() => {
    const p = pendingRequests(dir)[0];
    if (!p) return;
    clearInterval(t);
    setTimeout(() => writeFileSync(join(requestsDir(dir), `${p.id}.result.json`), JSON.stringify({ id: p.id, ...res(p.id) })), delay);
  }, 50);
  return () => clearInterval(t);
}

test("validação do épico novo: título, tamanhos, lista, segredo", () => {
  assert.equal(validateNewEpic({ title: "Arquitetura do user_cases", doneWhen: ["a"] }), null);
  assert.match(validateNewEpic({ title: "  " })!, /TÍTULO/);
  assert.match(validateNewEpic({ title: "x".repeat(141) })!, /longo/);
  assert.match(validateNewEpic({ title: "x", doneWhen: "a" as never })!, /lista/);
  assert.match(validateNewEpic({ title: "x", doneWhen: Array(31).fill("a") })!, /30/);
  assert.match(validateNewEpic({ title: "x", description: "token = abcdefghijklmnop" })!, /segredo/);
});

test("resolução: tarefa por id/título (locais + irmãs do contexto), desconhecida recusa listando; épico por id/nome", () => {
  const e = setup();
  try {
    e.add("t-login", "Login social", "draft");
    e.add("t-cad", "Cadastro por e-mail", "running");
    writeEpicContext(e.dir, { epicId: EPIC, title: "Contas", siblings: [{ cloudId: "aaaaaaaa-0000-0000-0000-000000000001", title: "Recuperar senha", status: "backlog" }], updatedAt: new Date().toISOString() });
    const ok = resolveTaskRefs(e.store, e.dir, ["t-login", "cadastro por e-mail", "Recuperar senha"]);
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && ok.tasks.map((t) => [t.localId ?? null, t.cloudId ?? null, t.title]), [
      ["t-login", null, "Login social"], ["t-cad", null, "Cadastro por e-mail"], [null, "aaaaaaaa-0000-0000-0000-000000000001", "Recuperar senha"]]);
    const bad = resolveTaskRefs(e.store, e.dir, ["t-login", "não existe"]);
    assert.ok(!bad.ok && /não achei.*neste projeto/s.test(bad.message) && /t-cad — Cadastro/.test(bad.message), "recusa listando as válidas");
    assert.deepEqual(resolveEpicRef(EPIC, [], undefined), { ok: true, epicId: EPIC });
    assert.deepEqual(resolveEpicRef("arquitetura do USER_cases", [{ id: EPIC2, title: "Arquitetura do user_cases" }]), { ok: true, epicId: EPIC2, epicTitle: "Arquitetura do user_cases" });
    assert.deepEqual(resolveEpicRef("Outro", []), { ok: true, epicTitle: "Outro" }, "nome desconhecido: o app procura no time");
    assert.deepEqual(resolveEpicRef("", [], EPIC), { ok: true, epicId: EPIC }, "vazio = o épico desta tarefa");
    assert.ok(!resolveEpicRef("Dup", [{ id: EPIC, title: "dup" }, { id: EPIC2, title: "Dup" }]).ok);
  } finally { e.done(); }
});

test("app FECHADO: pedido fica pendente e a resposta diz que NADA foi criado; status mostra PENDENTE; repetir não duplica", async () => {
  const e = setup();
  try {
    e.add("autor", "Autor", "running");
    e.add("t1", "Tarefa um", "draft");
    const r = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "create", by: B, epic: { title: "Arquitetura", doneWhen: ["login ok"] }, taskRefs: ["t1"], waitMs: 300 });
    assert.equal(r.status, "pending");
    assert.match(r.message, /NADA foi criado/);
    assert.match(r.message, /ABERTO/);
    assert.ok(r.requestId && existsSync(join(requestsDir(e.dir), `${r.requestId}.json`)));
    const again = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "create", by: B, epic: { title: "Arquitetura", doneWhen: ["login ok"] }, taskRefs: ["t1"], waitMs: 0 });
    assert.equal(again.requestId, r.requestId, "mesmo pedido pendente não vira dois");
    assert.equal(listRequests(e.dir).length, 1);
    assert.match(requestStatusText(e.dir).text, /PENDENTE/);
    assert.equal(specOf(e.store, "t1").epicId, undefined, "o motor não finge: a tarefa não mudou");
    const evs = e.store.db.prepare("SELECT text FROM event WHERE task_id = ?").all("autor") as { text: string }[];
    assert.ok(evs.some((x) => /pediu ao app: criar o épico "Arquitetura"/.test(x.text)), "rastro na tarefa de quem pediu");
  } finally { e.done(); }
});

test("app ABERTO: o resultado chega e volta pro CLI (criado / recusado sem login)", async () => {
  const e = setup();
  try {
    e.add("t1", "Tarefa um", "draft");
    let stop = fakeApp(e.dir, () => ({ ok: true, status: "done", message: 'épico "Arquitetura" criado no time e 1 tarefa(s) vinculada(s).', epicId: EPIC, epicTitle: "Arquitetura", linked: [{ ref: "t1", title: "Tarefa um", localId: "t1" }], failed: [] }));
    const ok = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "create", by: { agent: "Você" }, epic: { title: "Arquitetura" }, taskRefs: ["t1"], waitMs: 5000 });
    stop();
    assert.equal(ok.status, "done");
    assert.equal(ok.epicId, EPIC);
    assert.match(flowText(ok), /id 11111111/);
    assert.match(flowText(ok), /✓ Tarefa um/);
    stop = fakeApp(e.dir, () => ({ ok: false, status: "refused", message: "o Starfork não está logado na nuvem — o épico é do TIME. Entre na sua conta…", linked: [], failed: [] }));
    const no = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "create", by: { agent: "Você" }, epic: { title: "Outro" }, waitMs: 5000 });
    stop();
    assert.equal(no.ok, false);
    assert.equal(no.status, "refused");
    assert.match(no.message, /não está logado/);
    assert.match(requestStatusText(e.dir).text, /RECUSADO/);
  } finally { e.done(); }
});

test("revisor não cria nem vincula; link sem tarefa / tarefa desconhecida recusa ANTES de gravar pedido", async () => {
  const e = setup();
  try {
    e.add("t1", "Tarefa um", "draft");
    const rv = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "create", by: { agent: "Vega", role: "reviewer" }, epic: { title: "X" }, waitMs: 0 });
    assert.equal(rv.ok, false);
    assert.match(rv.message, /revisor/);
    const nt = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "link", by: B, epicRef: EPIC, taskRefs: [], waitMs: 0 });
    assert.equal(nt.status, "invalid");
    const unk = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "link", by: B, epicRef: EPIC, taskRefs: ["zzz"], waitMs: 0 });
    assert.equal(unk.status, "invalid");
    assert.equal(listRequests(e.dir).length, 0, "nada entrou na fila");
  } finally { e.done(); }
});

test("applyLocalLink: vincula SEM reiniciar (status, fila e worktree intactos), recado se roda, EPIC.md; move; desvincula; idempotente", () => {
  const e = setup();
  try {
    const wt = e.add("t1", "Tarefa um", "running");
    e.add("t2", "Tarefa dois", "draft");
    writeEpicContext(e.dir, { epicId: EPIC, title: "Arquitetura", doneWhen: [{ id: "D1", text: "login ok" }], siblings: [{ cloudId: "c1", localId: "t1", title: "Tarefa um", status: "running" }], updatedAt: new Date().toISOString() });
    const queued = () => (e.store.db.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    const instr = (id: string) => (e.store.db.prepare("SELECT COUNT(*) AS n FROM instruction WHERE task_id = ?").get(id) as { n: number }).n;
    const q0 = queued();
    const r = applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t1", epicId: EPIC, epicTitle: "Arquitetura", doneWhen: ["D1: login ok"], seq: 1, by: { agent: "Orion" } });
    assert.ok(r.ok && r.mode === "applied");
    const sp = specOf(e.store, "t1");
    assert.equal(sp.epicId, EPIC);
    assert.deepEqual(sp.epicDoneWhen, ["D1: login ok"]);
    assert.equal(e.store.getTask("t1")!.status, "running", "status intacto");
    assert.equal(queued(), q0, "nenhum turno enfileirado");
    assert.equal(instr("t1"), 1, "rodando: recado pro próximo turno");
    assert.match(readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8"), new RegExp(EPIC));
    assert.ok(existsSync(join(wt, ".cardume", "refs", "EPIC.md")), "EPIC.md já gerado do contexto");
    assert.ok(specOf(e.store, "t1").refs?.includes("EPIC.md"));
    const same = applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t1", epicId: EPIC, doneWhen: ["D1: login ok"], seq: 1, by: { agent: "Orion" } });
    assert.ok(same.ok && same.mode === "unchanged");
    // rascunho: sem recado (não roda), continua rascunho
    assert.ok(applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t2", epicId: EPIC, by: { agent: "Orion" } }).ok);
    assert.equal(e.store.getTask("t2")!.status, "draft");
    assert.equal(instr("t2"), 0);
    // move pra outro épico: checks e EPIC.md antigos saem
    const mv = applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t1", epicId: EPIC2, epicTitle: "Outro", by: { agent: "Orion" } });
    assert.ok(mv.ok && /movida/.test(mv.message));
    assert.equal(specOf(e.store, "t1").epicId, EPIC2);
    assert.equal(specOf(e.store, "t1").epicDoneWhen, undefined);
    // desvincula
    const un = applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t1", epicId: null, by: { agent: "Orion" } });
    assert.ok(un.ok && un.mode === "applied");
    assert.equal(specOf(e.store, "t1").epicId, undefined);
    assert.ok(!(specOf(e.store, "t1").refs ?? []).includes("EPIC.md"));
    assert.ok(!existsSync(join(wt, ".cardume", "refs", "EPIC.md")));
    const un2 = applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t1", epicId: null, by: { agent: "Orion" } });
    assert.ok(un2.ok && un2.mode === "unchanged");
    assert.ok(!applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "nada", epicId: EPIC, by: { agent: "x" } }).ok);
    assert.ok(!applyLocalLink({ store: e.store, cardumeDir: e.dir, taskId: "t2", epicId: "../x", by: { agent: "x" } }).ok);
  } finally { e.done(); }
});

test("EPIC.md e o prompt citam as tools de organizar épico (o agente não diz mais 'o CLI não cria épicos')", async () => {
  const md = renderEpicMd({ epicId: EPIC, title: "E", siblings: [], updatedAt: "x" }, []);
  assert.match(md, /link_tasks_to_epic.*unlink_tasks_from_epic.*create_epic/s);
  const { TOOLS } = await import("./mcp/tools.ts");
  for (const n of ["create_epic", "link_tasks_to_epic", "unlink_tasks_from_epic", "epic_request_status", "list_epics"]) assert.ok(TOOLS.some((t) => t.name === n), n);
  const { SHELL_COMMANDS, shellInstructions, INTEGRADO_RULE } = await import("./terminal-integrado.ts");
  assert.ok(SHELL_COMMANDS.some((c) => c.tool === "link_tasks_to_epic"));
  assert.match(shellInstructions(), /starfork epico vincular/);
  assert.match(INTEGRADO_RULE, /link_tasks_to_epic.*NUNCA recrie/s);
});

// ---------- ponta a ponta pelo CLI de verdade (processo filho) ----------
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (args: string[], env: Record<string, string>, cwd?: string) =>
  new Promise<{ code: number; out: string }>((res) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, CARDUME_ROLE: "", CARDUME_TASK: "", ...env } }, (err, so, se) =>
      res({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: so + se }));
  });

test("CLI: epic new (sem app → pendente, do cwd da worktree via CARDUME_DB), epic link com app respondendo, apply-link, status, list", async () => {
  const e = setup();
  try {
    const wt = e.add("t1", "Tarefa um", "draft");
    e.add("t2", "Tarefa dois", "review");
    e.store.close();
    const env = { CARDUME_DB: join(e.dir, "state.sqlite") };
    const p = await run(["epic", "new", "Arquitetura do user_cases", "--done-when", "login ok", "--tasks", "t1,t2", "--wait", "0", "--json"], env, wt);
    assert.equal(p.code, 0, p.out);
    const pj = JSON.parse(p.out.trim().split("\n").pop()!);
    assert.equal(pj.status, "pending");
    const req = JSON.parse(readFileSync(join(requestsDir(e.dir), `${pj.requestId}.json`), "utf8"));
    assert.equal(req.kind, "create");
    assert.deepEqual(req.epic, { title: "Arquitetura do user_cases", doneWhen: ["login ok"] });
    assert.deepEqual(req.tasks.map((t: { localId: string }) => t.localId), ["t1", "t2"]);
    // lista do time (o app grava) → link por NOME resolve o id já no motor
    writeFileSync(join(requestsDir(e.dir), "epics.json"), JSON.stringify({ at: "agora", epics: [{ id: EPIC, name: "Arquitetura do user_cases", status: "open", tasks: 0 }] }));
    assert.match((await run(["epic", "list"], env)).out, /11111111.*Arquitetura do user_cases/);
    // o app responde o create (ele é o mais antigo) e depois o link
    writeFileSync(join(requestsDir(e.dir), `${pj.requestId}.result.json`), JSON.stringify({ id: pj.requestId, ok: true, status: "done", message: "épico criado", epicId: EPIC2, epicTitle: "Arquitetura do user_cases", linked: [], failed: [] }));
    const stop = fakeApp(e.dir, () => ({ ok: true, status: "done", message: "2 tarefa(s) vinculada(s) ao épico \"Arquitetura do user_cases\". Nada foi recriado nem reiniciado.", epicId: EPIC, epicTitle: "Arquitetura do user_cases", linked: [{ ref: "Tarefa um", title: "Tarefa um", localId: "t1" }, { ref: "t2", title: "Tarefa dois", localId: "t2" }], failed: [] }));
    const out = await run(["epic", "link", "arquitetura do user_cases", "Tarefa um", "t2", "--wait", "6"], env);
    stop();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /✓.* 2 tarefa\(s\) vinculada\(s\)/);
    assert.match(out.out, /id 11111111/);
    const linkReq = listRequests(e.dir).find((x) => x.req.kind === "link")!.req;
    assert.equal(linkReq.epicId, EPIC, "nome resolvido pela lista do time");
    assert.deepEqual(linkReq.tasks.map((t) => t.localId), ["t1", "t2"]);
    // o app confirma → apply-link muda a spec local (sem mexer no status)
    const ap = await run(["epic", "apply-link", "t1", "--epic-id", EPIC, "--epic-title", "Arquitetura do user_cases", "--patch", JSON.stringify({ doneWhen: ["D1: login ok"], seq: 1 }), "--json", "--repo", e.repo], {});
    assert.equal(JSON.parse(ap.out.trim()).mode, "applied", ap.out);
    const s2 = new Store(env.CARDUME_DB);
    try {
      assert.equal((JSON.parse(s2.getTask("t1")!.spec_json) as TaskSpec).epicId, EPIC);
      assert.equal(s2.getTask("t1")!.status, "draft");
    } finally { s2.close(); }
    const cl = await run(["epic", "apply-link", "t1", "--clear", "--json", "--repo", e.repo], {});
    assert.equal(JSON.parse(cl.out.trim()).mode, "applied");
    const st = await run(["epic", "status"], env);
    assert.match(st.out, /FEITO · vincular ao épico/);
    const bad = await run(["epic", "link", EPIC, "nao-existe"], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /não achei a tarefa/);
  } finally { e.done(); }
});

test("MCP/starfork: create_epic e `starfork epico vincular` pelo mesmo caminho (pendente sem app)", async () => {
  const e = setup();
  try {
    e.add("autor", "Autor", "running");
    e.add("t1", "Tarefa um", "draft");
    const { callTool } = await import("./mcp/tools.ts");
    process.env.CARDUME_EPIC_WAIT_MS = "0";
    const ctx = { store: e.store, db: join(e.dir, "state.sqlite"), task: "autor", agent: "Orion", role: "builder", orch: async () => { throw new Error("sem orquestrador"); } };
    const r = await callTool(ctx as never, "create_epic", { title: "Novo épico", done_when: ["a"], task_ids: ["t1"] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /NADA foi criado/);
    const lk = await callTool(ctx as never, "link_tasks_to_epic", { epic: EPIC, task_ids: ["Tarefa um"] });
    assert.ok(!lk.isError);
    const rv = await callTool({ ...ctx, role: "reviewer" } as never, "unlink_tasks_from_epic", { task_ids: ["t1"] });
    assert.ok(rv.isError);
    assert.match((await callTool(ctx as never, "epic_request_status", {})).text, /PENDENTE/);
    assert.match((await callTool(ctx as never, "list_epics", {})).text, /ainda não tenho a lista/);
    const kinds = readdirSync(requestsDir(e.dir)).filter((f) => !f.includes("result")).length;
    assert.equal(kinds, 2);
    // starfork (shell da tarefa)
    const { starforkCli } = await import("./starfork-cli.ts");
    Object.assign(process.env, { CARDUME_DB: ctx.db, CARDUME_TASK: "autor", CARDUME_AGENT: "Orion", CARDUME_ROLE: "builder" });
    const outs: string[] = [];
    const code = await starforkCli(["epico", "desvincular", "t1"], { out: (s) => outs.push(s), err: (s) => outs.push(s) });
    assert.equal(code, 0, outs.join("\n"));
    assert.match(outs.join("\n"), /desvincular do épico/);
    assert.equal(listRequests(e.dir).filter((x) => x.req.kind === "unlink").length, 1);
  } finally {
    for (const k of ["CARDUME_EPIC_WAIT_MS", "CARDUME_DB", "CARDUME_TASK", "CARDUME_AGENT", "CARDUME_ROLE"]) delete process.env[k];
    e.done();
  }
});

test("título com vírgula chega inteiro; `apply-link --clear t1`; `epic tasks`/`epic list --json` do cwd da worktree via CARDUME_DB", async () => {
  const e = setup();
  try {
    const wt = e.add("t1", "Login, logout e sessão", "draft", { epicId: EPIC });
    e.add("t2", "Outra", "draft");
    const r = resolveTaskRefs(e.store, e.dir, ["Login, logout e sessão"]);
    assert.ok(r.ok && r.tasks.length === 1 && r.tasks[0].localId === "t1");
    const f = await epicRequestFlow({ store: e.store, cardumeDir: e.dir, kind: "unlink", by: { agent: "Você" }, taskRefs: ["Login, logout e sessão"], waitMs: 0 });
    assert.equal(f.status, "pending", f.message);
    e.store.close();
    const env = { CARDUME_DB: join(e.dir, "state.sqlite") };
    const n = await run(["epic", "new", "E", "--tasks", "t1,t2", "--no-wait", "--json"], env, wt);
    assert.deepEqual(listRequests(e.dir).find((x) => x.req.kind === "create")!.req.tasks.map((t) => t.localId), ["t1", "t2"], n.out);
    const tk = JSON.parse((await run(["epic", "tasks", EPIC, "--json", "--no-wait"], env, wt)).out.trim().split("\n").pop()!);
    assert.equal(tk.epicId, EPIC);
    assert.ok(tk.tasks.some((t: { id: string }) => t.id === "t1"), "leu o banco do projeto, não o da worktree");
    const cl = await run(["epic", "apply-link", "--clear", "t1", "--json", "--repo", e.repo], {});
    assert.equal(JSON.parse(cl.out.trim()).mode, "applied", cl.out);
    writeFileSync(join(requestsDir(e.dir), "epics.json"), JSON.stringify({ at: "agora", epics: [{ id: EPIC, name: "Arq", status: "open", tasks: 2 }] }));
    const ls = JSON.parse((await run(["epic", "list", "--json"], env, wt)).out.trim());
    assert.deepEqual(ls.epics, [{ id: EPIC, name: "Arq", status: "open", tasks: 2 }]);
  } finally { e.done(); }
});

test("épico novo com cartões novos (mandar pro time) e responsável: valida e leva no pedido", () => {
  assert.equal(validateNewEpic({ title: "Busca", cards: ["Índice", "Tela"], assignee: "bruno@exemplo.dev" }), null);
  assert.match(validateNewEpic({ title: "Busca", assignee: "bruno" }) ?? "", /--card/);
  assert.match(validateNewEpic({ title: "Busca", cards: ["x".repeat(141)] }) ?? "", /longo demais/);
  assert.match(validateNewEpic({ title: "Busca", cards: Array.from({ length: 31 }, (_, i) => "c" + i) }) ?? "", /no máximo/);
});
