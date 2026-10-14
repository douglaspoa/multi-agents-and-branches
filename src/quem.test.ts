// node --test src/quem.test.ts  (npm test)
// QUEM ESTÁ FALANDO (bug 14/10): um colega assumiu a demanda do dono do time, mandou "teste" e a IA o chamou pelo nome
// do DONO. Aqui, com duas contas fictícias — Dora cria a tarefa e escreve a memória do time; Pedro assume na máquina
// dele e manda "teste" — TODO prompt e arquivo gerado na máquina do Pedro fala com o Pedro e nenhum diz que quem fala é
// a Dora. A IA é um binário FALSO que só grava o argv (nunca o `claude` de verdade); HOME e config do Claude Code em
// pastas temporárias.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanName, quemFile, readSpeaker, speakerLine, speakerTag } from "./quem.ts";
import type { TaskSpec } from "./types.ts";

const POSIX = { skip: process.platform === "win32" ? "POSIX-only (binário falso com shebang)" : false };
const root = realpathSync(mkdtempSync(join(tmpdir(), "starfork-quem-")));
const LOG = join(root, "argv.log");
const ENV_KEYS = ["HOME", "USERPROFILE", "CARDUME_CLAUDE", "CLAUDE_CONFIG_DIR", "CARDUME_AI_BIN_claude", "CARDUME_NOTIFY", "CARDUME_CLAUDE_EXIT_GRACE_MS", "CARDUME_USER_NAME"];
const saved: Record<string, string | undefined> = {};

const calls = (): string[][] => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const flag = (argv: string[], f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? "" : ""; };

/** "máquina" = um HOME com a conta logada (o que o app grava em ~/.constellation/quem.json) */
function machine(name: string, who: string | null): string {
  const home = join(root, `home-${name}`);
  mkdirSync(join(home, ".constellation"), { recursive: true });
  writeFileSync(join(home, ".constellation", "settings.json"), JSON.stringify({ learnMode: "desligado" }));
  process.env.HOME = home; process.env.USERPROFILE = home;
  login(who);
  return home;
}
function login(who: string | null) {
  if (who) writeFileSync(quemFile(), JSON.stringify({ name: who, uid: "u-" + who.split(" ")[0].toLowerCase() }));
  else rmSync(quemFile(), { force: true });
}

/** repo do time: a memória do TIME foi escrita na máquina da Dora (inclusive a nota "pessoa" que o destilador gravava) */
function teamRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("config", "user.email", "t@t"); g("config", "user.name", "Dora Lima"); g("config", "commit.gpgsign", "false"); // git de outra pessoa: não vale
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const time = join(repo, ".cardume", "memoria", "time");
  mkdirSync(time, { recursive: true });
  writeFileSync(join(time, "usuario.md"), "---\ntitle: Nome do usuário do checkout\ntype: pessoa\ntags: [checkout]\nby: destilador · correção de Dora Lima no chat da tarefa checkout\n---\nO usuário se chama Dora e aprova o checkout.\n");
  return repo;
}

const spec = (id: string): TaskSpec =>
  ({
    id, title: "checkout em um passo", objective: "refazer o checkout", deliverables: [], requirements: [],
    scope: { owns: [], offLimits: [] },
    autonomy: { clarifications: "assume", commit: "at-end", runTests: false, approval: "auto" },
    engine: "claude", agent: "Íris", light: true, base: "main", autoPr: "no",
    roles: [{ role: "builder", name: "Íris", engine: "claude" }],
  }) as unknown as TaskSpec;

/** todos os arquivos de texto gerados na worktree (.cardume, AGENTS.md…) */
function generated(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === ".git" || f === "node_modules") continue;
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 512_000 && /\.(md|ya?ml|json|txt)$/.test(f)) out.push({ file: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.CARDUME_USER_NAME; // o atalho antigo: não é mais fonte de nome
  const fake = join(root, "fake-claude");
  writeFileSync(fake,
    `#!/usr/bin/env node\nconst fs = require("fs");\nfs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
    `console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-quem", model: "fake" }));\n` +
    `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-quem" }));\n`);
  chmodSync(fake, 0o755);
  process.env.CARDUME_CLAUDE = fake;
  process.env.CARDUME_AI_BIN_claude = fake;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-cfg"); mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  process.env.CARDUME_NOTIFY = "0";
  process.env.CARDUME_CLAUDE_EXIT_GRACE_MS = "300";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* o SO limpa o tmp */ }
});

test("fixture dourado: nome limpo e o bloco 'quem está falando' iguais ao Rust (quem.rs)", () => {
  const gold = JSON.parse(readFileSync(fileURLToPath(new URL("../tests/fixtures/memoria-golden/quem.json", import.meta.url)), "utf8"));
  for (const c of gold) {
    assert.equal(cleanName(c.in), c.name, c.in);
    assert.equal(speakerLine(c.in), c.line, c.in);
  }
  assert.equal(cleanName("pessoa sem nome"), "", "rótulo de tela não é nome");
  assert.match(speakerTag(""), /trate por "você", sem chutar nome/);
});

test("duas contas: Dora cria, Pedro assume e manda 'teste' → tudo na máquina do Pedro fala com o Pedro", POSIX, async () => {
  const { Orchestrator } = await import("./orchestrator.ts");
  const { aiLaunch } = await import("./terminal.ts");

  // --- máquina da Dora: cria e roda (a IA fala com a Dora)
  machine("dora", "Dora Lima");
  const repoD = teamRepo("repo-dora");
  const orchD = new Orchestrator(repoD);
  try {
    await orchD.createTask(spec("t1"));
    writeFileSync(LOG, "");
    await orchD.runTask("t1");
    const sysD = calls().map((a) => flag(a, "--append-system-prompt")).filter(Boolean);
    assert.ok(sysD.length && sysD.every((s) => s.includes("Você está conversando com Dora Lima")), "na máquina da Dora, com a Dora");
  } finally { orchD.close(); }

  // --- máquina do Pedro: assumiu o cartão (o app cria a tarefa local dele) e manda "teste"
  machine("pedro", "Pedro Alves");
  assert.equal(readSpeaker(), "Pedro Alves");
  const repoP = teamRepo("repo-pedro"); // mesma memória do time (sincronizada), git user.name ainda "Dora Lima"
  const orchP = new Orchestrator(repoP);
  try {
    await orchP.createTask(spec("t1"));
    writeFileSync(LOG, "");
    await orchP.runTask("t1");
    await orchP.talkToAgent("t1", "teste");
    const all = calls();
    assert.ok(all.length >= 2, "rodou e conversou");
    const resumed = all.filter((a) => a.includes("--resume"));
    assert.ok(resumed.length, "o 'teste' retomou a sessão (sem system prompt de novo)");
    for (const a of resumed) assert.match(flag(a, "-p"), /^\[Mensagem de Pedro Alves, a pessoa logada no Starfork nesta máquina/, "o turno retomado diz quem fala");
    const turns = all.filter((a) => a.includes("--append-system-prompt") || a.includes("--resume")); // turnos do agente (a IA auxiliar — resumo de commit — não conversa com ninguém)
    assert.ok(turns.length >= 2);
    assert.ok(turns.some((a) => flag(a, "--append-system-prompt").includes("O usuário se chama Dora")), "a nota 'pessoa' da Dora chega ao agente (é o que confundia)");
    for (const a of all) assert.doesNotMatch(a.join("\n"), /conversando com Dora|Mensagem de Dora|Douglas/, "nem a IA auxiliar");
    for (const a of turns) {
      const txt = a.join("\n");
      assert.ok(txt.includes("Pedro Alves"), "todo turno do agente identifica o Pedro: " + txt.slice(0, 300));
      assert.doesNotMatch(txt, /conversando com Dora|Mensagem de Dora|Douglas/, "ninguém diz que quem fala é a Dora (nem nome fixo)");
      const sys = flag(a, "--append-system-prompt");
      if (sys.includes("O usuário se chama Dora")) {
        assert.ok(sys.indexOf("Você está conversando com Pedro Alves") < sys.indexOf("O usuário se chama Dora"), "quem fala vem antes das notas");
        assert.match(sys, /por destilador · correção de Dora Lima/, "a nota do time aparece como ESCRITA pela Dora");
      }
    }
    // instrução enviada no meio da execução (fila → --resume): também diz quem fala
    writeFileSync(LOG, "");
    await orchP.createTask(spec("t2"));
    orchP.store.addInstruction("t2", "troca o texto do botão");
    await orchP.runTask("t2"); // a fila de instruções é aplicada ao fim do turno, retomando a sessão
    const instr = calls().filter((a) => a.includes("--resume") && flag(a, "-p").includes("troca o texto do botão"));
    assert.ok(instr.length, "a instrução foi aplicada retomando a sessão: " + JSON.stringify(calls().map((a) => [a.includes("--resume"), flag(a, "-p").slice(0, 80)])) + orchP.store.getTask("t2")!.status);
    for (const a of instr) assert.match(flag(a, "-p"), /^\[Mensagem de Pedro Alves/);
    // terminal integrado: as instruções viram arquivo na worktree — com o Pedro
    const L = aiLaunch(orchP, "t1", "claude", { resume: false });
    assert.match(flag(L.args, "--append-system-prompt"), /Você está conversando com Pedro Alves/);
    const wt = orchP.store.getTask("t1")!.worktree;
    const files = generated(wt);
    assert.ok(files.some((f) => f.file.endsWith("AGENTS.starfork.md") && f.text.includes("Você está conversando com Pedro Alves")));
    for (const f of files) assert.doesNotMatch(f.text, /conversando com Dora|Mensagem de Dora|Douglas/, f.file);
  } finally { orchP.close(); }

  // --- a tarefa da Dora assumida NA MESMA máquina (troca de conta): o arquivo é reescrito, não congela quem criou
  process.env.HOME = join(root, "home-dora"); process.env.USERPROFILE = process.env.HOME;
  const orchD2 = new Orchestrator(repoD);
  try {
    aiLaunch(orchD2, "t1", "claude", { resume: false });
    const wt = orchD2.store.getTask("t1")!.worktree;
    assert.match(readFileSync(join(wt, ".cardume", "term", "AGENTS.starfork.md"), "utf8"), /conversando com Dora Lima/);
    login("Pedro Alves");
    aiLaunch(orchD2, "t1", "claude", { resume: false });
    const rules = readFileSync(join(wt, ".cardume", "term", "AGENTS.starfork.md"), "utf8");
    assert.match(rules, /Você está conversando com Pedro Alves/);
    assert.doesNotMatch(rules, /conversando com Dora/);
    // saiu da conta: sem nome chutado (nem o git user.name "Dora Lima" do repo, nem o usuário do sistema)
    login(null);
    writeFileSync(LOG, "");
    await orchD2.talkToAgent("t1", "teste");
    const noAcc = calls().filter((a) => a.includes("--append-system-prompt") || a.includes("--resume"));
    assert.ok(noAcc.length, "conversou");
    for (const a of noAcc) {
      const txt = a.join("\n");
      assert.doesNotMatch(txt, /conversando com|Mensagem de (Dora|Pedro)/);
      assert.match(txt, /trate por "você"/);
    }
  } finally { orchD2.close(); }
});
