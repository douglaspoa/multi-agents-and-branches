// node --test src/epic-context.test.ts  (npm test)
// Contexto VIVO do épico (src/epic-context.ts): o app grava as irmãs; o motor regenera o EPIC.md a cada turno,
// lista as irmãs (epic_tasks) e resolve o alvo do edit_task por id OU título — alvo desconhecido é recusado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Store } from "./store.ts";
import type { TaskSpec } from "./types.ts";
import {
  contextDir, ensureFreshContext, listEpicTasks, prepEpicTurn, readEpicContext, resolveEditTarget, resolveEpicTarget,
  resolveTaskTarget, writeEpicContext, type EpicContext,
} from "./epic-context.ts";

const EPIC = "11111111-2222-3333-4444-555555555555";
const PROJ = "bbbbbbbb-0000-0000-0000-000000000001";
const C1 = "aaaaaaaa-0000-0000-0000-000000000001", C2 = "aaaaaaaa-0000-0000-0000-000000000002", C3 = "aaaaaaaa-0000-0000-0000-000000000003";
const mk = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({
    id, title: "Tarefa " + id, objective: "o", agent: "Orion", roles: [], engine: "mock", deliverables: [], requirements: ["req"],
    scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: true, approval: "auto" }, ...extra,
  }) as TaskSpec;
function setup() {
  const repo = mkdtempSync(join(tmpdir(), "starfork-epctx-"));
  const dir = join(repo, ".cardume");
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "state.sqlite"));
  const add = (id: string, status: string, extra: Partial<TaskSpec> = {}) => {
    const wt = join(dir, "worktrees", id);
    mkdirSync(join(wt, ".cardume", "refs"), { recursive: true });
    store.createTask(mk(id, extra), "feat/" + id, wt, "main");
    store.setStatus(id, status as never);
    return wt;
  };
  return { repo, dir, store, add, done: () => { try { store.close(); } catch { /* */ } rmSync(repo, { recursive: true, force: true }); } };
}
// o JSON sai da função PURA do app (47-edicoes-agente: aeEpicContextJson) — é o formato real que o motor lê
function appJson(cards: unknown[], localIds: string[], now = new Date().toISOString()): EpicContext {
  const src = readFileSync(new URL("../app/src/js/47-edicoes-agente.js", import.meta.url), "utf8");
  const ctx: Record<string, unknown> = { tickLoop: () => {}, document: { addEventListener: () => {} }, window: {}, state: {}, IC: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.f=aeEpicContextJson;", ctx);
  const ep = { id: EPIC, name: "Acesso ao User Cases", spec: { description: "d", doneWhen: [{ id: "D1", text: "login ok", checkedBy: "u" }, { id: "D3", text: "logout ok" }], requirements: [{ id: "R1", text: "r" }] } };
  return JSON.parse(JSON.stringify((ctx.f as Function)(ep, cards, localIds, PROJ, now, (u: string) => "Pessoa " + u)));
}
const CARDS = [
  { id: C1, local_id: "autor", title: "Login SSO", status: "running", epic_id: EPIC, project_id: PROJ, assignee: "u1", spec: { title: "Login SSO", requirements: ["a"] } },
  { id: C2, local_id: "card-x1", title: "Acesso ao user cases — página inicial (tracer bullet)", status: "backlog", epic_id: EPIC, project_id: PROJ, spec: { title: "Acesso ao user cases — página inicial (tracer bullet)", requirements: ["abre a página", "mostra os casos"] } },
  { id: C3, local_id: "card-x2", title: "Página de detalhe", status: "backlog", epic_id: EPIC, project_id: PROJ, spec: { requirements: [] } },
  { id: "cccccccc-0000-0000-0000-000000000009", local_id: "card-z", title: "De outro projeto", status: "backlog", epic_id: EPIC, project_id: "outro", spec: {} },
];

test("writer do app (puro): só o mesmo projeto, ids nuvem/local, D-ids com marcado, máquina local; motor lê", () => {
  const e = setup();
  try {
    const j = appJson(CARDS, ["autor"]);
    assert.equal(j.siblings.length, 3, "cartão de outro projeto fica de fora");
    assert.deepEqual(j.siblings[0], { cloudId: C1, localId: "autor", title: "Login SSO", status: "running", requirements: ["a"], owner: "Pessoa u1", machineLocal: true });
    assert.equal(j.siblings[1].localId, null, "local_id 'card-…' não é id local");
    assert.deepEqual(j.doneWhen, [{ id: "D1", text: "login ok", checked: true }, { id: "D3", text: "logout ok", checked: false }]);
    writeEpicContext(e.dir, j);
    assert.ok(!readdirSync(contextDir(e.dir)).some((f) => f.endsWith(".tmp")));
    const r = readEpicContext(e.dir, EPIC)!;
    assert.equal(r.ctx.title, "Acesso ao User Cases");
    assert.ok(r.age < 5000);
  } finally { e.done(); }
});

test("início de turno: EPIC.md velho (sem ids) é regenerado com ids e títulos; 'pronto quando' do TASK.yaml acompanha", () => {
  const e = setup();
  try {
    const wt = e.add("autor", "review", { epicId: EPIC, refs: ["EPIC.md"], epicDoneWhen: ["D1: login ok"] });
    const spec = JSON.parse(e.store.getTask("autor")!.spec_json) as TaskSpec;
    // sem contexto: não mexe, mas pede refresh pro app
    assert.equal(prepEpicTurn({ store: e.store, cardumeDir: e.dir, spec, cwd: wt }), false);
    assert.ok(existsSync(join(contextDir(e.dir), "refresh-request")));
    writeEpicContext(e.dir, appJson(CARDS, ["autor"]));
    assert.equal(prepEpicTurn({ store: e.store, cardumeDir: e.dir, spec, cwd: wt }), true);
    const md = readFileSync(join(wt, ".cardume", "refs", "EPIC.md"), "utf8");
    assert.match(md, new RegExp("\\*\\*`" + C2 + "`\\*\\* — Acesso ao user cases — página inicial \\(tracer bullet\\) · backlog"));
    assert.match(md, /\*\*`autor`\*\* — \*\*ESTA → \*\*Login SSO/);
    assert.match(md, /requisitos: abre a página \| mostra os casos/);
    assert.match(md, /- \[x\] D1: login ok/);
    assert.match(md, new RegExp("id do épico:\\*\\* `" + EPIC));
    const saved = JSON.parse(e.store.getTask("autor")!.spec_json) as TaskSpec;
    assert.deepEqual(saved.epicDoneWhen, ["D1: login ok", "D3: logout ok"]);
    assert.equal(saved.epicDoneWhenSeq, 3);
    assert.match(readFileSync(join(wt, ".cardume", "TASK.yaml"), "utf8"), /D3: logout ok/);
  } finally { e.done(); }
});

test("orquestrador regenera o contexto em TODO turno (pipeline, instruções, chat/resume, entregável)", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  assert.equal((src.match(/this\.prepEpic\(spec, (task\.)?worktree\)/g) ?? []).length, 4);
  const talk = src.slice(src.indexOf("private async talkToAgentInner"), src.indexOf("private async talkToAgentInner") + 4000);
  assert.ok(talk.indexOf("this.prepEpic(spec, task.worktree)") < talk.indexOf("this.epicContext(spec)"), "no resume, antes de montar o contexto");
});

test("resolução do alvo: id da nuvem/local, título sem acento/caixa, slug deduzido, prefixo; ambíguo/nada → recusa listando", () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const items = listEpicTasks(e.store, appJson(CARDS, ["autor"]), EPIC);
    const id = (q: string) => { const r = resolveTaskTarget(q, items); return r.ok ? r.item.id : "ERRO: " + r.message; };
    assert.equal(id(C2), C2);
    assert.equal(id(C1), "autor", "irmã local: passa a usar o id local");
    assert.equal(id("acesso ao USER cases — pagina inicial (tracer bullet)"), C2);
    assert.equal(id("acesso-ao-user-cases-pagina-inicial-tracer-bullet"), C2, "o slug que o agente deduziu");
    assert.equal(id("Página de det"), C3);
    const amb = resolveTaskTarget("pagina", [...items, { id: "z", title: "Página de detalhe 2", status: "backlog", requirements: [], here: false }]);
    assert.equal(amb.ok, false);
    const none = resolveTaskTarget("tarefa que não existe", items);
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.message, new RegExp(C2 + " — Acesso ao user cases"));
    assert.equal(resolveEpicTarget(undefined, [{ id: EPIC, title: "X" }], EPIC).ok, true);
    assert.equal(resolveEpicTarget("x", [{ id: EPIC, title: "X" }]).ok, true, "pelo nome");
    assert.equal(resolveEpicTarget("nao-existe", [{ id: EPIC, title: "X" }]).ok, false);
  } finally { e.done(); }
});

test("refresh-request: sem contexto o motor pede e ESPERA o app (falso) gravar; sem app → aviso, e alvo desconhecido é recusado", async () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    const req = join(contextDir(e.dir), "refresh-request");
    // "app": observa o pedido e grava o contexto
    const app = (async () => {
      for (let i = 0; i < 40 && !existsSync(req); i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(JSON.parse(readFileSync(req, "utf8")).epicIds, [EPIC]);
      rmSync(req);
      writeEpicContext(e.dir, appJson(CARDS, ["autor"]));
    })();
    const t = await resolveEditTarget({ store: e.store, cardumeDir: e.dir, query: "Página de detalhe", epicId: EPIC, timeoutMs: 3000 });
    await app;
    assert.deepEqual(t, { ok: true, id: C3, cloud: true, warn: undefined });
    // sem app nenhum (outro repo): espera o tempo e avisa
    const e2 = setup();
    try {
      e2.add("autor", "running", { epicId: EPIC });
      const t0 = Date.now();
      const f = await ensureFreshContext(e2.dir, EPIC, 600);
      assert.ok(Date.now() - t0 >= 550);
      assert.equal(f.ctx, null);
      assert.match(f.warn!, /aberto e logado/);
      const r = await resolveEditTarget({ store: e2.store, cardumeDir: e2.dir, query: "acesso-ao-user-cases-pagina-inicial-tracer-bullet", epicId: EPIC, timeoutMs: 300 });
      assert.equal(r.ok, false, "id deduzido que ninguém conhece NÃO entra na fila");
      assert.ok(!existsSync(join(e2.dir, "agent-edits")));
    } finally { e2.done(); }
  } finally { e.done(); }
});

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
test("CLI `epic tasks` e MCP epic_tasks/edit_task: lista com ids; edita irmã PELO TÍTULO; alvo desconhecido recusado sem fila", async () => {
  const e = setup();
  try {
    e.add("autor", "running", { epicId: EPIC });
    writeEpicContext(e.dir, appJson(CARDS, ["autor"]));
    e.store.close();
    const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "epic", "tasks", "--json", "--repo", e.repo], {
      encoding: "utf8", env: { ...process.env, CARDUME_TASK: "autor", CARDUME_ROLE: "" },
    });
    const j = JSON.parse(out.trim());
    assert.equal(j.epicId, EPIC);
    assert.deepEqual(j.tasks.map((x: { id: string }) => x.id), ["autor", C2, C3]);
    const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./mcp/server.ts", import.meta.url))], {
      env: { ...process.env, CARDUME_DB: join(e.dir, "state.sqlite"), CARDUME_TASK: "autor", CARDUME_AGENT: "Orion", CARDUME_ROLE: "builder" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const replies: Record<number, any> = {};
    srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* */ } } });
    const call = async (id: number, name: string, args: unknown) => {
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      for (let k = 0; k < 200 && !replies[id]; k++) await new Promise((r) => setTimeout(r, 50));
      return replies[id].result;
    };
    const list = await call(1, "epic_tasks", {});
    assert.match(list.content[0].text, new RegExp(`- ${C2} — Acesso ao user cases — página inicial \\(tracer bullet\\) · backlog · só na nuvem`));
    const ok = await call(2, "edit_task", { task_id: "acesso-ao-user-cases-pagina-inicial-tracer-bullet", reqAdd: [], requirements_add: ["mostra o total"], note: "faltava" });
    assert.equal(ok.isError, false, ok.content[0].text);
    const bad = await call(3, "edit_task", { task_id: "tarefa-inventada", requirements_add: ["x"], note: "y" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /não achei a tarefa "tarefa-inventada".*\n.*autor — Login SSO/s);
    const ep = await call(4, "edit_epic", { description: "nova", note: "mudou" }); // épico padrão = o desta tarefa
    assert.equal(ep.isError, false, ep.content[0].text);
    srv.stdin.end();
    await new Promise((r) => srv.on("close", r));
    const files = readdirSync(join(e.dir, "agent-edits")).filter((f) => f.endsWith(".jsonl")).sort();
    assert.deepEqual(files, [`card-${C2}.jsonl`, `epic-${EPIC}.jsonl`], "só o alvo resolvido entrou na fila");
  } finally { e.done(); }
});
