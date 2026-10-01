// node --test src/claude-statusline.test.ts  (npm test)
// Barra de status do Claude Code (spec-medidor-v2-statusline): install/uninstall/status com HOME temporário — sem
// barra anterior, com anterior encadeada, settings inválido, idempotência, desinstalar = arquivo idêntico ao de antes,
// anterior perdido (volta pelo backup), anterior que não é objeto, settings mudou no meio, CLAUDE_CONFIG_DIR, barra do
// projeto que substitui a nossa, node inválido/sumido; o script gerado rodado com o JSON de exemplo grava o arquivo e
// imprime a linha (ou a saída da anterior, com prazo de 2 s). Contrato com o Rust: tests/fixtures/plan-usage-golden/statusline.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, uninstall, status, slPaths, slCommand, isOurs, nodeOfCommand, claudeConfigDir, slTestHooks } from "./claude-statusline.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const GOLDEN = JSON.parse(readFileSync(new URL("../tests/fixtures/plan-usage-golden/statusline.json", import.meta.url), "utf8")) as {
  commands: { node: string; script: string; command: string }[];
  settings: { name: string; text: string; installed: boolean; node: string | null }[];
  script: { stdin: unknown; file: Record<string, unknown>; line: string };
};
const NODE = process.execPath;
const SAMPLE = GOLDEN.script.stdin;
const cleanEnv = (home: string, extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  if (!("CLAUDE_CONFIG_DIR" in extra)) delete env.CLAUDE_CONFIG_DIR;
  return env;
};

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "sf-statusline-"));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
const put = (home: string, text: string) => { mkdirSync(join(home, ".claude"), { recursive: true }); writeFileSync(slPaths(home).settings, text); };
const settings = (home: string) => readFileSync(slPaths(home).settings, "utf8");
const runScript = (home: string, input: string) =>
  spawnSync(process.execPath, [slPaths(home).script], { input, encoding: "utf8", env: cleanEnv(home) });
const fakeNode = (home: string, name: string) => { const f = join(home, name); writeFileSync(f, ""); return f; };

test("golden compartilhado com o Rust: comando gravado, node do comando e detecção 'instalada'", () => {
  for (const c of GOLDEN.commands) {
    assert.equal(slCommand(c.node, c.script), c.command);
    assert.equal(nodeOfCommand(c.command), c.node);
  }
  for (const g of GOLDEN.settings) {
    let v: { statusLine?: { command?: unknown } } | null = null;
    try { v = JSON.parse(g.text); } catch { /* quebrado */ }
    assert.equal(isOurs(v?.statusLine), g.installed, g.name);
    const cmd = v?.statusLine && typeof v.statusLine === "object" ? v.statusLine.command : undefined;
    assert.equal(g.installed && typeof cmd === "string" ? nodeOfCommand(cmd) : null, g.node, g.name);
  }
});

test("instalar sem barra anterior: statusLine do Starfork, backup exato, outras chaves preservadas; desinstalar apaga o backup", () => {
  withHome((home) => {
    const orig = '{\n    "model": "opus",\n    "theme": "dark"\n}\n';
    put(home, orig);
    const r = install({ home, node: NODE });
    assert.equal(r.ok, true);
    assert.equal(r.chained, false);
    const s = JSON.parse(settings(home));
    assert.equal(s.model, "opus");
    assert.equal(s.theme, "dark");
    assert.equal(s.statusLine.type, "command");
    assert.equal(s.statusLine.command, slCommand(NODE, slPaths(home).script));
    assert.ok(isOurs(s.statusLine));
    assert.match(settings(home), /^\{\n {4}"model"/, "mantém a indentação do arquivo");
    assert.equal(readFileSync(slPaths(home).backup, "utf8"), orig);
    assert.ok(existsSync(slPaths(home).script));
    assert.deepEqual(JSON.parse(readFileSync(slPaths(home).prev, "utf8")), { v: 1, existed: true, had: false, statusLine: null });
    assert.ok(!readdirSync(join(home, ".claude")).some((f) => f.endsWith(".tmp")), "sem .tmp sobrando");
    const st = status({ home });
    assert.equal(st.installed, true);
    assert.equal(st.nodeOk, true);
    assert.equal(st.node, NODE);
    // desinstalar → idêntico ao de antes (byte a byte) e sem sobras
    const u = uninstall({ home });
    assert.equal(u.ok, true);
    assert.equal(settings(home), orig);
    assert.equal(status({ home }).installed, false);
    assert.ok(!existsSync(slPaths(home).prev) && !existsSync(slPaths(home).script) && !existsSync(slPaths(home).backup));
  });
});

test("instalar com barra anterior: guardada, encadeada, e volta exata ao desinstalar", () => {
  withHome((home) => {
    const orig = JSON.stringify({ statusLine: { type: "command", command: "echo minha-barra", padding: 1 }, model: "x" }, null, 2) + "\n";
    put(home, orig);
    const r = install({ home, node: NODE });
    assert.equal(r.chained, true);
    assert.match(r.message, /continua aparecendo/);
    const s = JSON.parse(settings(home));
    assert.ok(isOurs(s.statusLine));
    assert.equal(s.statusLine.padding, 1, "padding da anterior mantido");
    assert.deepEqual(Object.keys(s), ["statusLine", "model"], "mesma ordem de chaves");
    assert.deepEqual(JSON.parse(readFileSync(slPaths(home).prev, "utf8")).statusLine, { type: "command", command: "echo minha-barra", padding: 1 });
    // a barra roda a anterior com o mesmo stdin e imprime a saída dela — e ainda grava a %
    const out = runScript(home, JSON.stringify(SAMPLE));
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "minha-barra\n");
    assert.ok(existsSync(slPaths(home).data));
    const prevFile = readFileSync(slPaths(home).prev, "utf8");
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, had: true, statusLine: { type: "command", command: "cat" } }));
    assert.equal(runScript(home, '{"a":1}').stdout, '{"a":1}', "stdin chega igual na anterior");
    writeFileSync(slPaths(home).prev, prevFile);
    uninstall({ home });
    assert.equal(settings(home), orig);
  });
});

test("anterior perdido (statusline-prev.json apagado/corrompido): a barra de antes volta pelo backup", () => {
  for (const broken of [null, "{lixo"]) {
    withHome((home) => {
      const orig = '{"statusLine":{"type":"command","command":"echo antes"},"model":"m"}';
      put(home, orig);
      install({ home, node: NODE });
      if (broken === null) rmSync(slPaths(home).prev); else writeFileSync(slPaths(home).prev, broken);
      assert.equal(status({ home }).chained, true, "status também enxerga a anterior pelo backup");
      const u = uninstall({ home });
      assert.equal(u.ok, true);
      assert.equal(settings(home), orig);
    });
  }
});

test("anterior que não é objeto é guardado e devolvido EXATAMENTE (sem encadear)", () => {
  for (const val of ["texto", null, 7]) {
    withHome((home) => {
      const orig = JSON.stringify({ statusLine: val, theme: "x" });
      put(home, orig);
      const r = install({ home, node: NODE });
      assert.equal(r.chained, false);
      assert.ok(isOurs(JSON.parse(settings(home)).statusLine));
      assert.equal(runScript(home, JSON.stringify(SAMPLE)).stdout, GOLDEN.script.line + "\n");
      // edita outra chave pra forçar a re-serialização (não o backup byte a byte)
      const s = JSON.parse(settings(home)); s.theme = "y"; put(home, JSON.stringify(s));
      uninstall({ home });
      assert.deepEqual(JSON.parse(settings(home)), { statusLine: val, theme: "y" }, String(val));
    });
  }
});

test("idempotente: instalar 2× não guarda a própria barra como anterior nem troca o backup", () => {
  withHome((home) => {
    const a = fakeNode(home, "node-a"), b = fakeNode(home, "node-b");
    const orig = '{"statusLine":{"type":"command","command":"echo antes"}}';
    put(home, orig);
    install({ home, node: a });
    const again = install({ home, node: a });
    assert.equal(again.changed, false);
    const moved = install({ home, node: b });
    assert.equal(moved.changed, true, "node mudou: só o comando é atualizado");
    assert.equal(nodeOfCommand(JSON.parse(settings(home)).statusLine.command), b);
    assert.equal(JSON.parse(readFileSync(slPaths(home).prev, "utf8")).statusLine.command, "echo antes");
    assert.equal(readFileSync(slPaths(home).backup, "utf8"), orig);
    // node sumiu → status avisa (o app reinstala no boot)
    rmSync(b);
    assert.equal(status({ home }).nodeOk, false);
    assert.match(status({ home }).message, /precisa reparar/);
    uninstall({ home });
    assert.equal(settings(home), orig, "sem quebra de linha final: igual também");
    assert.equal(uninstall({ home }).changed, false, "desinstalar de novo: nada a fazer");
  });
});

test("node inválido: caminho relativo ou inexistente → 'node não encontrado', nada muda", () => {
  withHome((home) => {
    put(home, '{"model":"x"}');
    for (const n of ["node", "./node", "/nao/existe/node"]) {
      const r = install({ home, node: n });
      assert.equal(r.ok, false, n);
      assert.match(r.message, /^node não encontrado/);
    }
    assert.equal(settings(home), '{"model":"x"}');
    assert.ok(!existsSync(slPaths(home).backup));
  });
});

test("settings inválido: não mexe em nada e devolve erro humano", () => {
  withHome((home) => {
    put(home, "{ quebrado");
    const r = install({ home, node: NODE });
    assert.equal(r.ok, false);
    assert.match(r.message, /não é um JSON válido — não mexi em nada/);
    assert.equal(settings(home), "{ quebrado");
    assert.ok(!existsSync(slPaths(home).backup) && !existsSync(slPaths(home).prev));
    put(home, "[1,2]");
    assert.equal(install({ home, node: NODE }).ok, false);
    assert.equal(uninstall({ home }).ok, false);
  });
});

test("settings mudou entre a leitura e a gravação: aborta com erro humano e não sobrescreve", () => {
  withHome((home) => {
    put(home, '{"model":"a"}');
    slTestHooks.beforeCommit = () => put(home, '{"model":"outro programa"}');
    try {
      const r = install({ home, node: NODE });
      assert.equal(r.ok, false);
      assert.match(r.message, /mudou enquanto eu mexia/);
      assert.equal(settings(home), '{"model":"outro programa"}');
      assert.ok(!readdirSync(join(home, ".claude")).some((f) => f.endsWith(".tmp")));
    } finally { slTestHooks.beforeCommit = undefined; }
    // mesma proteção no desinstalar
    install({ home, node: NODE });
    slTestHooks.beforeCommit = () => put(home, '{"model":"z"}');
    try {
      const u = uninstall({ home });
      assert.equal(u.ok, false);
      assert.equal(settings(home), '{"model":"z"}');
    } finally { slTestHooks.beforeCommit = undefined; }
  });
});

test("sem settings.json: cria só com a barra; desinstalar apaga o arquivo criado", () => {
  withHome((home) => {
    const r = install({ home, node: NODE });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(JSON.parse(settings(home))), ["statusLine"]);
    uninstall({ home });
    assert.ok(!existsSync(slPaths(home).settings));
  });
});

test("outras chaves mudaram depois da instalação: desinstalar preserva a mudança e tira só a barra", () => {
  withHome((home) => {
    put(home, '{"model":"a"}\n');
    install({ home, node: NODE });
    const s = JSON.parse(settings(home));
    s.model = "b";
    put(home, JSON.stringify(s, null, 2) + "\n");
    uninstall({ home });
    assert.deepEqual(JSON.parse(settings(home)), { model: "b" });
  });
});

test("CLAUDE_CONFIG_DIR: a config do Claude fica onde ele aponta (home explícito nunca lê o ambiente)", () => {
  withHome((home) => {
    assert.equal(claudeConfigDir(undefined, { CLAUDE_CONFIG_DIR: "/x/cfg" }), "/x/cfg");
    assert.equal(claudeConfigDir(undefined, { CLAUDE_CONFIG_DIR: "  " }).endsWith(".claude"), true);
    assert.equal(claudeConfigDir(home, { CLAUDE_CONFIG_DIR: "/x/cfg" }), join(home, ".claude"));
    const cfg = join(home, "cfg");
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "claude-statusline", "install", "--node", NODE, "--json"],
      { encoding: "utf8", env: cleanEnv(home, { CLAUDE_CONFIG_DIR: cfg }) });
    assert.equal(JSON.parse(r.stdout).ok, true, r.stderr);
    assert.ok(isOurs(JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).statusLine));
    assert.ok(!existsSync(join(home, ".claude", "settings.json")), "não tocou em ~/.claude");
  });
});

test("status: barra do projeto aberto (.claude/settings*.json com statusLine) substitui a nossa → avisa", () => {
  withHome((home) => {
    install({ home, node: NODE });
    const repo = join(home, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    assert.deepEqual(status({ home, repo }).overriddenBy, []);
    writeFileSync(join(repo, ".claude", "settings.json"), '{"model":"x"}');
    writeFileSync(join(repo, ".claude", "settings.local.json"), '{"statusLine":{"type":"command","command":"echo proj"}}');
    assert.deepEqual(status({ home, repo }).overriddenBy, [join(repo, ".claude", "settings.local.json")]);
  });
});

test("script: JSON com rate_limits grava o arquivo (formato do golden) e imprime a linha curta", () => {
  withHome((home) => {
    install({ home, node: NODE });
    const t0 = Date.now();
    const out = runScript(home, JSON.stringify(SAMPLE));
    assert.equal(out.status, 0);
    assert.equal(out.stdout, GOLDEN.script.line + "\n");
    const d = JSON.parse(readFileSync(slPaths(home).data, "utf8"));
    assert.ok(d.at >= t0 && d.at <= Date.now());
    delete d.at;
    assert.deepEqual(d, GOLDEN.script.file);
    assert.ok(!readdirSync(slPaths(home).dir).some((f) => f.endsWith(".tmp")));
    const one = runScript(home, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12 } } }));
    assert.equal(one.stdout, "semana 12%\n");
    assert.deepEqual(JSON.parse(readFileSync(slPaths(home).data, "utf8")).fiveHour, null);
  });
});

test("script: sem rate_limits não grava; JSON ruim → linha mínima; anterior lenta (> 2 s) ou falha → linha do Starfork", () => {
  withHome((home) => {
    install({ home, node: NODE });
    const a = runScript(home, JSON.stringify({ model: { display_name: "Sonnet" } }));
    assert.equal(a.status, 0);
    assert.equal(a.stdout, "Sonnet\n");
    assert.ok(!existsSync(slPaths(home).data));
    const b = runScript(home, "{lixo");
    assert.equal(b.status, 0);
    assert.equal(b.stdout, "Claude\n");
    const c = runScript(home, JSON.stringify({ rate_limits: { five_hour: { used_percentage: "x" } } }));
    assert.equal(c.stdout, "Claude\n");
    assert.ok(!existsSync(slPaths(home).data));
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, had: true, statusLine: { type: "command", command: "exit 3" } }));
    assert.equal(runScript(home, JSON.stringify(SAMPLE)).stdout, GOLDEN.script.line + "\n");
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, had: true, statusLine: { type: "command", command: "sleep 6; echo tarde" } }));
    const t0 = Date.now();
    assert.equal(runScript(home, JSON.stringify(SAMPLE)).stdout, GOLDEN.script.line + "\n");
    assert.ok(Date.now() - t0 < 4500, "prazo de 2 s pra anterior");
  });
});

test("CLI: claude-statusline install|status|uninstall --json com HOME temporário", () => {
  withHome((home) => {
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "claude-statusline", ...args, "--json"], { encoding: "utf8", env: cleanEnv(home) });
      return { code: r.status, out: JSON.parse(r.stdout) };
    };
    assert.equal(cli("install", "--node", NODE).out.installed, true);
    assert.equal(nodeOfCommand(JSON.parse(settings(home)).statusLine.command), NODE);
    const st = cli("status").out;
    assert.equal(st.installed, true);
    assert.equal(st.nodeOk, true);
    assert.equal(cli("uninstall").out.installed, false);
    assert.equal(cli("install", "--node", "node").out.message, "node não encontrado: node");
    put(home, "nope");
    const bad = cli("install");
    assert.equal(bad.code, 1);
    assert.equal(bad.out.ok, false);
  });
});
