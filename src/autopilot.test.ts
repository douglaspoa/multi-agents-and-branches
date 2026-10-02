// node --test src/autopilot.test.ts  (npm test)
// Piloto automático (src/autopilot.ts) com o motor MOCK: projeto local sem remoto, ordem de dependência nos merges,
// rework com os motivos quando a prova falha, bloqueio após N tentativas (o resto segue), parar + retomar, teto de
// custo, ask_human automático e o plano normalizado (onda 0 = esqueleto, prova da plataforma).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePlan, propagateBlocked, readState, requestStop, runAutopilot, runnable, type ApTaskState } from "./autopilot.ts";
import { Store } from "./store.ts";
import { tempHome } from "./testing/temp-home.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function env(extra: Record<string, string> = {}) {
  const h = tempHome();
  const keys = ["HOME", "CARDUME_MOCK_SPEED", "CARDUME_NOTIFY", "CARDUME_MOCK_COST_USD", "CARDUME_AUTOPILOT"];
  const old: Record<string, string | undefined> = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: h.home, CARDUME_MOCK_SPEED: "50", CARDUME_NOTIFY: "0" }, extra);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-piloto-")));
  return {
    root,
    dir: join(root, "app"),
    plan(tasks: unknown[]) {
      const f = join(root, "plan.json");
      writeFileSync(f, JSON.stringify({ epic: "Lista de compras", outcome: "comprar sem esquecer nada", requirements: [{ id: "R1", text: "lista funciona" }], doneWhen: ["abrir o app mostra a lista"], tasks }));
      return f;
    },
    done() {
      for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
      h.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const quiet = () => {};
const T = (title: string, after: number[], requirements = ["funciona"], owns = "") => ({ title, objective: title, verify: "funciona", after, requirements, owns: owns || `src/${title.toLowerCase().replace(/\W+/g, "-")}/**` });
/** merges na main, na ordem em que aconteceram (só a linha principal) */
const mergesOnMain = (dir: string) => git(dir, "log", "--first-parent", "--reverse", "--format=%s", "main").split("\n").filter((l) => l.startsWith("starfork: merge")).map((l) => l.replace(/^starfork: merge (.*) \(.*$/, "$1"));

test("ideia → pasta nova com git SEM remoto, merges na main em ordem de dependência, verificação final e AUTOPILOT.md", async () => {
  const e = env();
  try {
    const planFile = e.plan([T("Esqueleto do app", []), T("Adicionar itens", [0]), T("Marcar comprados", [1])]);
    const st = await runAutopilot({ idea: "um app de lista de compras", dir: e.dir, engine: "mock", planFile, log: quiet });
    assert.equal(st.phase, "done");
    assert.equal(git(e.dir, "remote"), "", "nenhum remoto criado");
    assert.equal(git(e.dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.deepEqual(mergesOnMain(e.dir), ["Esqueleto do app", "Adicionar itens", "Marcar comprados", "Verificação final do épico"]);
    assert.ok(existsSync(join(e.dir, "AUTOPILOT.md")));
    const rep = readFileSync(join(e.dir, "AUTOPILOT.md"), "utf8");
    assert.match(rep, /app pronto/);
    assert.match(rep, /\[x\] D1: abrir o app mostra a lista/);
    assert.equal(git(e.dir, "status", "--porcelain"), "", "relatório commitado na main, nada solto");
    const saved = readState(e.dir)!;
    assert.equal(saved.pid, 0);
    assert.ok(saved.tasks.every((t) => t.stage === "merged" && t.attempts === 1));
    assert.ok(existsSync(join(e.dir, ".cardume", "autopilot", "epic.json")));
    assert.ok(existsSync(join(e.dir, ".cardume", "autopilot", "EPIC.md")));
    // política autônoma gravada na tarefa (nada pergunta ao humano, nada de PR)
    const store = new Store(join(e.dir, ".cardume", "state.sqlite"));
    try {
      const spec = JSON.parse(store.getTask("adicionar-itens")!.spec_json);
      assert.equal(spec.autonomy.clarifications, "auto");
      assert.equal(spec.autonomy.approval, "auto");
      assert.equal(spec.autonomy.planApproval, "auto");
      assert.equal(spec.autoPr, "no");
      assert.deepEqual(spec.after, ["esqueleto-do-app"]);
      assert.ok(spec.refs.includes("EPIC.md"), "o agente lê o épico local");
    } finally { store.close(); }
  } finally { e.done(); }
});

test("prova falha na 1ª tentativa → refeita COM os motivos e mergeada na 2ª", async () => {
  const e = env();
  try {
    const planFile = e.plan([T("Esqueleto do app", []), T("Adicionar itens", [0], ["itens aparecem na lista [mock:falha-1]"])]);
    const st = await runAutopilot({ idea: "lista", dir: e.dir, engine: "mock", planFile, attempts: 2, log: quiet });
    const t = st.tasks.find((x) => x.id === "adicionar-itens")!;
    assert.equal(t.stage, "merged");
    assert.equal(t.attempts, 2);
    assert.equal(t.history[0].ok, false);
    assert.match(t.history[0].reasons.join(" "), /requisito não provado \(blocked\): itens aparecem/);
    assert.equal(t.history[1].ok, true);
    const store = new Store(join(e.dir, ".cardume", "state.sqlite"));
    try {
      const evs = store.eventsForTask("adicionar-itens").map((x) => x.text).join("\n");
      assert.match(evs, /rework: aplicando ajuste pelo time inteiro — "A VERIFICAÇÃO AUTOMÁTICA do piloto reprovou/);
      assert.match(JSON.parse(store.getTask("adicionar-itens")!.spec_json).adjustment, /requisito não provado \(blocked\): itens aparecem/);
    } finally { store.close(); }
    assert.deepEqual(mergesOnMain(e.dir), ["Esqueleto do app", "Adicionar itens", "Verificação final do épico"]);
  } finally { e.done(); }
});

test("prova falha sempre → bloqueada após N tentativas; quem depende dela também; o resto segue; o trabalho fica na branch", async () => {
  const e = env();
  try {
    const planFile = e.plan([T("Esqueleto do app", []), T("Recurso quebrado", [0], ["impossível [mock:falha-sempre]"]), T("Depende do quebrado", [1]), T("Recurso independente", [0])]);
    const st = await runAutopilot({ idea: "lista", dir: e.dir, engine: "mock", planFile, attempts: 2, parallel: 1, log: quiet });
    const by = (id: string) => st.tasks.find((x) => x.id === id)!;
    assert.equal(by("recurso-quebrado").stage, "blocked");
    assert.equal(by("recurso-quebrado").attempts, 2);
    assert.equal(by("depende-do-quebrado").stage, "blocked");
    assert.match(by("depende-do-quebrado").reasons[0], /depende de "Recurso quebrado"/);
    assert.equal(by("recurso-independente").stage, "merged");
    assert.match(git(e.dir, "branch", "--list", "feat/recurso-quebrado"), /feat\/recurso-quebrado/, "branch da tarefa bloqueada preservada");
    assert.equal(st.phase, "done");
    assert.match(readFileSync(join(e.dir, "AUTOPILOT.md"), "utf8"), /concluído com pendências[\s\S]*Bloqueada: /);
  } finally { e.done(); }
});

test("parar entre passos e RETOMAR: rodar de novo na mesma pasta continua do state.json sem refazer o que já foi", async () => {
  const e = env();
  try {
    const planFile = e.plan([T("Esqueleto do app", []), T("Adicionar itens", [0]), T("Marcar comprados", [1])]);
    let asked = false;
    const st = await runAutopilot({ idea: "lista", dir: e.dir, engine: "mock", planFile, log: quiet }, {
      onSave: (s) => { if (!asked && s.tasks.some((t) => t.stage === "merged")) { asked = true; requestStop(e.dir); } },
    });
    assert.equal(st.phase, "stopped");
    assert.deepEqual(mergesOnMain(e.dir), ["Esqueleto do app"], "parou depois do passo atual");
    assert.match(readFileSync(join(e.dir, "AUTOPILOT.md"), "utf8"), /parado a pedido/);
    // retomada: sem --idea (vem do estado), sem plano (vem do epic.json)
    const st2 = await runAutopilot({ dir: e.dir, log: quiet });
    assert.equal(st2.phase, "done");
    assert.equal(st2.runs, 2);
    assert.equal(st2.tasks.find((t) => t.id === "esqueleto-do-app")!.attempts, 1, "o esqueleto não rodou de novo");
    assert.deepEqual(mergesOnMain(e.dir), ["Esqueleto do app", "Adicionar itens", "Marcar comprados", "Verificação final do épico"]);
    assert.ok(!existsSync(join(e.dir, ".cardume", "autopilot", "STOP")), "o pedido de parada foi consumido");
  } finally { e.done(); }
});

test("teto de custo: para entre passos com relatório 'parou por custo'", async () => {
  const e = env({ CARDUME_MOCK_COST_USD: "0.6" });
  try {
    const planFile = e.plan([T("Esqueleto do app", []), T("Adicionar itens", [0]), T("Marcar comprados", [1])]);
    const st = await runAutopilot({ idea: "lista", dir: e.dir, engine: "mock", planFile, budgetUsd: 1, log: quiet });
    assert.equal(st.phase, "budget");
    assert.ok(st.costUsd >= 1, String(st.costUsd));
    // 1ª tarefa: 0,6 (< 1) → mergeada; 2ª: chega a 1,2 ao fim do turno → para ANTES do próximo passo (verificar)
    assert.deepEqual(mergesOnMain(e.dir), ["Esqueleto do app"]);
    assert.equal(st.tasks.find((t) => t.id === "adicionar-itens")!.stage, "verify", "retomar continua da verificação");
    assert.equal(st.tasks.find((t) => t.id === "marcar-comprados")!.stage, "pending", "a 3ª não começou");
    assert.match(readFileSync(join(e.dir, "AUTOPILOT.md"), "utf8"), /parou por custo/);
  } finally { e.done(); }
});

test("recusa pasta que já existe com conteúdo (só pasta nova ou piloto já começado)", async () => {
  const e = env();
  try {
    mkdirSync(e.dir, { recursive: true });
    writeFileSync(join(e.dir, "meu-arquivo.txt"), "x");
    await assert.rejects(runAutopilot({ idea: "x", dir: e.dir, engine: "mock", log: quiet }), /já existe e não está vazia/);
    assert.equal(readFileSync(join(e.dir, "meu-arquivo.txt"), "utf8"), "x");
  } finally { e.done(); }
});

test("ask_human no piloto: resposta automática NA HORA mandando decidir e registrar a suposição", async () => {
  const e = env();
  try {
    const planFile = e.plan([T("Esqueleto do app", [])]);
    await runAutopilot({ idea: "lista", dir: e.dir, engine: "mock", planFile, log: quiet });
    const db = join(e.dir, ".cardume", "state.sqlite");
    const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./mcp/server.ts", import.meta.url))], {
      env: { ...process.env, CARDUME_DB: db, CARDUME_TASK: "esqueleto-do-app", CARDUME_AGENT: "Piloto 1", CARDUME_AUTOPILOT: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const replies: Record<number, any> = {};
    srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); replies[o.id] = o; } catch { /* */ } } });
    const t0 = Date.now();
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_human", arguments: { question: "Qual cor do botão?", options: ["azul", "verde"] } } }) + "\n");
    for (let k = 0; k < 200 && !replies[1]; k++) await new Promise((r) => setTimeout(r, 25));
    srv.stdin.end();
    await new Promise((r) => srv.on("close", r));
    assert.ok(replies[1], "respondeu");
    assert.ok(Date.now() - t0 < 4000, "sem esperar humano");
    assert.match(replies[1].result.content[0].text, /PILOTO AUTOMÁTICO[\s\S]*Decida você mesmo[\s\S]*ASSUMPTIONS\.md/);
    const store = new Store(db);
    try {
      const evs = store.eventsForTask("esqueleto-do-app").map((x) => x.text).join("\n");
      assert.match(evs, /perguntou \(piloto automático, sem humano\): Qual cor do botão\?/);
      const open = store.db.prepare("SELECT COUNT(*) AS n FROM pending WHERE task_id = ? AND status != 'answered'").get("esqueleto-do-app") as { n: number };
      assert.equal(open.n, 0, "nenhuma pergunta fica aberta na UI");
    } finally { store.close(); }
  } finally { e.done(); }
});

test("plano normalizado: onda 0 = esqueleto, todos depois dele, sem ciclo, prova da plataforma (mobile usa cardume mobile)", () => {
  const ep = normalizePlan({
    epic: "Pou", tasks: [
      { title: "Esqueleto", after: [], requirements: [] },
      { title: "Alimentar o bicho", after: [2, 5], requirements: ["comer aumenta a barra"], owns: "src/comer/**, src/ui/barra.ts" },
      { title: "Dormir", after: [], requirements: ["luz apaga"] },
      { title: "Dormir", after: ["alimentar-o-bicho", 1] },
    ],
  }, "recriar o jogo Pou", "mobile");
  assert.deepEqual(ep.tasks.map((t) => t.id), ["esqueleto", "alimentar-o-bicho", "dormir", "dormir-2"]);
  assert.deepEqual(ep.tasks.map((t) => t.after), [[], ["esqueleto"], ["esqueleto"], ["alimentar-o-bicho"]]);
  assert.deepEqual(ep.tasks.map((t) => t.wave), [0, 1, 1, 2]);
  assert.deepEqual(ep.tasks[1].owns, ["src/comer/**", "src/ui/barra.ts"]);
  assert.deepEqual(ep.tasks[0].owns, ["**"]);
  assert.ok(ep.tasks[0].requirements.some((r) => /README\.md/.test(r)));
  assert.ok(ep.tasks[0].requirements.some((r) => /cardume mobile up --platform ios/.test(r) && /vídeo/.test(r)));
  assert.equal(ep.doneWhen[0].id, "D1");
  assert.throws(() => normalizePlan({ tasks: [] }, "x", "web"), /sem tarefas/);
});

test("agendador puro: só anda quem tem as dependências mergeadas; bloqueio propaga", () => {
  const t = (id: string, after: string[], stage: ApTaskState["stage"] = "pending", wave = 0): ApTaskState => ({ id, title: id, after, wave, stage, attempts: 0, reasons: [], history: [] });
  const tasks = [t("a", [], "merged"), t("b", ["a"], "blocked", 1), t("c", ["b"], "pending", 2), t("d", ["a"], "pending", 1), t("e", ["d"], "pending", 2)];
  assert.deepEqual(propagateBlocked(tasks), ["c"]);
  assert.deepEqual(runnable(tasks).map((x) => x.id), ["d"]);
});
