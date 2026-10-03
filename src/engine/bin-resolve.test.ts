import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { clearResolveCache, needsNode, newestFirst, notFoundMsg, parseShellLookup, resolveIn, toolPath, type ResolveCtx } from "./bin-resolve.ts";
import { codexFriendlyError, codexSpawnError } from "./codex.ts";

// Fixture COMPARTILHADO com o Rust (bin_resolve.rs) — o mesmo algoritmo nos dois lados
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "tests", "fixtures", "bin-resolve", "cases.json"), "utf8"));

interface Case { name: string; files: string[]; contents?: Record<string, string>; path: string[]; node?: string; override?: string; shell?: null | "hang" | { print: string[] }; expect: string | null; searched?: string[] }

function world(c: Case) {
  const base = mkdtempSync(join(tmpdir(), "binres-"));
  const home = join(base, "home"), root = join(base, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  const map = (p: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : join(root, p));
  const put = (p: string, body: string, exec: boolean) => {
    const f = map(p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
    if (exec) chmodSync(f, 0o755);
  };
  for (const f of c.files) put(f, "#!/bin/sh\necho fake\n", true);
  for (const [p, body] of Object.entries(c.contents ?? {})) put(p, body, false);
  for (const d of c.path) mkdirSync(map(d), { recursive: true });
  let shell: string | undefined;
  if (c.shell) {
    shell = join(base, "fake-shell");
    const body = c.shell === "hang" ? "#!/bin/sh\nsleep 20\n" : "#!/bin/sh\n" + c.shell.print.map((l) => `echo '${l.startsWith("~/") ? map(l) : l}'`).join("\n") + "\n";
    writeFileSync(shell, body);
    chmodSync(shell, 0o755);
  }
  const ctx: ResolveCtx = {
    home, root, shell, shellTimeoutMs: 1500,
    path: c.path.map(map).join(delimiter),
    nodeDirs: c.node ? [map(c.node)] : [],
    override: c.override ? map(c.override) : undefined,
  };
  return { base, ctx, map };
}

for (const c of FIX.cases as Case[]) {
  test(`resolvedor (fixture compartilhado): ${c.name}`, () => {
    clearResolveCache();
    const { base, ctx, map } = world(c);
    try {
      const t0 = Date.now();
      const r = resolveIn("codex", ctx);
      assert.equal(r.bin, c.expect === null ? null : map(c.expect));
      for (const s of c.searched ?? []) assert.ok(r.searched.some((x) => x.includes(s)), `procurou em "${s}"? ${JSON.stringify(r.searched)}`);
      if (c.shell === "hang") assert.ok(Date.now() - t0 < 6000, "o timeout do shell de login segurou");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("versões ordenadas por número (v22 > v9 > v18? não: v22 > v18 > v9)", () => {
  assert.deepEqual(newestFirst(["v9.0.0", "v22.3.0", "v18.20.1", "v22.14.0"]), ["v22.14.0", "v22.3.0", "v18.20.1", "v9.0.0"]);
});

test("saída do shell de login: ignora lixo, alias e caminho inexistente", () => {
  const ok = (p: string) => p === "/x/bin/codex";
  assert.equal(parseShellLookup("Bem-vindo!\nalias codex='npx codex'\n/nao/existe/codex\n/x/bin/codex\n", ok), "/x/bin/codex");
  assert.equal(parseShellLookup("codex: aliased to npx codex\n", ok), null);
  assert.equal(parseShellLookup("", ok), null);
});

test("ENOENT só vira 'não encontrado' quando o resolvedor não achou nada — e lista onde procurou", () => {
  const err = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const none = { bin: null, via: "", searched: ["/usr/bin", "~/.nvm/versions/node/v22.3.0/bin", "~/.volta/bin", "/opt/homebrew/bin", "/Applications/ChatGPT.app/Contents/Resources"] };
  const msg = codexSpawnError(err, "codex", none);
  assert.match(msg, /O Codex não foi encontrado neste computador/);
  assert.match(msg, /Procurei em:/);
  for (const s of none.searched) assert.ok(msg.includes(s), `lista ${s}`);
  assert.match(msg, /npm i -g @openai\/codex/);
  // achou, mas o spawn falhou: NUNCA diz "não foi encontrado"
  const dir = mkdtempSync(join(tmpdir(), "binres-found-"));
  const fb = join(dir, "codex");
  writeFileSync(fb, "#!/nao/existe/node\n");
  const found = { bin: fb, via: "nvm", searched: [] };
  const m2 = codexSpawnError(err, found.bin, found);
  assert.doesNotMatch(m2, /não foi encontrado/);
  assert.match(m2, /foi encontrado em .*binres-found-/);
  assert.match(m2, /rodar de novo/);
  const m3 = codexSpawnError(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), found.bin, found);
  assert.match(m3, /permissão de execução/);
  rmSync(dir, { recursive: true, force: true });
  assert.match(notFoundMsg("O X", "npm i -g x", none), /• ~\/\.volta\/bin/);
});

test("cada classe de erro do Codex vira frase humana e recuperável", () => {
  const cases: [string, RegExp][] = [
    ["Error: 401 Unauthorized: Your refresh token has expired. Please log in again.", /não está logado.*codex login/s],
    ["You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", /limite de uso.*Espere/s],
    ["429 Too Many Requests: rate limit", /limite de uso/],
    ["stream disconnected before completion: error sending request for url", /Caiu a conexão.*internet/s],
    ["Error: getaddrinfo ENOTFOUND chatgpt.com", /Caiu a conexão/],
    ["Error: thread not found: 0199-abc", /sessão anterior do Codex não foi encontrada/],
    ["context window exceeded: maximum context length", /longa demais/],
    ["env: node: No such file or directory", /precisa do Node\.js/],
    ["unexpected status 500 Internal Server Error", /O Codex parou com um erro/],
  ];
  for (const [raw, re] of cases) {
    const h = codexFriendlyError(raw);
    assert.match(h, re, raw);
    assert.doesNotMatch(h.split("\n")[0], /^\{|^Error:/, "a 1ª linha é humana, não JSON/stack");
  }
});

test("PATH do processo: pasta do binário e de um node NA FRENTE do PATH mínimo do Finder", () => {
  const base = mkdtempSync(join(tmpdir(), "binres-path-"));
  try {
    const nvm = join(base, "nvm", "bin"), other = join(base, "node22", "bin");
    mkdirSync(nvm, { recursive: true }); mkdirSync(other, { recursive: true });
    writeFileSync(join(nvm, "codex"), "#!/usr/bin/env node\nconsole.log('ok')\n");
    chmodSync(join(nvm, "codex"), 0o755);
    const p = toolPath(join(nvm, "codex"), "/usr/bin:/bin:/usr/sbin:/sbin", [other]);
    const parts = p.split(delimiter);
    assert.equal(parts[0], nvm);
    assert.equal(parts[1], other);
    assert.deepEqual(parts.slice(-4), ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    assert.ok(needsNode(join(nvm, "codex")), "shim do npm precisa de node");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("PATH mínimo de verdade: um processo com env -i acha o codex desta máquina (se houver um instalado)", (t) => {
  const real = spawnSync("/bin/sh", ["-lc", "command -v codex"], { encoding: "utf8" }).stdout.trim();
  if (!real) { t.skip("sem codex nesta máquina"); return; }
  const code = `import { resolveIn, liveCtx } from ${JSON.stringify(join(import.meta.dirname, "bin-resolve.ts"))}; const r = resolveIn("codex", liveCtx("codex")); console.log(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  assert.ok(out.bin, `achou com PATH mínimo: ${r.stdout}${r.stderr}`);
  const v = spawnSync(out.bin, ["--version"], { encoding: "utf8", env: { HOME: process.env.HOME ?? "", PATH: toolPath(out.bin, "/usr/bin:/bin:/usr/sbin:/sbin") } });
  assert.equal(v.status, 0, `codex --version roda com o PATH montado: ${v.stderr}`);
  assert.match(v.stdout, /codex/i);
});

test("pipeline parado diz O MOTIVO e a saída (antes: 'não concluiu (timeout/erro)')", async () => {
  const { Orchestrator } = await import("../orchestrator.ts");
  const n = Orchestrator.stoppedNote("builder", "O Codex não foi encontrado neste computador — instale.\n\nProcurei em:\n  • ~/.nvm");
  assert.match(n, /^pipeline parado: o papel builder não concluiu — O Codex não foi encontrado neste computador — instale\. Depois de resolver, clique em "rodar de novo"/);
  assert.doesNotMatch(n, /timeout\/erro|\.\./);
  const n2 = Orchestrator.stoppedNote("builder", 'O Codex foi encontrado em /x, mas não consegui iniciá-lo. Reinstale e clique em "rodar de novo".');
  assert.equal((n2.match(/rodar de novo/g) || []).length, 1, "sem repetir a saída");
  assert.match(Orchestrator.stoppedNote("tester", ""), /sem detalhes/);
});

test("classes de erro do Codex → o orquestrador sabe o que fazer (espera limite, retoma rede, recomeça sessão perdida, para no login)", async () => {
  const { Orchestrator } = await import("../orchestrator.ts");
  const h = (raw: string) => codexFriendlyError(raw);
  assert.ok(Orchestrator.usageLimitDeath(h("You've hit your usage limit. Try again at 3:05 PM.")), "limite → espera e retoma");
  assert.ok(Orchestrator.retriableDeath(h("stream disconnected before completion")), "rede → retoma sozinho");
  assert.ok(Orchestrator.retriableDeath(h("Error: getaddrinfo ENOTFOUND chatgpt.com")), "DNS → retoma sozinho");
  assert.ok(Orchestrator.sessionMissing(h("thread not found: 0199")), "sessão perdida → turno novo");
  const login = h("401 Unauthorized: refresh token expired, please log in again");
  assert.ok(!Orchestrator.retriableDeath(login) && !Orchestrator.usageLimitDeath(login), "login NÃO fica em loop: para com a frase e a ação");
  assert.match(Orchestrator.stoppedNote("builder", login), /codex login/);
});
