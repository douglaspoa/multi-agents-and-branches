// node --test src/agentes-f3.test.ts  (npm test)
// F3 da decisão da mesa (03/10): P8 boletim do agente (UMA query, < 150 ms com 500 tarefas — o MESMO SQL do Rust) e
// P9 aprendizado com dono (a retro marca papel+agente; skill/nota com dono só no prompt do papel dono; auto nunca
// aplica item de agente; v1 sem persona/modelo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";
import { parseRetro, parseSkillMd, projectSkills, readPending, retroOwner, retroPrompt, revertLearnedSkill, roleLearningContext, skillMd, type RetroCtx } from "./learn.ts";
import { activeAgentMemory, activeSkills, readAgentVersions, writeSkillVersion } from "./agent-versions.ts";
import type { TaskSpec } from "./types.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only" : false };
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const SQL = readFileSync(new URL("../app/src-tauri/src/agent_stats.sql", import.meta.url), "utf8");
const TEAM = [{ agentId: "lumen", name: "Lumen", role: "docs" }, { agentId: "nyx", name: "Nyx", role: "reviewer" }];

// ---------------------------------------------------------------- P8: agent_stats

test("agent_stats: o MESMO SQL do Rust, com o schema real do motor e 500 tarefas, roda em < 150 ms", () => {
  const d = tmp("sf-agstats-");
  try {
    const store = new Store(join(d, "state.sqlite"));
    const db = store.db;
    const insT = db.prepare("INSERT INTO task (id,title,objective,status,agent,branch,worktree,base,engine,spec_json,created_at) VALUES (?,?,'o',?,'Íris','b','w','main','claude',?,?)");
    const insE = db.prepare("INSERT INTO event (task_id,agent,role,ts,type,text,ok,agent_id) VALUES (?,?,?,?,?,?,?,?)");
    const insC = db.prepare("INSERT INTO cost (task_id,agent,role,usd,in_tok,out_tok,ms,created_at,agent_id) VALUES (?,?,?,?,1,1,0,1,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 500; i++) {
      const id = `t${i}`;
      insT.run(id, `Tarefa ${i}`, ["review", "merged", "running", "error", "done"][i % 5], i === 7 ? "{quebrado" : JSON.stringify({ taskKind: "codigo", ...(i % 3 === 0 ? { prUrl: "https://x/pull/1" } : {}) }), i);
      for (const [ag, nm, role] of [["vega", "Vega", "planner"], ["iris", "Íris", "builder"], ["nyx", "Nyx", "reviewer"]]) {
        insE.run(id, nm, role, 1, "papel", "skills ativas: — · x@v1 · claude", 1, ag);
        for (let k = 0; k < 8; k++) insE.run(id, nm, role, k, "note", "trabalhando", 1, ag);
        insC.run(id, nm, role, 0.1, ag);
      }
      if (i % 4 === 0) insE.run(id, "Nyx", "reviewer", 2, "veredito", "rodada 1: muda", 0, "nyx");
      insE.run(id, "Nyx", "reviewer", 3, "veredito", "rodada 2: aprova", 1, "nyx");
      if (i % 6 === 0) insE.run(id, "Íris", null, 4, "note", 'rework: aplicando ajuste pelo time inteiro — "x"', 1, null);
      insC.run(id, "Íris", "builder", 9, null); // linha antiga sem agent_id: "sem ficha"
    }
    db.exec("COMMIT");
    const st = db.prepare(SQL);
    const t0 = performance.now();
    const all = st.all(null) as Record<string, unknown>[];
    const msAll = performance.now() - t0;
    const t1 = performance.now();
    const nyx = st.all("nyx") as Record<string, unknown>[];
    const msOne = performance.now() - t1;
    console.log(`agent_stats (node:sqlite): todos ${msAll.toFixed(1)} ms (${all.length} linhas) · nyx ${msOne.toFixed(1)} ms`);
    assert.ok(msAll < 150 && msOne < 150, `lento: ${msAll} / ${msOne} ms`);
    assert.equal(all.length, 1500);
    assert.equal(nyx.length, 500);
    const r0 = Object.values(nyx.find((r) => Object.values(r)[1] === "t0")!);
    assert.equal(r0[6], 0.1, "custo só do agent_id dele");
    assert.equal(r0[7], 1, "1 rework");
    assert.equal(r0[8], 1, "1 veredito muda");
    assert.equal(r0[9], 2, "2 rodadas");
    store.close?.();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P9: retro com dono

test("retroPrompt: mostra a equipe, pede o dono de cada item e proíbe persona/modelo", () => {
  const ctx: RetroCtx = { title: "T", objective: "o", requirements: [], corrections: [], reworks: 0, reviewSummary: "", events: [], brainCatalog: "", learnedSkills: [], team: TEAM, reviewAsks: ["Nyx pediu a Lumen (lumen): citar a fonte"] };
  const p = retroPrompt(ctx);
  assert.match(p, /- lumen \(Lumen\) — papel docs/);
  assert.match(p, /O que a revisão devolveu[\s\S]*citar a fonte/);
  assert.match(p, /"agente":"id da equipe ou projeto"/);
  assert.match(p, /NUNCA proponha mudar a persona, o modelo ou o motor/);
});

test("parseRetro lê o dono; persona/modelo propostos são ignorados (v1)", () => {
  const out = parseRetro(JSON.stringify({
    notas: [{ title: "Citar fonte sempre", type: "regra", body: "Toda afirmação com link e data.", agente: "Lumen" }],
    skills: [{ acao: "criar", nome: "conferir-numeros", descricao: "Use ao revisar um relatório com números", corpo: "## Passo a passo\nconfira cada número na fonte", agente: "nyx", porque: "x" }],
    persona: { agente: "nyx", texto: "seja mais duro" }, modelo: "opus",
  }));
  assert.equal(out.notas[0].dono, "Lumen");
  assert.equal(out.skills[0].dono, "nyx");
  assert.deepEqual(Object.keys(out), ["notas", "skills"]);
});

test("retroOwner: id ou nome (sem acento/caixa) da equipe; 'projeto' e quem não está na equipe = sem dono", () => {
  assert.deepEqual(retroOwner("lumen", TEAM), { agente: "lumen", papel: "docs", nome: "Lumen" });
  assert.deepEqual(retroOwner(" NYX ", TEAM), { agente: "nyx", papel: "reviewer", nome: "Nyx" });
  assert.deepEqual(retroOwner("lúmen", TEAM)?.agente, "lumen");
  assert.equal(retroOwner("projeto", TEAM), null);
  assert.equal(retroOwner("", TEAM), null);
  assert.equal(retroOwner("cobalt", TEAM), null, "a retro não inventa agente");
  assert.equal(retroOwner("lumen", undefined), null);
});

test("skillMd: a linha agente só existe com dono (sem dono: igual a antes) e volta no parse", () => {
  const sem = skillMd("x", "d", ["t1"], "corpo");
  assert.equal(sem, skillMd("x", "d", ["t1"], "corpo", ""));
  assert.ok(!/agente:/.test(sem));
  const com = skillMd("x", "d", ["t1"], "corpo", "Lúmen");
  assert.match(com, /\norigem: aprendida\nagente: lumen\ntarefas: \[t1\]\n/);
  assert.equal(parseSkillMd(com).agente, "lumen");
  assert.equal(parseSkillMd(sem).agente, "");
});

function withHome<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

test("retro (modo auto): item com dono vai pra fila com papel+agente+nome; o do projeto aplica; fora da equipe vira projeto", POSIX, async () => {
  const root = tmp("sf-f3-retro-");
  try {
    const r = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    const home = join(root, "home");
    mkdirSync(join(home, ".constellation"), { recursive: true });
    writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "auto" }));
    const ans = join(root, "answer.json");
    writeFileSync(ans, JSON.stringify({
      notas: [
        { title: "Citar fonte com link e data", type: "regra", tags: [], body: "Toda afirmação do relatório leva link e data.", agente: "lumen" },
        { title: "O relatório mora em docs/", type: "contexto", tags: [], body: "Os relatórios ficam em docs/relatorios.", agente: "projeto" },
        { title: "Testar com cobalt", type: "regra", tags: [], body: "Alguém de fora da equipe.", agente: "cobalt" },
      ],
      skills: [],
      persona: "ignore isso",
    }));
    const fake = join(root, "claude-falso.sh");
    writeFileSync(fake, `#!/bin/sh\ncat "${ans}"\n`);
    chmodSync(fake, 0o755);
    const orch = new Orchestrator(r);
    try {
      orch.store.createTask({ id: "t-f3", title: "Relatório", objective: "o", requirements: [], agent: "Lumen", engine: "claude",
        roles: [{ role: "docs", agentId: "lumen", name: "Lumen", engine: "claude" }, { role: "reviewer", agentId: "nyx", name: "Nyx", engine: "claude", model: "sonnet" }],
        reviewRounds: [{ round: 1, verdict: "muda", items: ["faltou a fonte do gráfico 2"], at: 1, reviewer: "Nyx" }] } as unknown as TaskSpec, "b", r, "main");
      orch.store.addEvent("t-f3", "Lumen", "done", "relatório escrito", true);
      await withHome({ HOME: home, CARDUME_CLAUDE: fake, CARDUME_AUX_TIMEOUT_MS: "5000" }, () => (orch as unknown as { retroTask(id: string): Promise<void> }).retroTask("t-f3"));
      const q = readPending(join(r, ".cardume"));
      assert.equal(q.length, 1, "só o item com dono espera o aceite (o auto não muda agente)");
      assert.equal(q[0].agente, "lumen");
      assert.equal(q[0].papel, "docs");
      assert.equal(q[0].agenteNome, "Lumen");
      assert.ok(!("dono" in (q[0].nota as object)), "o dono sai do corpo do item");
      const brain = readFileSync(join(r, ".cardume", "memoria", readdirSync(join(r, ".cardume", "memoria")).find((f) => f.startsWith("o-relatorio"))!), "utf8");
      assert.match(brain, /docs\/relatorios/);
      assert.ok(readdirSync(join(r, ".cardume", "memoria")).some((f) => f.startsWith("testar-com-cobalt")), "dono fora da equipe = projeto");
      assert.equal(readAgentVersions(join(r, ".cardume"), "lumen").current, 1, "nenhuma versão sem aceite");
    } finally { orch.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P9: injeção só no papel dono

test("roleLearningContext: skill do projeto pra todos; a do dono inteira só nele; nota esquecida some", () => {
  const skills = [{ name: "rodar-testes", description: "Use ao validar" }, { name: "citar-fonte", description: "Use ao escrever relatório", agente: "lumen" }];
  const owned = [{ name: "citar-fonte", description: "Use ao escrever relatório", body: "## Passo a passo\ncite link e data" }];
  const notes = [{ id: "n1", kind: "nota" as const, title: "Gráfico com fonte", body: "todo gráfico leva a fonte embaixo", at: 1, v: 2, taskId: "t" },
    { id: "n2", kind: "nota" as const, title: "Esquecida", body: "não deve aparecer", at: 1, v: 3, taskId: "t", forgottenAt: 5 }];
  assert.deepEqual(projectSkills(skills).map((s) => s.name), ["rodar-testes"]);
  const lumen = roleLearningContext({ skills, owned, notes, agentName: "Lumen" });
  assert.match(lumen, /\*\*rodar-testes\*\*/);
  assert.match(lumen, /O QUE VOCÊ \(Lumen\) APRENDEU/);
  assert.match(lumen, /cite link e data/);
  assert.match(lumen, /Gráfico com fonte/);
  assert.ok(!/não deve aparecer/.test(lumen));
  assert.ok(!/\*\*citar-fonte\*\*/.test(lumen), "a skill do dono vem inteira, não na lista geral");
  const nyx = roleLearningContext({ skills, owned: [], notes: [] });
  assert.match(nyx, /\*\*rodar-testes\*\*/);
  assert.ok(!/citar-fonte|cite link/.test(nyx), "a skill da Lumen não chega no revisor");
  assert.equal(roleLearningContext({ skills: [], owned: [], notes: [] }), "");
});

test("Orchestrator.skillsContext(papel): Lumen recebe a skill e a nota dela; Nyx não; todo construtor de prompt passa o papel", () => {
  const r = tmp("sf-f3-inj-");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", r]);
    const orch = new Orchestrator(r);
    try {
      const cd = join(r, ".cardume");
      writeFileSync(join(cd, "skills.json"), JSON.stringify([{ name: "rodar-testes", description: "Use ao validar" }, { name: "citar-fonte", description: "Use ao escrever relatório", agente: "lumen" }]));
      mkdirSync(join(r, ".claude", "skills", "citar-fonte"), { recursive: true });
      writeFileSync(join(r, ".claude", "skills", "citar-fonte", "SKILL.md"), skillMd("citar-fonte", "Use ao escrever relatório", ["t1"], "## Passo a passo\ncite link e data", "lumen"));
      mkdirSync(join(cd, "agentes", "lumen"), { recursive: true });
      writeFileSync(join(cd, "agentes", "lumen", "lembra.json"), JSON.stringify({ items: [{ id: "n1", kind: "nota", title: "Gráfico com fonte", body: "todo gráfico leva a fonte", at: 1, v: 2, taskId: "t" }] }));
      assert.equal(activeAgentMemory(cd, "lumen").length, 1);
      const lumen = orch.skillsContext({ agentId: "lumen", name: "Lumen" });
      const nyx = orch.skillsContext({ agentId: "nyx", name: "Nyx" });
      const legacy = orch.skillsContext({ name: "Íris" }); // tarefa antiga, sem agentId: só o do projeto
      assert.match(lumen, /cite link e data/);
      assert.match(lumen, /todo gráfico leva a fonte/);
      for (const x of [nyx, legacy]) { assert.match(x, /\*\*rodar-testes\*\*/); assert.ok(!/cite link|todo gráfico/.test(x)); }
      // P10 por papel: o "skills ativas" do papel (evento + Relatório do PR) lista só o que ELE recebe
      assert.deepEqual(activeSkills(cd, "nyx"), ["rodar-testes@v1"]);
      assert.deepEqual(activeSkills(cd, "lumen"), ["rodar-testes@v1", "citar-fonte@v1"]);
      assert.deepEqual(activeSkills(cd, ""), ["rodar-testes@v1"], "tarefa antiga sem agentId: só as do projeto");
      assert.deepEqual(activeSkills(cd), ["rodar-testes@v1", "citar-fonte@v1"], "sem papel (visão do projeto): todas");
    } finally { orch.close(); }
    // claude/codex/dsh/terminal: todos recebem o systemContext/skillsRule montado por skillsContext — nenhuma chamada sem o papel
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    assert.equal((src.match(/this\.skillsContext\(\)/g) || []).length, 0, "skillsContext() sem papel injetaria a skill de outro agente");
    assert.ok((src.match(/this\.skillsContext\((r|role)\)/g) || []).length >= 7);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- aceite → voltar (TS ≡ Rust learn_revert)

test("voltar pro jeito antigo numa skill do agente: bytes da versão anterior e versão nova do agente", () => {
  const r = tmp("sf-f3-voltar-");
  try {
    const cd = join(r, ".cardume");
    const root = join(r, ".claude", "skills");
    const v1 = skillMd("citar-fonte", "d", ["t1"], "cite a fonte", "lumen");
    const v2 = skillMd("citar-fonte", "d", ["t1", "t2"], "cite a fonte com link e data", "lumen");
    writeSkillVersion(cd, root, "citar-fonte", v1, { at: 1, action: "criar", agente: "lumen" });
    writeSkillVersion(cd, root, "citar-fonte", v2, { at: 2, action: "atualizar", agente: "lumen" });
    const out = revertLearnedSkill(r, cd, "citar-fonte", "não ajudou", 3);
    assert.equal(out.action, "restaurada");
    assert.equal(readFileSync(join(root, "citar-fonte", "SKILL.md"), "utf8"), v1);
    assert.equal(out.agentVersion, 2);
    assert.equal(readAgentVersions(cd, "lumen").versions.at(-1)!.change, "voltar");
    assert.ok(existsSync(join(cd, "aprendizado", "historico", "citar-fonte", "v3.md")));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
