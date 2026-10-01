// node --test src/claude-statusline.test.ts  (npm test)
// Barra de status do Claude Code (spec-medidor-v2-statusline): install/uninstall/status com HOME temporário — sem
// barra anterior, com anterior encadeada, settings inválido, idempotência, desinstalar = arquivo idêntico ao de antes;
// o script gerado rodado com o JSON de exemplo grava o arquivo e imprime a linha (ou a saída da anterior).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, uninstall, status, slPaths, isOurs } from "./claude-statusline.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SAMPLE = {
  model: { id: "claude-opus", display_name: "Opus" },
  rate_limits: { five_hour: { used_percentage: 43, resets_at: 1790884800 }, seven_day: { used_percentage: 61.4, resets_at: 1791400000 } },
};

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "sf-statusline-"));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
const put = (home: string, text: string) => { mkdirSync(join(home, ".claude"), { recursive: true }); writeFileSync(slPaths(home).settings, text); };
const settings = (home: string) => readFileSync(slPaths(home).settings, "utf8");
const runScript = (home: string, input: string) =>
  spawnSync(process.execPath, [slPaths(home).script], { input, encoding: "utf8", env: { ...process.env, HOME: home } });

test("instalar sem barra anterior: statusLine do Starfork, backup exato, outras chaves preservadas", () => {
  withHome((home) => {
    const orig = '{\n    "model": "opus",\n    "theme": "dark"\n}\n';
    put(home, orig);
    const r = install({ home, node: "/opt/node/bin/node" });
    assert.equal(r.ok, true);
    assert.equal(r.chained, false);
    const s = JSON.parse(settings(home));
    assert.equal(s.model, "opus");
    assert.equal(s.theme, "dark");
    assert.equal(s.statusLine.type, "command");
    assert.equal(s.statusLine.command, `"/opt/node/bin/node" "${slPaths(home).script}"`);
    assert.ok(isOurs(s.statusLine));
    assert.match(settings(home), /^\{\n {4}"model"/, "mantém a indentação do arquivo");
    assert.equal(readFileSync(slPaths(home).backup, "utf8"), orig);
    assert.ok(existsSync(slPaths(home).script));
    assert.deepEqual(JSON.parse(readFileSync(slPaths(home).prev, "utf8")), { v: 1, existed: true, statusLine: null });
    assert.ok(!readdirSync(join(home, ".claude")).some((f) => f.endsWith(".tmp")), "sem .tmp sobrando");
    assert.equal(status({ home }).installed, true);
    // desinstalar → idêntico ao de antes (byte a byte)
    const u = uninstall({ home });
    assert.equal(u.ok, true);
    assert.equal(settings(home), orig);
    assert.equal(status({ home }).installed, false);
    assert.ok(!existsSync(slPaths(home).prev) && !existsSync(slPaths(home).script));
  });
});

test("instalar com barra anterior: guardada, encadeada, e volta exata ao desinstalar", () => {
  withHome((home) => {
    const orig = JSON.stringify({ statusLine: { type: "command", command: "echo minha-barra", padding: 1 }, model: "x" }, null, 2) + "\n";
    put(home, orig);
    const r = install({ home, node: process.execPath });
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
    // stdin chega igual na anterior
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, statusLine: { type: "command", command: "cat" } }));
    assert.equal(runScript(home, '{"a":1}').stdout, '{"a":1}');
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, statusLine: { type: "command", command: "echo minha-barra", padding: 1 } }));
    uninstall({ home });
    assert.equal(settings(home), orig);
  });
});

test("idempotente: instalar 2× não guarda a própria barra como anterior nem troca o backup", () => {
  withHome((home) => {
    const orig = '{"statusLine":{"type":"command","command":"echo antes"}}';
    put(home, orig);
    install({ home, node: "/a/node" });
    const again = install({ home, node: "/a/node" });
    assert.equal(again.changed, false);
    const moved = install({ home, node: "/b/node" });
    assert.equal(moved.changed, true, "node mudou: só o comando é atualizado");
    assert.match(JSON.parse(settings(home)).statusLine.command, /^"\/b\/node"/);
    assert.equal(JSON.parse(readFileSync(slPaths(home).prev, "utf8")).statusLine.command, "echo antes");
    assert.equal(readFileSync(slPaths(home).backup, "utf8"), orig);
    uninstall({ home });
    assert.equal(settings(home), orig, "sem quebra de linha final: igual também");
    assert.equal(uninstall({ home }).changed, false, "desinstalar de novo: nada a fazer");
  });
});

test("settings inválido: não mexe em nada e devolve erro humano", () => {
  withHome((home) => {
    put(home, "{ quebrado");
    const r = install({ home });
    assert.equal(r.ok, false);
    assert.match(r.message, /não é um JSON válido — não mexi em nada/);
    assert.equal(settings(home), "{ quebrado");
    assert.ok(!existsSync(slPaths(home).backup) && !existsSync(slPaths(home).prev));
    put(home, "[1,2]");
    assert.equal(install({ home }).ok, false);
    assert.equal(uninstall({ home }).ok, false);
  });
});

test("sem settings.json: cria só com a barra; desinstalar apaga o arquivo criado", () => {
  withHome((home) => {
    const r = install({ home, node: "/n" });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(JSON.parse(settings(home))), ["statusLine"]);
    uninstall({ home });
    assert.ok(!existsSync(slPaths(home).settings));
  });
});

test("outras chaves mudaram depois da instalação: desinstalar preserva a mudança e tira só a barra", () => {
  withHome((home) => {
    put(home, '{"model":"a"}\n');
    install({ home, node: "/n" });
    const s = JSON.parse(settings(home));
    s.model = "b";
    put(home, JSON.stringify(s, null, 2) + "\n");
    uninstall({ home });
    assert.deepEqual(JSON.parse(settings(home)), { model: "b" });
  });
});

test("script: JSON com rate_limits grava o arquivo e imprime a linha curta", () => {
  withHome((home) => {
    install({ home, node: process.execPath });
    const t0 = Date.now();
    const out = runScript(home, JSON.stringify(SAMPLE));
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "5h 43% · semana 61%\n");
    const d = JSON.parse(readFileSync(slPaths(home).data, "utf8"));
    assert.deepEqual(d.fiveHour, { pct: 43, resetsAt: 1790884800000 });
    assert.deepEqual(d.sevenDay, { pct: 61.4, resetsAt: 1791400000000 });
    assert.ok(d.at >= t0 && d.at <= Date.now());
    assert.ok(!readdirSync(slPaths(home).dir).some((f) => f.endsWith(".tmp")));
    // só uma janela
    const one = runScript(home, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12 } } }));
    assert.equal(one.stdout, "semana 12%\n");
    assert.deepEqual(JSON.parse(readFileSync(slPaths(home).data, "utf8")).fiveHour, null);
  });
});

test("script: sem rate_limits não grava; JSON ruim → linha mínima; nunca falha", () => {
  withHome((home) => {
    install({ home, node: process.execPath });
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
    // anterior que falha/sem saída → a linha do Starfork
    writeFileSync(slPaths(home).prev, JSON.stringify({ v: 1, existed: true, statusLine: { type: "command", command: "exit 3" } }));
    assert.equal(runScript(home, JSON.stringify(SAMPLE)).stdout, "5h 43% · semana 61%\n");
  });
});

test("CLI: claude-statusline install|status|uninstall --json com HOME temporário", () => {
  withHome((home) => {
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "claude-statusline", ...args, "--json"], { encoding: "utf8", env: { ...process.env, HOME: home } });
      return { code: r.status, out: JSON.parse(r.stdout) };
    };
    assert.equal(cli("install", "--node", "/x/node").out.installed, true);
    assert.match(settings(home), /\\"\/x\/node\\"/);
    assert.equal(cli("status").out.installed, true);
    assert.equal(cli("uninstall").out.installed, false);
    put(home, "nope");
    const bad = cli("install");
    assert.equal(bad.code, 1);
    assert.equal(bad.out.ok, false);
  });
});
