// Provas no PR: branch órfão starfork-provas (git puro, remote bare file://), markdown do relatório, opção do
// projeto × repositório público, falha que não bloqueia, e o caminho completo do openPr com um gh falso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachProofs, proofDecision, proofKind, proofRelPath, proofUrl, PROVAS_BRANCH, PROVAS_SETTING_KEY, pushProofs, readProofSetting, replaceReport } from "./pr-provas.ts";
import { starforkReport, type ReportData } from "./lifecycle.ts";
import { Orchestrator } from "./orchestrator.ts";
import { tempHome } from "./testing/temp-home.ts";
import type { TaskSpec } from "./types.ts";

const POSIX = { skip: process.platform === "win32" };
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const spec = (id: string, extra: Partial<TaskSpec> = {}) =>
  ({ id, title: id, objective: "o", agent: "Vega", roles: [{ role: "builder", name: "Vega", engine: "claude" }], engine: "claude", deliverables: ["d1"], requirements: [], scope: { owns: [], offLimits: [] }, autonomy: { clarifications: "ask", commit: "at-end", runTests: false, approval: "auto" }, autoPr: "no", ...extra }) as TaskSpec;

/** repo com origin = remote bare via file:// (o push de verdade, sem rede) */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-provas-t-")));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  for (const [k, v] of [["user.email", "dono@exemplo.dev"], ["user.name", "dono"], ["commit.gpgsign", "false"]]) git(repo, "config", k, v);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", "file://" + origin);
  git(repo, "push", "-q", "origin", "main");
  const h = tempHome();
  return { root, repo, origin, home: h.home, done: () => { h.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}
/** gh falso: repo view (visibilidade em vis.txt), pr create/view/edit guardando o corpo em body.md */
function fakeGh(root: string, vis = "PRIVATE"): { gh: string; dir: string } {
  const dir = join(root, "gh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vis.txt"), vis);
  const gh = join(dir, "gh.sh");
  writeFileSync(gh, `#!/bin/sh
D='${dir}'
printf '%s\\n' "$*" >> "$D/argv.log"
case "$1 $2" in
  "repo view") [ -f "$D/falha" ] && { echo "HTTP 401: Bad credentials" >&2; exit 1; }; echo "{\\"nameWithOwner\\":\\"o/r\\",\\"visibility\\":\\"$(cat "$D/vis.txt")\\"}";;
  "pr create") while [ $# -gt 0 ]; do [ "$1" = "--body" ] && printf '%s' "$2" > "$D/body.md"; shift; done; echo "https://github.com/o/r/pull/77";;
  "pr view") cat "$D/body.md";;
  "pr edit") echo "GraphQL: Projects (classic) is being deprecated" >&2; exit 1;;
  "api -X") [ "$3" = "PATCH" ] || exit 1; while [ $# -gt 0 ]; do case "$1" in body=*) printf '%s' "\${1#body=}" > "$D/body.md";; esac; shift; done;;
  *) echo "gh falso: $*" >&2; exit 1;;
esac
`);
  chmodSync(gh, 0o755);
  return { gh, dir };
}
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("tipos, caminho seguro no branch e URL ?raw=true (imagem) / blob (vídeo)", () => {
  assert.equal(proofKind("a.PNG"), "img");
  assert.equal(proofKind("x.webp"), "img");
  assert.equal(proofKind("v.mov"), "video");
  assert.equal(proofKind("tests.md"), null);
  assert.equal(proofRelPath("minha-tarefa", ".cardume/artifacts/mobile ios 1.png"), "minha-tarefa/mobile-ios-1.png");
  assert.equal(proofRelPath("t", "../../etc/passwd.png"), "t/etc__passwd.png", "sem subir de pasta");
  assert.equal(proofRelPath("../x", "shots/a.png"), "x/shots__a.png");
  assert.equal(proofUrl("o/r", "t/a b.png", "img"), "https://github.com/o/r/blob/starfork-provas/t/a%20b.png?raw=true");
  assert.equal(proofUrl("o/r", "t/v.mp4", "video"), "https://github.com/o/r/blob/starfork-provas/t/v.mp4");
});

test("decisão: on/off mandam; sem decisão, privado sobe e público/desconhecido pergunta", () => {
  assert.equal(proofDecision("", "PRIVATE"), "upload");
  assert.equal(proofDecision("", "INTERNAL"), "upload");
  assert.equal(proofDecision("", "PUBLIC"), "ask");
  assert.equal(proofDecision("", ""), "ask");
  assert.equal(proofDecision("on", "PUBLIC"), "upload");
  assert.equal(proofDecision("off", "PRIVATE"), "off");
});

test("relatório: miniatura clicável + legenda por requisito; sem prova continua 'sem prova'; nota em itálico", () => {
  const base: ReportData = { requirements: [], costByRole: [], totalUsd: 0, capUsd: 2, releases: [], rounds: [], runs: [] };
  const d: ReportData = { ...base, requirements: [
    { text: "lista", status: "provado", evidence: ["mobile-ios-1.png", "tests.md"] },
    { text: "vídeo", status: "provado", evidence: ["fluxo.mp4"] },
    { text: "csv", status: "sem prova", evidence: [] },
  ], proofs: { "mobile-ios-1.png": { url: "https://github.com/o/r/blob/starfork-provas/t/mobile-ios-1.png?raw=true", kind: "img" }, "fluxo.mp4": { url: "https://github.com/o/r/blob/starfork-provas/t/fluxo.mp4", kind: "video" } } };
  const md = starforkReport(d);
  assert.match(md, /\| lista \| provado<br>!\[R1\]\(https:\/\/github\.com\/o\/r\/blob\/starfork-provas\/t\/mobile-ios-1\.png\?raw=true\)<br>`mobile-ios-1\.png`<br>`tests\.md` \|/);
  assert.match(md, /\| vídeo \| provado<br>\[▶ fluxo\.mp4\]\(https:\/\/github\.com\/o\/r\/blob\/starfork-provas\/t\/fluxo\.mp4\) \|/);
  assert.match(md, /\| csv \| sem prova \|/);
  assert.match(md, /branch `starfork-provas`/);
  // falha: lista de nomes de sempre + o motivo
  const f = starforkReport({ ...d, proofs: undefined, proofNote: "não consegui anexar as provas (sem rede)" });
  assert.match(f, /\| lista \| provado — `mobile-ios-1\.png`, `tests\.md` \|/);
  assert.match(f, /^\*não consegui anexar as provas \(sem rede\)\*$/m);
  assert.doesNotMatch(f, /!\[/);
});

test("replaceReport: troca só a seção, mantém o rodapé e a linha de auditoria 'Aprovado sem prova'", () => {
  const body = "## O quê\nx\n\n## Relatório Starfork\n\n| a | b |\n\n**Aprovado sem prova** por Ana: depois\n\n**Custo:** US$ 1,00\n\n_Aberto pelo agente no terminal do Starfork (requisitos provados)._";
  const novo = "## Relatório Starfork\n\n| a | ![R1](u) |\n\n**Custo:** US$ 2,00\n";
  const r = replaceReport(body, novo);
  assert.ok(r.startsWith("## O quê\nx\n\n## Relatório Starfork\n\n| a | ![R1](u) |"), r);
  assert.match(r, /\*\*Aprovado sem prova\*\* por Ana: depois\n\n\*\*Custo:\*\* US\$ 2,00/);
  assert.doesNotMatch(r, /US\$ 1,00/);
  assert.ok(r.trimEnd().endsWith("_Aberto pelo agente no terminal do Starfork (requisitos provados)._"));
  assert.equal(replaceReport("só texto", novo), "só texto\n\n" + novo);
  assert.equal(replaceReport(r, novo), r, "idempotente");
});

test("pushProofs: branch ÓRFÃO no remoto (file://), <tarefa>/<arq>, branch da tarefa intocado, idempotente, autor sem e-mail da pessoa", POSIX, async () => {
  const f = fixture();
  try {
    const art = join(f.root, "art");
    mkdirSync(art);
    writeFileSync(join(art, "tela 1.png"), "PNG-1");
    writeFileSync(join(art, "fluxo.mp4"), "MP4");
    writeFileSync(join(art, "grande.mov"), Buffer.alloc(9 * 1024 * 1024, 1));
    const head0 = git(f.repo, "rev-parse", "HEAD");
    const files = [{ name: "tela 1.png", path: join(art, "tela 1.png") }, { name: "fluxo.mp4", path: join(art, "fluxo.mp4") }, { name: "grande.mov", path: join(art, "grande.mov") }, { name: "x.md", path: join(art, "x.md") }];
    const r = await pushProofs({ dir: f.repo, prefix: "t1", files, slug: "o/r" });
    assert.equal(r.pushed, true);
    assert.deepEqual(Object.keys(r.links).sort(), ["fluxo.mp4", "tela 1.png"]);
    assert.equal(r.links["tela 1.png"].url, "https://github.com/o/r/blob/starfork-provas/t1/tela-1.png?raw=true");
    assert.match(r.skipped.map((s) => s.name + ":" + s.why).join(), /grande\.mov:grande demais \(9,0 MB/);
    assert.equal(git(f.origin, "ls-tree", "-r", "--name-only", PROVAS_BRANCH), "t1/fluxo.mp4\nt1/tela-1.png");
    assert.equal(git(f.origin, "show", `${PROVAS_BRANCH}:t1/tela-1.png`), "PNG-1");
    assert.equal(git(f.origin, "rev-list", "--count", PROVAS_BRANCH), "1");
    assert.equal(spawnSync("git", ["-C", f.origin, "merge-base", "main", PROVAS_BRANCH]).status, 1, "órfão: sem ancestral comum com main");
    assert.equal(git(f.origin, "log", "-1", "--format=%an <%ae>", PROVAS_BRANCH), "Starfork <provas@starfork.invalid>");
    assert.equal(git(f.repo, "rev-parse", "HEAD"), head0, "HEAD/branch atual intocados");
    assert.equal(git(f.repo, "status", "--porcelain"), "", "worktree e índice intocados");
    assert.equal(git(f.repo, "branch", "--list", PROVAS_BRANCH), "", "não cria branch local");
    // de novo, mesmo conteúdo → sem commit
    const again = await pushProofs({ dir: f.repo, prefix: "t1", files, slug: "o/r" });
    assert.equal(again.pushed, false);
    assert.equal(again.links["fluxo.mp4"].url, r.links["fluxo.mp4"].url);
    assert.equal(git(f.origin, "rev-list", "--count", PROVAS_BRANCH), "1");
    // outra tarefa, de OUTRO clone (ponta local desatualizada) → acrescenta sem apagar a primeira
    const clone = join(f.root, "clone");
    execFileSync("git", ["clone", "-q", "file://" + f.origin, clone]);
    await pushProofs({ dir: clone, prefix: "t2", files: [{ name: "b.png", path: join(art, "tela 1.png") }], slug: "o/r" });
    writeFileSync(join(art, "tela 1.png"), "PNG-1-nova");
    await pushProofs({ dir: f.repo, prefix: "t1", files: files.slice(0, 1), slug: "o/r" });
    assert.equal(git(f.origin, "ls-tree", "-r", "--name-only", PROVAS_BRANCH), "t1/fluxo.mp4\nt1/tela-1.png\nt2/b.png");
    assert.equal(git(f.origin, "show", `${PROVAS_BRANCH}:t1/tela-1.png`), "PNG-1-nova", "prova refeita substitui");
    assert.equal(git(f.origin, "rev-list", "--count", PROVAS_BRANCH), "3");
  } finally { f.done(); }
});

test("attachProofs: público pergunta (nada sobe) → 'on' grava e sobe; 'off' não sobe; gh falhando vira nota e não lança", POSIX, async () => {
  const f = fixture();
  const { gh, dir } = fakeGh(f.root, "PUBLIC");
  try {
    const p = join(f.root, "a.png");
    writeFileSync(p, "PNG");
    const files = [{ name: "a.png", path: p }];
    await withEnv({ CARDUME_GH: gh }, async () => {
      const ask = await attachProofs({ dir: f.repo, prefix: "t", files });
      assert.equal(ask.needConfirm, true);
      assert.equal(ask.visibility, "PUBLIC");
      assert.match(ask.note, /repositório é PÚBLICO/);
      assert.deepEqual(ask.links, {});
      assert.equal(spawnSync("git", ["-C", f.origin, "rev-parse", "--verify", "-q", PROVAS_BRANCH]).status, 1, "nada subiu sem confirmar");
      const off = await attachProofs({ dir: f.repo, prefix: "t", files, decide: "off" });
      assert.deepEqual([off.links, off.note, off.needConfirm], [{}, "", undefined]);
      assert.equal(readProofSetting(f.repo), "off");
      const on = await attachProofs({ dir: f.repo, prefix: "t", files, decide: "on" });
      assert.equal(on.links["a.png"].url, "https://github.com/o/r/blob/starfork-provas/t/a.png?raw=true");
      assert.equal(git(f.repo, "config", "--get", PROVAS_SETTING_KEY), "on", "opção do projeto no .git/config");
      writeFileSync(join(dir, "falha"), "1");
      const bad = await attachProofs({ dir: f.repo, prefix: "t", files });
      assert.deepEqual(bad.links, {});
      assert.match(bad.note, /^não consegui anexar as provas \(não consegui ler o repositório no GitHub: HTTP 401/);
      rmSync(join(dir, "falha"));
      // remoto inválido: o push falha → nota, sem lançar
      git(f.repo, "remote", "set-url", "origin", "file://" + join(f.root, "nao-existe.git"));
      const np = await attachProofs({ dir: f.repo, prefix: "t2", files });
      assert.match(np.note, /^não consegui anexar as provas \(/);
      // sem mídia: nem pergunta ao gh
      const none = await attachProofs({ dir: f.repo, prefix: "t", files: [{ name: "x.md", path: p }] });
      assert.deepEqual(none.links, {});
    });
  } finally { f.done(); }
});

test("openPr (motor) com gh falso: provas no branch órfão, miniaturas no corpo; PR aberto + prova nova = corpo reescrito; CLI pr-provas/pr-relatorio", POSIX, async () => {
  const f = fixture();
  const { gh, dir } = fakeGh(f.root, "PRIVATE");
  const orch = new Orchestrator(f.repo);
  try {
    await withEnv({ CARDUME_GH: gh, HOME: f.home, CARDUME_NOTIFY: "0" }, async () => {
      const t = await orch.createTask(spec("provas-t", { requirements: ["tela", "csv"], prBase: "main" }));
      const art = join(t.worktree, ".cardume", "artifacts");
      mkdirSync(art, { recursive: true });
      writeFileSync(join(art, "tela-1.png"), "PNG-A");
      writeFileSync(join(art, "requirements.json"), JSON.stringify([{ req: "tela", status: "done", evidence: ["tela-1.png"] }, { req: "csv", status: "blocked", evidence: [] }]));
      const r = await orch.openPr("provas-t", { draft: true, title: "PR" });
      assert.deepEqual(r, { ok: true, url: "https://github.com/o/r/pull/77" });
      const body = readFileSync(join(dir, "body.md"), "utf8");
      assert.match(body, /\| tela \| provado<br>!\[R1\]\(https:\/\/github\.com\/o\/r\/blob\/starfork-provas\/provas-t\/tela-1\.png\?raw=true\)<br>`tela-1\.png` \|/);
      assert.match(body, /\| csv \| sem prova \|/);
      assert.equal(git(f.origin, "show", `${PROVAS_BRANCH}:provas-t/tela-1.png`), "PNG-A");
      assert.equal(git(f.origin, "ls-tree", "-r", "--name-only", t.branch).includes("tela-1.png"), false, "a prova NÃO entra no branch da tarefa");
      // prova nova com o PR aberto → "atualizar" reescreve o relatório no corpo
      writeFileSync(join(art, "csv.png"), "PNG-B");
      writeFileSync(join(art, "requirements.json"), JSON.stringify([{ req: "tela", status: "done", evidence: ["tela-1.png"] }, { req: "csv", status: "done", evidence: ["csv.png"] }]));
      const u = await orch.openPr("provas-t");
      assert.equal(u.ok, true);
      const body2 = readFileSync(join(dir, "body.md"), "utf8");
      assert.match(body2, /\| csv \| provado<br>!\[R2\]\(https:\/\/github\.com\/o\/r\/blob\/starfork-provas\/provas-t\/csv\.png\?raw=true\)/);
      assert.equal(body2.split("## Relatório Starfork").length, 2, "uma seção só");
      assert.match(body2, /^## O quê/);
      // CLI (o que o app chama): pr-provas devolve JSON com os links; pr-relatorio reescreve com o relatório do app
      orch.close();
      const env = { ...process.env, CARDUME_GH: gh, HOME: f.home, CARDUME_NOTIFY: "0" };
      const j = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "pr-provas", "provas-t", "--repo", f.repo], { encoding: "utf8", env }));
      assert.equal(j.links["csv.png"].kind, "img");
      const bad = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "pr-provas", "provas-t", "--decide", "talvez", "--repo", f.repo], { encoding: "utf8", env });
      assert.equal(bad.status, 1);
      const rf = join(f.root, "rel.md");
      writeFileSync(rf, "## Relatório Starfork\n\n**Aprovado sem prova** por Ana: x\n\n**Custo:** US$ 0,00\n");
      const badUrl = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "pr-relatorio", "provas-t", "--file", rf, "--url", "https://evil.example/x", "--repo", f.repo], { encoding: "utf8", env });
      assert.match(badUrl.stdout, /--url não é um PR do GitHub/);
      const w = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "pr-relatorio", "provas-t", "--file", rf, "--url", "https://github.com/o/r/pull/77", "--repo", f.repo], { encoding: "utf8", env }));
      assert.deepEqual(w, { changed: true });
      assert.match(readFileSync(join(dir, "body.md"), "utf8"), /\*\*Aprovado sem prova\*\* por Ana: x/);
      assert.ok(existsSync(join(dir, "argv.log")));
    });
  } finally { try { orch.close(); } catch { /* já fechado */ } f.done(); }
});

test("nomes diferentes que dão o mesmo caminho no branch não se sobrescrevem (sufixo -2)", POSIX, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "1.png"), "UM");
    writeFileSync(join(f.root, "2.png"), "DOIS");
    const r = await pushProofs({ dir: f.repo, prefix: "t", files: [{ name: "a b.png", path: join(f.root, "1.png") }, { name: "a-b.png", path: join(f.root, "2.png") }], slug: "o/r" });
    assert.equal(git(f.origin, "ls-tree", "-r", "--name-only", PROVAS_BRANCH), "t/a-b-2.png\nt/a-b.png");
    assert.equal(git(f.origin, "show", `${PROVAS_BRANCH}:t/a-b-2.png`), "DOIS");
    assert.notEqual(r.links["a b.png"].url, r.links["a-b.png"].url);
  } finally { f.done(); }
});
