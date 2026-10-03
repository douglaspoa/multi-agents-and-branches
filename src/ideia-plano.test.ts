// node --test src/ideia-plano.test.ts  (npm test)
// "Começar por uma ideia" (spec-ideia-mesa-pesquisa): a decisão da mesa vira um épico BMAD que o normalizePlan do
// piloto aceita SEM perder nada (tarefas, ondas, pronto quando, não-objetivos) e a pesquisa vai junto no --plan
// (docs/pesquisa-<slug>.md no 1º commit do projeto criado pelo piloto, motor mock).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePlan, planDocs, runAutopilot, FIRST_COMMIT_MSG } from "./autopilot.ts";
import { tempHome } from "./testing/temp-home.ts";

const read = (f: string) => readFileSync(new URL("../app/src/js/" + f, import.meta.url), "utf8");
const cut = (s: string, a: string, b: string) => { const i = s.indexOf(a), j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, "trecho: " + a); return s.slice(i, j); };
// o trecho puro da Mesa (personas, apuração) + o da Ideia — o MESMO código que roda na aba
const F = new Function(cut(read("38-mesa.js"), "// @puro-inicio", "// @puro-fim") + cut(read("59-ideia.js"), "// @ideia-puro-inicio", "// @ideia-puro-fim") +
  "\nreturn { ideiaBuildPlan, ideiaDecisionView, ideiaPanel, ideiaReportMd, ideiaCheckReport, ideiaSlug };")() as Record<string, (...a: any[]) => any>;

const REPORT = JSON.stringify({
  resumo: "Há procura por rotinas guiadas.",
  demanda: [{ texto: "Busca por 'skincare routine app' cresceu em 2026", rotulo: "fato", fontes: ["https://trends.example.com/skincare"] }],
  tendencias: [{ texto: "Rotinas curtas viraram tendência", rotulo: "inferencia", fontes: [] }],
  concorrentes: [{ nome: "SkinTrack", url: "https://skintrack.example.com", texto: "app de rotina", rotulo: "fato", fontes: ["https://skintrack.example.com"] }],
  reclamacoes: [], publico: [], riscos: [],
  veredito: { resposta: "talvez", confianca: "media", texto: "Há espaço com nicho claro.", porque: [] },
});

function decided() {
  const ps = F.ideiaPanel();
  const r1 = { n: 1, tipo: "posicao", resp: Object.fromEntries(ps.map((p: any) => [p.id, { st: "ok", texto: "x", propostas: [], naoObjetivos: ["login social"], plataforma: "mobile" }])) };
  const cands = [{ id: "F1", titulo: "Montar a rotina da manhã e da noite", descricao: "passos em ordem", autores: ["Bia"] }, { id: "F2", titulo: "Lembrete na hora certa", descricao: "notificação local", autores: ["Marcos"] }, { id: "F3", titulo: "Loja de produtos", descricao: "e-commerce", autores: ["Carla"] }];
  const vote = (top: [string, number][], vetos: unknown[] = []) => ({ st: "ok", texto: "ok", plataforma: "mobile", voto: { fala: "ok", top: top.map(([id, peso]) => ({ id, peso, porque: "" })), vetos } });
  const r2 = { n: 2, tipo: "voto", resp: Object.fromEntries(ps.map((p: any) => [p.id, vote([["F1", 3], ["F2", 2]], p.id === "julia" ? [{ id: "F3", motivo: "fora do foco" }] : [])])) };
  return { status: "ok", rounds: [r1, r2], cands, escolhas: {}, plataforma: "" };
}

test("decisão → épico: o normalizePlan aceita sem perder tarefa, onda, pronto quando nem não-objetivo", () => {
  const idea = { titulo: "App de rotina de skincare com lembretes", report: { status: "ok", data: F.ideiaCheckReport(REPORT).report } };
  const view = F.ideiaDecisionView(decided(), F.ideiaPanel());
  assert.deepEqual(view.mvp.map((f: any) => f.id), ["F1", "F2"], "a vetada fica de fora do MVP");
  assert.equal(view.plataforma, "mobile");
  assert.ok(view.naoObjetivos.some((x: string) => /Loja de produtos/.test(x)) && view.naoObjetivos.includes("login social"));
  const md = F.ideiaReportMd(idea.report.data, idea.titulo, {});
  const raw = F.ideiaBuildPlan(idea, view, md);
  const ep = normalizePlan(JSON.parse(JSON.stringify(raw)), idea.titulo, raw.platform);
  assert.equal(ep.tasks.length, 3, "esqueleto + 2 features");
  assert.equal(ep.tasks[0].wave, 0);
  assert.deepEqual(ep.tasks.slice(1).map((t) => t.wave), [1, 1]);
  assert.deepEqual(ep.tasks.slice(1).map((t) => t.after), [[ep.tasks[0].id], [ep.tasks[0].id]]);
  assert.match(ep.tasks[0].title, /Esqueleto do app \(iOS \+ Android\)/);
  assert.ok(ep.tasks[0].requirements.some((r) => /cardume mobile/.test(r)), "prova mobile no esqueleto");
  assert.deepEqual(ep.requirements.map((r) => r.id), ["R1", "R2"]);
  assert.deepEqual(ep.tasks.slice(1).map((t) => t.covers), [["R1"], ["R2"]]);
  assert.equal(ep.doneWhen.length, 3);
  assert.ok(ep.boundaries.includes("login social"));
  assert.match(ep.outcome, /vale a pena agora\? Talvez/);
  const docs = planDocs(raw);
  assert.deepEqual(docs.map((d) => d.path), ["docs/pesquisa-rotina-skincare-lembretes.md"]);
  assert.match(docs[0].content, /\[fato\]\*\* Busca por 'skincare routine app'.*\[1\]\(https:\/\/trends\.example\.com\/skincare\)/);
});

test("planDocs: só docs/<nome>.md, sem duplicar, no máximo 4 — o resto é ignorado", () => {
  const d = planDocs({ docs: [{ path: "docs/a.md", content: "# a" }, { path: "docs/a.md", content: "dup" }, { path: "../fora.md", content: "x" }, { path: "docs/sub/x.md", content: "x" }, { path: "docs/vazio.md", content: "  " }, { path: "README.md", content: "x" }, { path: "docs/b.md", content: "b" }, { path: "docs/c.md", content: "c" }, { path: "docs/d.md", content: "d" }, { path: "docs/e.md", content: "e" }] });
  assert.deepEqual(d.map((x) => x.path), ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]);
  assert.deepEqual(planDocs(null), []);
  assert.deepEqual(planDocs({ docs: "x" }), []);
});

test("piloto com o plano da ideia (motor mock): a pesquisa entra no 1º commit e o épico roda inteiro", async () => {
  const h = tempHome();
  const keys = ["HOME", "CARDUME_MOCK_SPEED", "CARDUME_NOTIFY"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: h.home, CARDUME_MOCK_SPEED: "50", CARDUME_NOTIFY: "0" });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-ideia-")));
  try {
    const idea = { titulo: "App de rotina de skincare com lembretes", report: { status: "ok", data: F.ideiaCheckReport(REPORT).report } };
    const view = F.ideiaDecisionView(decided(), F.ideiaPanel());
    view.plataforma = "web"; // o mock prova web sem simulador
    const raw = F.ideiaBuildPlan(idea, view, F.ideiaReportMd(idea.report.data, idea.titulo, {}));
    const planFile = join(root, "plan.json");
    writeFileSync(planFile, JSON.stringify(raw));
    const dir = join(root, "rotina-skincare");
    const st = await runAutopilot({ idea: idea.titulo, dir, engine: "mock", platform: "web", planFile, log: () => {} });
    assert.equal(st.phase, "done");
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    const first = git("rev-list", "--max-parents=0", "HEAD");
    assert.equal(git("log", "-1", "--format=%s", first), FIRST_COMMIT_MSG);
    assert.match(git("show", "--name-only", "--format=", first), /docs\/pesquisa-rotina-skincare-lembretes\.md/);
    assert.match(readFileSync(join(dir, "docs/pesquisa-rotina-skincare-lembretes.md"), "utf8"), /## Fontes/);
    assert.equal(st.tasks.filter((t) => t.stage === "merged").length, 4, "esqueleto + 2 features + verificação final");
    assert.equal(git("remote"), "", "sem remoto");
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    h.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
