// node --test src/agentes-f4.test.ts  (npm test)
// F4 da decisão da mesa (03/10): P12 — a medição sai do evento `papel` gravado DESDE O ACEITE (versão do agente na linha
// "skills ativas: … · nyx@v4 · …") e o boletim continua UMA query < 150 ms com 500 tarefas (o MESMO SQL do Rust, + a
// query do previsto); P13 — arquivar/restaurar skill no TS ≡ Rust pelo fixture dourado `ciclo-golden/curador.json`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { agentVersion, archiveSkill, bumpAgent, readSkillHistory, restoreSkill, skillHistDir, writeSkillVersion } from "./agent-versions.ts";
import { rosterLine } from "./lifecycle.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const SQL = readFileSync(new URL("../app/src-tauri/src/agent_stats.sql", import.meta.url), "utf8");
const PREV = readFileSync(new URL("../app/src-tauri/src/agent_stats_prev.sql", import.meta.url), "utf8");
const MT = readFileSync(new URL("../app/src/js/61-meu-time.js", import.meta.url), "utf8");
const pure = MT.slice(MT.indexOf("// @meutime-puro-inicio"), MT.indexOf("// @meutime-puro-fim"));
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const P = new Function(pure + "\nreturn { agVerOf, agBeforeAfter };")() as {
  agVerOf: (t: unknown) => number | null;
  agBeforeAfter: (rows: unknown[], v: number | null, o?: { kind?: string }) => { stage: string; nb: number; na: number; text: string };
};
// linha do SQL (array posicional) → o objeto que o Rust devolve pro app
const toRow = (r: Record<string, unknown>, prev: Map<string, number>) => {
  const v = Object.values(r);
  return { agentId: v[0], taskId: v[1], title: v[2], status: v[3], createdAt: v[4], role: v[5], usd: v[6], reworks: v[7], muda: v[8], rounds: v[9],
    kind: v[10], prUrl: v[11], papel: v[12], trounds: v[13], tusd: v[14], branchType: v[15], prevUsd: prev.get(String(v[1])) ?? null };
};

test("P12: a versão de cada tarefa é a do `papel` gravado no início do papel — aceitar no meio separa antes × depois", () => {
  const d = tmp("sf-f4-medir-");
  try {
    const cd = join(d, ".cardume");
    mkdirSync(cd, { recursive: true });
    const store = new Store(join(cd, "state.sqlite"));
    const db = store.db;
    const insT = db.prepare("INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at) VALUES (?,?,'o','merged','Nyx','b','w','main','claude',?,?)");
    const run = (id: string, i: number) => {
      insT.run(id, id, JSON.stringify({ taskKind: "documento" }), i);
      // o que o orquestrador faz no início do papel (recordRoleRun): versão ATUAL do agente na linha
      store.addEvent(id, "Nyx", "papel", rosterLine({ agentId: "nyx", name: "Nyx", version: agentVersion(cd, "nyx"), engine: "claude", skills: [] }), true, "reviewer", "nyx");
      store.addEvent(id, "Nyx", "veredito", "aprova", true, "reviewer", "nyx");
    };
    for (let i = 0; i < 6; i++) run(`a${i}`, i);
    const v = bumpAgent(cd, "nyx", { at: 10, change: "nota", what: "Conferir o teste de login" }); // o aceite
    for (let i = 6; i < 12; i++) run(`b${i}`, i);
    const rows = (db.prepare(SQL).all("nyx") as Record<string, unknown>[]).map((r) => toRow(r, new Map()));
    assert.equal(rows.length, 12);
    assert.deepEqual([...new Set(rows.map((r) => P.agVerOf(r.papel)))].sort(), [1, 2]);
    const ba = P.agBeforeAfter(rows, v, { kind: "documento" });
    assert.equal(ba.nb, 6); assert.equal(ba.na, 6);
    assert.equal(ba.stage, "cru", "6 × 6: só números crus");
    assert.equal(P.agBeforeAfter(rows, v, { kind: "codigo" }).text, "ainda medindo (0 de 10)", "outro tipo não entra");
    store.close?.();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("P12 perf: o boletim com versão/rodadas/custo da tarefa + o previsto, 500 tarefas, < 150 ms (MESMO SQL do Rust)", () => {
  const d = tmp("sf-f4-perf-");
  try {
    const store = new Store(join(d, "state.sqlite"));
    const db = store.db;
    db.exec("CREATE TABLE IF NOT EXISTS estimate (task_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL)");
    const insT = db.prepare("INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at) VALUES (?,?,'o',?,'Íris','b','w','main','claude',?,?)");
    const insE = db.prepare("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?,?,?,?,?,?,?,?)");
    const insC = db.prepare("INSERT INTO cost (task_id,agent,role,usd,in_tok,out_tok,ms,created_at,agent_id) VALUES (?,?,?,?,1,1,0,1,?)");
    const insP = db.prepare("INSERT INTO estimate (task_id,json,created_at) VALUES (?,?,1)");
    db.exec("BEGIN");
    for (let i = 0; i < 500; i++) {
      const id = `t${i}`;
      insT.run(id, `Tarefa ${i}`, ["review", "merged", "running", "error", "done"][i % 5], i === 7 ? "{quebrado" : JSON.stringify({ taskKind: i % 2 ? "codigo" : "documento" }), i);
      for (const [ag, nm, role] of [["vega", "Vega", "planner"], ["iris", "Íris", "builder"], ["nyx", "Nyx", "reviewer"]]) {
        insE.run(id, nm, role, 1, "papel", `skills ativas: a@v1 · ${ag}@v${i < 250 ? 1 : 2} · claude`, 1, ag);
        insE.run(id, nm, role, 2, "papel", `skills ativas: a@v1 · ${ag}@v9 · claude`, 1, ag); // retry: não muda a versão da tarefa
        for (let k = 0; k < 8; k++) insE.run(id, nm, role, k, "note", "trabalhando", 1, ag);
        insC.run(id, nm, role, 0.1, ag);
      }
      if (i % 4 === 0) insE.run(id, "Nyx", "reviewer", 2, "veredito", "rodada 1: muda", 0, "nyx");
      insE.run(id, "Nyx", "reviewer", 3, "veredito", "rodada 2: aprova", 1, "nyx");
      if (i % 2 === 0) insP.run(id, JSON.stringify({ v: 1, total: { usd: 0.5 } }));
      insC.run(id, "Íris", "builder", 9, null);
    }
    insP.run("lixo", "{nada"); // previsão estragada não derruba
    db.exec("COMMIT");
    const st = db.prepare(SQL), sp = db.prepare(PREV);
    const t0 = performance.now();
    const all = st.all(null) as Record<string, unknown>[];
    const prev = new Map((sp.all() as Record<string, unknown>[]).map((r) => { const v = Object.values(r); return [String(v[0]), Number(v[1])]; }));
    const msAll = performance.now() - t0;
    const t1 = performance.now();
    const nyx = (st.all("nyx") as Record<string, unknown>[]).map((r) => toRow(r, prev));
    const msOne = performance.now() - t1;
    console.log(`agent_stats F4 (node:sqlite): todos ${msAll.toFixed(1)} ms (${all.length} linhas, ${prev.size} previsões) · nyx ${msOne.toFixed(1)} ms`);
    assert.ok(msAll < 150 && msOne < 150, `lento: ${msAll} / ${msOne} ms`);
    assert.equal(all.length, 1500);
    assert.equal(prev.size, 250);
    const r0 = nyx.find((r) => r.taskId === "t0")!;
    assert.equal(r0.papel, "skills ativas: a@v1 · nyx@v1 · claude", "o 1º papel");
    assert.equal(r0.trounds, 2);
    assert.ok(Math.abs(Number(r0.tusd) - 9.3) < 1e-9);
    assert.equal(r0.prevUsd, 0.5);
    assert.equal(nyx.find((r) => r.taskId === "t1")!.prevUsd, null);
    const t0b = performance.now();
    const ba = P.agBeforeAfter(nyx, 2, { kind: "documento" });
    const msBa = performance.now() - t0b;
    assert.ok(msBa < 20, `agBeforeAfter ${msBa} ms`);
    assert.equal(ba.stage, "pct");
    store.close?.();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P13: arquivar/restaurar ≡ Rust

const GOLD = JSON.parse(readFileSync(new URL("../tests/fixtures/ciclo-golden/curador.json", import.meta.url), "utf8")) as { steps: Record<string, any>[] };
const files = (dir: string) => { try { return readdirSync(dir).filter((n) => n !== "index.json").sort(); } catch { return []; } };

test("P13: arquivar e restaurar skill — o MESMO roteiro dourado do Rust (byte a byte, histórico e arquivos)", () => {
  const d = tmp("sf-f4-gold-");
  try {
    const cd = join(d, ".cardume"), root = join(d, ".claude", "skills");
    for (const st of GOLD.steps) {
      if (st.op === "write") assert.deepEqual(writeSkillVersion(cd, root, st.name, st.content, { at: st.at, action: st.action, agente: st.agente }), st.result);
      else if (st.op === "archive") assert.deepEqual(archiveSkill(cd, root, st.name, st.reason, st.at, st.agente), st.result);
      else if (st.op === "restore") {
        let r: unknown; try { r = restoreSkill(cd, root, st.name, st.at); } catch { r = { error: true }; }
        assert.deepEqual(r, st.result, `${st.op} ${st.name} @${st.at}`);
      } else if (st.op === "legacy") { mkdirSync(join(root, st.name), { recursive: true }); writeFileSync(join(root, st.name, "SKILL.md"), st.content); }
      let got: string | null = null; try { got = readFileSync(join(root, st.name, "SKILL.md"), "utf8"); } catch { /* sem SKILL.md */ }
      assert.equal(got, st.expect.skill, `byte a byte: ${st.op} @${st.at}`);
      assert.deepEqual(readSkillHistory(cd, st.name), st.expect.history, `${st.op} @${st.at}`);
      assert.deepEqual(files(skillHistDir(cd, st.name)), st.expect.files, `${st.op} @${st.at}`);
    }
    // o roteiro cobre: arquivar com dono, restaurar 2× (a 2ª é erro), arquivar de novo, legado sem histórico e nome reocupado
    assert.deepEqual(GOLD.steps.map((s) => s.op), ["write", "write", "archive", "restore", "restore", "archive", "restore", "legacy", "archive", "legacy", "restore"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("P13: arquivar nunca apaga (os bytes ficam no histórico) e sem SKILL.md é erro em palavra", () => {
  const d = tmp("sf-f4-arq-");
  try {
    const cd = join(d, ".cardume"), root = join(d, ".claude", "skills");
    assert.throws(() => archiveSkill(cd, root, "nada", "", 1, ""), /não está mais ativa/);
    assert.throws(() => restoreSkill(cd, root, "nada", 1), /não tem histórico/);
    writeSkillVersion(cd, root, "x", "corpo-1\n", { at: 1, action: "criar" });
    archiveSkill(cd, root, "x", "sem uso", 2, "");
    assert.equal(readFileSync(join(skillHistDir(cd, "x"), "arquivada-v2.md"), "utf8"), "corpo-1\n");
    assert.equal(readSkillHistory(cd, "x")!.archived, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
